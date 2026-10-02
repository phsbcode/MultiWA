import { initialRecoveryState, RecoveryJournal, RecoveryPause, RecoveryState } from './transport-recovery-journal';

export const TRANSPORT_BACKOFF_MS = [15000, 60000, 180000] as const;
export const RECOVERY_SETTLE_MS = 30000;
export const RECOVERY_STABLE_MS = 600000;
export const RECOVERY_FREQUENCY_WINDOW_MS = 3600000;
export const RECOVERY_FREQUENCY_LIMIT = 4;
export interface RecoveryAttempt { token: number; allowPairing: boolean }
export interface RecoveryHooks {
  hasRetainedIdentity(): Promise<boolean>;
  connect(attempt: RecoveryAttempt): Promise<void>;
  stop(): Promise<void>;
  disconnected(reason: RecoveryPause | null): Promise<void>;
  isReady(): boolean;
}
export function classifyRecoveryFailure(reason: string): RecoveryPause | 'transport' | 'pairing_restart' {
  if (/Reachout Timelock/i.test(reason)) return 'REACHOUT_TIMELOCK';
  if (/Forbidden|\b403\b/i.test(reason)) return 'FORBIDDEN';
  if (/Logged Out|loggedOut|\b401\b/i.test(reason)) return 'LOGGED_OUT';
  if (/Connection Replaced|\b440\b/i.test(reason)) return 'CONNECTION_REPLACED';
  if (/Multidevice Mismatch|\b411\b/i.test(reason)) return 'MULTIDEVICE_MISMATCH';
  if (/Auth Storage Unavailable/i.test(reason)) return 'AUTH_STORAGE_UNAVAILABLE';
  if (reason === 'Pairing Required') return 'PAIRING_REQUIRED';
  if (/Bad Session|Session Expired|invalid.*auth|credential/i.test(reason)) return 'BAD_SESSION';
  if (reason === 'Restart Required') return 'pairing_restart';
  if (reason === 'Provider Service Unavailable (503)') return 'transport';
  return /^(Connection Terminated|Connection closed|Connection Closed|Connection was lost|Connection Lost|Timed Out|Connect Timeout|WebSocket Error \((ECONNRESET|ETIMEDOUT|EPIPE)\))$/.test(reason)
    ? 'transport' : 'UNKNOWN_FAILURE';
}

/** Scoped retained-credential recovery. Durable reservations precede every socket. */
export class TransportRecovery {
  private state = initialRecoveryState();
  private loaded: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private token = 0;
  private active = false;
  private durable = true;
  private readFailed = false;
  private explicitPending: Promise<void> | null = null;
  private shuttingDown = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly journal: RecoveryJournal, private readonly hooks: RecoveryHooks) {}
  private async load() {
    this.loaded ??= this.journal.read().then(value => { if (value) this.state = value; })
      .catch(() => {
        this.durable = false;
        this.readFailed = true;
        this.state.pauseReason = 'AUTH_STORAGE_UNAVAILABLE';
      });
    await this.loaded;
  }
  private now() { return new Date().toISOString(); }
  private cancel() {
    this.token++;
    this.active = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  private schedule(ms: number, fn: () => Promise<unknown>) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void fn().catch(() => this.storageStop());
    }, Math.max(0, ms));
    timer.unref?.(); this.timers.add(timer);
  }
  private async change(fn: (state: RecoveryState) => boolean | void) {
    const operation = this.writes.then(async () => {
      await this.load();
      if (this.readFailed) throw Error('Recovery journal cannot be read');
      const next = { ...this.state };
      if (fn(next) === false) return;
      next.revision++;
      this.state = next;
      try { await this.journal.write(next); this.durable = true; }
      catch {
        this.durable = false; this.cancel();
        this.state = { ...next, phase: 'paused', pauseReason: 'AUTH_STORAGE_UNAVAILABLE', resumeOnStartup: false };
        throw Error('Recovery journal unavailable');
      }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  private gap(s: RecoveryState, at = this.now(), accuracy: 'observed' | 'conservative' = 'observed') {
    if (!s.firstGapAt || at < s.firstGapAt) { s.firstGapAt = at; s.gapAccuracy = accuracy; }
    if (accuracy === 'conservative') s.gapAccuracy = 'conservative';
    s.lastDisconnectedAt = at;
    s.settledAt = null; s.stableAt = null;
  }
  isCurrent(token: number) { return this.active && token === this.token && this.state.phase !== 'paused'; }
  async publicStatus() {
    await this.load(); await this.writes;
    const s = this.state;
    return { version: 1 as const, firstGapAt: s.firstGapAt, lastDisconnectedAt: s.lastDisconnectedAt,
      lastConnectedAt: s.lastConnectedAt, revision: s.revision, settledAt: s.settledAt,
      gapAccuracy: s.gapAccuracy, persistence: this.durable ? 'durable' as const : 'degraded' as const };
  }
  async policyStatus() { await this.load(); await this.writes; return { ...this.state }; }

  async startup() {
    await this.load();
    if (!this.durable) return;
    if (this.state.phase === 'paused') return;
    if (!this.state.resumeOnStartup) {
      await this.pause('UNCLEAN_RESTART', this.state.attemptStartedAt || this.state.lastConnectedAt || this.now(), 'conservative');
      return;
    }
    await this.change(s => { s.resumeOnStartup = false; });
    this.scheduleRetry();
  }
  explicitConnect(allowPairing = false): Promise<void> {
    if (!this.explicitPending) {
      const requestToken = this.token;
      this.explicitPending = this.beginExplicitConnect(requestToken, allowPairing)
        .finally(() => { this.explicitPending = null; });
    }
    return this.explicitPending;
  }
  private async beginExplicitConnect(requestToken: number, allowPairing: boolean) {
    await this.load();
    if (this.readFailed) throw Error('Recovery journal cannot be read');
    if (this.active || this.shuttingDown || requestToken !== this.token) return;
    this.cancel();
    const token = this.token;
    await this.change(s => {
      if (token !== this.token) return false;
      s.phase = 'retry_wait'; s.pauseReason = null; s.attemptsUsed = 0;
      s.pairingRestartUsed = false; s.qrIssued = false; s.resumeOnStartup = false;
    });
    if (token !== this.token) return;
    await this.launch('explicit', allowPairing);
  }
  private async launch(kind: 'explicit' | 'retry' | 'pairing', allowPairing = false) {
    const token = ++this.token;
    if (!allowPairing) {
      let retainedIdentity = false;
      try { retainedIdentity = await this.hooks.hasRetainedIdentity(); }
      catch { await this.storageStop(); return; }
      if (token !== this.token) return;
      if (!retainedIdentity) { await this.pause('PAIRING_REQUIRED'); return; }
    }
    if (kind === 'retry' && this.state.attemptsUsed >= 3) { await this.pause('RETRIES_EXHAUSTED'); return; }
    await this.change(s => {
      if (token !== this.token) return false;
      if (kind === 'retry') s.attemptsUsed++;
      s.phase = 'connecting'; s.pauseReason = null; s.nextRetryAt = null;
      s.attemptStartedAt = this.now(); s.settledAt = null; s.resumeOnStartup = false;
    });
    if (token !== this.token) return;
    this.active = true;
    try { await this.hooks.connect({ token, allowPairing }); }
    catch { if (this.isCurrent(token)) await this.pause('AUTH_STORAGE_UNAVAILABLE'); }
    if (this.isCurrent(token)) this.schedule(60000, async () => {
      if (this.isCurrent(token) && this.state.phase === 'connecting') await this.disconnected(token, 'Connect Timeout');
    });
  }
  async qr(attempt: RecoveryAttempt): Promise<boolean> {
    if (!this.isCurrent(attempt.token)) return false;
    if (!attempt.allowPairing) { await this.pause('PAIRING_REQUIRED'); return false; }
    await this.change(s => {
      if (!this.isCurrent(attempt.token)) return false;
      s.qrIssued = true;
    });
    return this.isCurrent(attempt.token);
  }
  async ready(token: number, persistReady: (at: string) => Promise<void>): Promise<boolean> {
    if (!this.isCurrent(token) || this.state.phase !== 'connecting') return false;
    const at = this.now();
    await this.change(s => {
      if (!this.isCurrent(token)) return false;
      s.phase = 'stabilizing'; s.lastConnectedAt = at; s.settledAt = null; s.stableAt = null; s.qrIssued = false;
    });
    if (!this.isCurrent(token)) return false;
    try { await persistReady(at); } catch { await this.storageStop(); return false; }
    if (!this.isCurrent(token)) return false;
    this.schedule(RECOVERY_SETTLE_MS, async () => {
      if (this.isCurrent(token) && this.hooks.isReady()) await this.change(s => {
        if (!this.isCurrent(token) || !this.hooks.isReady()) return false;
        s.settledAt = this.now();
      });
    });
    this.schedule(RECOVERY_STABLE_MS, async () => {
      if (this.isCurrent(token) && this.hooks.isReady()) await this.change(s => {
        if (!this.isCurrent(token) || !this.hooks.isReady()) return false;
        s.phase = 'connected'; s.stableAt = this.now(); s.attemptsUsed = 0;
      });
    });
    return true;
  }
  async disconnected(token: number, reason: string) {
    if (!this.isCurrent(token)) return;
    const lostAt = this.now();
    const category = classifyRecoveryFailure(reason);
    const pairing = category === 'pairing_restart' && this.state.qrIssued && !this.state.pairingRestartUsed;
    if (!pairing && category !== 'transport') {
      await this.pause(category === 'pairing_restart' ? 'BAD_SESSION' : category, lostAt);
      return;
    }
    this.cancel();
    const operationToken = this.token;
    const stop = this.hooks.stop().then(() => true, () => false);
    if (pairing) {
      await this.change(s => {
        if (operationToken !== this.token) return false;
        s.pairingRestartUsed = true; s.qrIssued = false;
      });
      if (!await stop) { await this.pause('UNKNOWN_FAILURE', lostAt); return; }
      if (operationToken !== this.token) return;
      await this.launch('pairing'); return;
    }
    await this.change(s => {
      if (operationToken !== this.token) return false;
      this.gap(s, lostAt); s.phase = 'retry_wait'; s.pauseReason = null;
      s.disconnects = [...s.disconnects.filter(at => Date.parse(at) >= Date.parse(lostAt) - RECOVERY_FREQUENCY_WINDOW_MS), lostAt]
        .slice(-RECOVERY_FREQUENCY_LIMIT);
      s.nextRetryAt = new Date(Date.now() + (TRANSPORT_BACKOFF_MS[s.attemptsUsed] || 0)).toISOString();
    });
    if (!await stop) { await this.pause('UNKNOWN_FAILURE', lostAt); return; }
    if (operationToken !== this.token) return;
    try { await this.hooks.disconnected(null); } catch { await this.storageStop(); return; }
    if (operationToken !== this.token) return;
    if (this.state.attemptsUsed >= 3) { await this.pause('RETRIES_EXHAUSTED'); return; }
    if (this.state.disconnects.length >= RECOVERY_FREQUENCY_LIMIT) {
      await this.pause('FREQUENT_DISCONNECTS', lostAt); return;
    }
    this.scheduleRetry();
  }
  private scheduleRetry() {
    const token = this.token;
    this.schedule(Math.max(0, Date.parse(this.state.nextRetryAt || this.now()) - Date.now()), async () => {
      if (token === this.token && this.state.phase === 'retry_wait') await this.launch('retry');
    });
  }
  async pause(reason: RecoveryPause, gapAt?: string, accuracy: 'observed' | 'conservative' = 'observed') {
    this.cancel();
    const stop = this.hooks.stop().catch(() => {});
    try {
      await this.change(s => {
        this.gap(s, gapAt || this.now(), accuracy);
        s.phase = 'paused'; s.pauseReason = reason; s.nextRetryAt = null; s.resumeOnStartup = false;
      });
    } finally { await stop; }
    try { await this.hooks.disconnected(reason); }
    catch { /* The journal retains the original manual/restriction/exhaustion intent. */ }
  }
  async storageStop() {
    await this.load();
    if (this.durable && this.state.phase === 'paused' && this.state.pauseReason !== 'UNINITIALIZED') {
      // A database outage must not erase an already durable manual/restriction/circuit stop.
      this.cancel();
      await this.hooks.stop().catch(() => {});
      return;
    }
    try { await this.pause('AUTH_STORAGE_UNAVAILABLE'); }
    catch { this.cancel(); await this.hooks.stop().catch(() => {}); }
  }
  async shutdown() {
    this.shuttingDown = true;
    this.cancel(); await this.hooks.stop();
    if (!this.durable || this.state.phase === 'paused') return;
    await this.change(s => {
      if (s.phase === 'paused' || !this.durable) return false;
      if (s.phase !== 'retry_wait') this.gap(s);
      s.phase = 'retry_wait'; s.pauseReason = null; s.settledAt = null;
      s.nextRetryAt ||= new Date(Date.now() + TRANSPORT_BACKOFF_MS[0]).toISOString();
      s.resumeOnStartup = false;
    });
  }
  /** Called only after Nest has closed the HTTP server and drained requests. */
  async completeShutdown() {
    if (!this.shuttingDown || !this.durable) return;
    await this.change(s => {
      if (s.phase !== 'retry_wait' || !this.durable) return false;
      s.resumeOnStartup = true;
    });
  }
}
