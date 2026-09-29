import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportRecovery, RECOVERY_SETTLE_MS, RECOVERY_STABLE_MS, classifyRecoveryFailure } from './transport-recovery';
import { initialRecoveryState, RecoveryState } from './transport-recovery-journal';

function fixture(initial = initialRecoveryState()) {
  let disk: RecoveryState = structuredClone(initial);
  const storage = { failRead: false, failWrite: false };
  let connected = false;
  const journal = {
    read: vi.fn(async () => { if (storage.failRead) throw Error('read failed'); return structuredClone(disk); }),
    write: vi.fn(async (state: RecoveryState) => {
      if (storage.failWrite) throw Error('disk full');
      disk = structuredClone(state);
    }),
  };
  const hooks = {
    hasRetainedIdentity: vi.fn(async () => true),
    connect: vi.fn(async (_attempt: { token: number; allowPairing: boolean }) => {}),
    stop: vi.fn(async () => { connected = false; }),
    disconnected: vi.fn(async (_reason: string | null) => {}),
    isReady: () => connected,
  };
  const recovery = new TransportRecovery(journal, hooks);
  const attempt = () => hooks.connect.mock.calls.at(-1)![0];
  const ready = async () => { connected = true; return recovery.ready(attempt().token, async () => {}); };
  const drop = (reason = 'Connection Closed') => recovery.disconnected(attempt().token, reason);
  return { recovery, hooks, journal, storage, attempt, ready, drop, saved: () => structuredClone(disk) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('durable bounded transport recovery', () => {
  it('reserves only three retries and does not reset the budget on brief ready events', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready();
    let firstGap: string | null = null;
    for (const [index, delay] of [15000, 60000, 180000].entries()) {
      await f.drop();
      firstGap ||= (await f.recovery.publicStatus()).firstGapAt;
      expect((await f.recovery.policyStatus()).phase).toBe('retry_wait');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.hooks.connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.saved().attemptsUsed).toBe(index + 1);
      expect(f.saved().phase).toBe('connecting');
      await f.ready(); await vi.advanceTimersByTimeAsync(1000);
      expect((await f.recovery.publicStatus()).firstGapAt).toBe(firstGap);
      expect((await f.recovery.publicStatus()).settledAt).toBeNull();
    }
    await f.drop();
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'RETRIES_EXHAUSTED', attemptsUsed: 3 });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.hooks.connect).toHaveBeenCalledTimes(4);
    const restarted = new TransportRecovery(f.journal, f.hooks); await restarted.startup();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.hooks.connect).toHaveBeenCalledTimes(4);
  });

  it('settles at30 seconds but resets budget only after10 continuous ready minutes', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready(); await f.drop();
    await vi.advanceTimersByTimeAsync(15000); await f.ready();
    const first = (await f.recovery.publicStatus()).firstGapAt;
    await vi.advanceTimersByTimeAsync(RECOVERY_SETTLE_MS - 1);
    expect((await f.recovery.publicStatus()).settledAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect((await f.recovery.publicStatus()).settledAt).not.toBeNull();
    expect(f.saved().attemptsUsed).toBe(1);
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS - RECOVERY_SETTLE_MS - 1);
    expect(f.saved().attemptsUsed).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.saved()).toMatchObject({ phase: 'connected', attemptsUsed: 0 });
    expect((await f.recovery.publicStatus()).firstGapAt).toBe(first);
    const revision = f.saved().revision; await f.recovery.publicStatus();
    expect(f.saved().revision).toBe(revision);
  });

  it('opens a separate frequency circuit across otherwise stable connections', async () => {
    const f = fixture(); await f.recovery.explicitConnect();
    for (let i = 0; i < 4; i++) {
      await f.ready(); await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
      expect(f.saved().attemptsUsed).toBe(0);
      await f.drop();
      if (i < 3) await vi.advanceTimersByTimeAsync(15000);
    }
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'FREQUENT_DISCONNECTS', attemptsUsed: 0 });
    expect(f.saved().disconnects).toHaveLength(4);
    expect(f.hooks.disconnected.mock.calls.filter(([reason]) => reason === 'FREQUENT_DISCONNECTS')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600000); expect(f.hooks.connect).toHaveBeenCalledTimes(4);
  });

  it.each(['Forbidden', 'Logged Out', 'Connection Replaced', 'Reachout Timelock', 'Bad Session',
    'Auth Storage Unavailable', 'Multidevice Mismatch', 'unrecognized provider failure'])(
    'never retries terminal/unknown failure: %s', async reason => {
      const f = fixture(); await f.recovery.explicitConnect(); await f.drop(reason);
      expect(f.saved().phase).toBe('paused');
      await vi.advanceTimersByTimeAsync(3600000); expect(f.hooks.connect).toHaveBeenCalledOnce();
      const restarted = new TransportRecovery(f.journal, f.hooks); await restarted.startup();
      await vi.advanceTimersByTimeAsync(3600000); expect(f.hooks.connect).toHaveBeenCalledOnce();
    },
  );

  it('persists manual pause during backoff and blocks stale ready callbacks across restart', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); const old = f.attempt(); await f.drop();
    await f.recovery.pause('MANUAL_PAUSE');
    expect(await f.recovery.ready(old.token, async () => {})).toBe(false);
    await vi.advanceTimersByTimeAsync(3600000);
    const restarted = new TransportRecovery(f.journal, f.hooks); await restarted.startup();
    expect(f.saved().pauseReason).toBe('MANUAL_PAUSE'); expect(f.hooks.connect).toHaveBeenCalledOnce();
  });

  it('preserves a manual pause while a ready DB write is still pending', async () => {
    const f = fixture(); await f.recovery.explicitConnect();
    let release!: () => void; const database = new Promise<void>(resolve => { release = resolve; });
    const ready = f.recovery.ready(f.attempt().token, () => database);
    await f.recovery.publicStatus();
    await f.recovery.pause('MANUAL_PAUSE');
    release(); expect(await ready).toBe(false);
    await vi.advanceTimersByTimeAsync(RECOVERY_STABLE_MS);
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'MANUAL_PAUSE', settledAt: null });
  });

  it('writes the gap before waiting for engine/auth cleanup and cancels a delayed retry on pause', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready();
    let release!: () => void;
    f.hooks.stop.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const drop = f.drop();
    expect((await f.recovery.publicStatus()).firstGapAt).not.toBeNull();
    await f.recovery.pause('MANUAL_PAUSE'); release(); await drop;
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.saved().pauseReason).toBe('MANUAL_PAUSE'); expect(f.hooks.connect).toHaveBeenCalledOnce();
  });

  it('keeps gap markers when DB writes fail and stops automatic recovery', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready();
    f.hooks.disconnected.mockRejectedValue(Error('database unavailable'));
    await f.drop();
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'AUTH_STORAGE_UNAVAILABLE' });
    expect((await f.recovery.publicStatus()).firstGapAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3600000); expect(f.hooks.connect).toHaveBeenCalledOnce();
  });

  it.each(['MANUAL_PAUSE', 'RETRIES_EXHAUSTED', 'FREQUENT_DISCONNECTS', 'FORBIDDEN'] as const)(
    'a later storage outage does not overwrite durable %s intent', async reason => {
      const f = fixture({ ...initialRecoveryState(), pauseReason: reason });
      await f.recovery.storageStop();
      expect(f.saved().pauseReason).toBe(reason);
      expect(f.hooks.connect).not.toHaveBeenCalled();
    },
  );

  it('fails closed after an unpersistable pause and reconstructs a conservative gap floor', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready();
    const floor = f.saved().attemptStartedAt;
    await vi.advanceTimersByTimeAsync(1000); f.storage.failWrite = true;
    await expect(f.recovery.pause('MANUAL_PAUSE')).rejects.toThrow();
    expect((await f.recovery.publicStatus()).persistence).toBe('degraded');
    f.storage.failWrite = false;
    const restarted = new TransportRecovery(f.journal, f.hooks); await restarted.startup();
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'UNCLEAN_RESTART', firstGapAt: floor,
      gapAccuracy: 'conservative' });
    await vi.advanceTimersByTimeAsync(3600000); expect(f.hooks.connect).toHaveBeenCalledOnce();
  });

  it('graceful restart preserves the remaining budget and cannot replay startup intent twice', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.drop();
    await vi.advanceTimersByTimeAsync(15000); await f.ready();
    await f.recovery.shutdown(); expect(f.saved().resumeOnStartup).toBe(false);
    await f.recovery.completeShutdown(); expect(f.saved().resumeOnStartup).toBe(true);
    const next = new TransportRecovery(f.journal, f.hooks); await next.startup();
    expect(f.saved().resumeOnStartup).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.saved().attemptsUsed).toBe(2); expect(f.hooks.connect).toHaveBeenCalledTimes(3);
    const crash = new TransportRecovery(f.journal, f.hooks); await crash.startup();
    expect(f.saved().pauseReason).toBe('UNCLEAN_RESTART');
  });

  it('does not let final shutdown checkpoint override a manual pause during HTTP draining', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.ready();
    await f.recovery.shutdown(); await f.recovery.pause('MANUAL_PAUSE');
    await f.recovery.completeShutdown();
    expect(f.saved()).toMatchObject({ phase: 'paused', pauseReason: 'MANUAL_PAUSE', resumeOnStartup: false });
  });

  it('does not launch a socket with missing retained identity or permit automatic QR', async () => {
    const f = fixture(); await f.recovery.explicitConnect(); await f.drop();
    f.hooks.hasRetainedIdentity.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.saved().pauseReason).toBe('PAIRING_REQUIRED'); expect(f.hooks.connect).toHaveBeenCalledOnce();
    const g = fixture(); await g.recovery.explicitConnect(); await g.drop();
    await vi.advanceTimersByTimeAsync(15000);
    expect(g.attempt().allowPairing).toBe(false);
    expect(await g.recovery.qr(g.attempt())).toBe(false);
    expect(g.saved().pauseReason).toBe('PAIRING_REQUIRED');
  });

  it('permits exactly one legitimate post-QR515 and refuses515 after ready', async () => {
    const f = fixture(); await f.recovery.explicitConnect(true);
    expect(await f.recovery.qr(f.attempt())).toBe(true);
    await f.drop('Restart Required'); expect(f.hooks.connect).toHaveBeenCalledTimes(2);
    expect(f.saved().pairingRestartUsed).toBe(true);
    await f.drop('Restart Required'); expect(f.saved().pauseReason).toBe('BAD_SESSION');
    const g = fixture(); await g.recovery.explicitConnect(true); await g.recovery.qr(g.attempt()); await g.ready();
    await g.drop('Restart Required'); expect(g.hooks.connect).toHaveBeenCalledOnce();
  });

  it('does not overwrite an unreadable journal or create overlapping explicit attempts', async () => {
    const f = fixture(); f.storage.failRead = true;
    await expect(f.recovery.explicitConnect()).rejects.toThrow('cannot be read');
    expect(f.journal.write).not.toHaveBeenCalled(); expect(f.hooks.connect).not.toHaveBeenCalled();
    const g = fixture(); await Promise.all([g.recovery.explicitConnect(), g.recovery.explicitConnect()]);
    expect(g.hooks.connect).toHaveBeenCalledOnce();
  });
});

it('classifies only known transport reasons as retryable', () => {
  expect(classifyRecoveryFailure('Connection Terminated')).toBe('transport');
  expect(classifyRecoveryFailure('Connection Lost')).toBe('transport');
  expect(classifyRecoveryFailure('Connection Failure')).toBe('UNKNOWN_FAILURE');
  expect(classifyRecoveryFailure('Forbidden 403')).toBe('FORBIDDEN');
});
