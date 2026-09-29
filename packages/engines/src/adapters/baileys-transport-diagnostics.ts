import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

type Emitter = EventEmitter & Record<string, unknown>;
type Stamp = { order: number; elapsedMs: number };
export type TeardownIntent = 'adapter_destroy' | 'manual_logout' | 'auth_storage_failure' | 'reachout_timelock';
export interface TransportObserver {
  localTeardown(intent: TeardownIntent): void;
  providerClosed(): void;
  dispose(): void;
}

const observers = new WeakMap<EventEmitter, TransportObserver>();
const errorCodes = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTCONN',
  'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING', 'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
const syscalls = new Set(['read', 'write', 'connect', 'shutdown', 'getaddrinfo']);
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function emitter(value: unknown): Emitter | undefined {
  const item = object(value);
  return typeof item.prependListener === 'function' && typeof item.removeListener === 'function'
    ? value as Emitter : undefined;
}
function errorMetadata(error: unknown) {
  const value = object(error);
  return { code: errorCodes.has(value.code as string) ? value.code : 'UNKNOWN',
    syscall: syscalls.has(value.syscall as string) ? value.syscall : null };
}
function reasonMetadata(reason: unknown) {
  const bytes = Buffer.isBuffer(reason) ? reason : typeof reason === 'string'
    ? Buffer.from(reason.slice(0, 4096)) : null;
  if (!bytes) return { classification: 'unavailable', byteLength: null, sha256: null, hashedBytes: 0 };
  const byteLength = typeof reason === 'string' ? Buffer.byteLength(reason) : bytes.length;
  const known: Record<string, string> = { '': 'empty', 'normal closure': 'normal_closure',
    'going away': 'going_away', 'service restart': 'service_restart' };
  const text = byteLength <= 123 ? bytes.toString('utf8').toLowerCase() : '';
  const classification = byteLength <= 123 && Object.prototype.hasOwnProperty.call(known, text) ? known[text] : undefined;
  const bounded = bytes.subarray(0, 4096);
  return { classification: classification || 'unknown', byteLength,
    sha256: classification ? null : createHash('sha256').update(bounded).digest('hex'),
    hashedBytes: classification ? 0 : bounded.length };
}

/** Metadata only. Private ws fields are guarded and unavailable values remain null. */
export function observeBaileysTransport(client: unknown, emit: (event: object) => void,
  now: () => number = () => performance.now()): TransportObserver {
  const raw = emitter(object(client).socket);
  if (raw && observers.has(raw)) return observers.get(raw)!;
  const generation = randomUUID();
  const start = now();
  let sequence = 0, finished = false, closeQueued = false, readyEmitted = false, droppedEvents = 0;
  let tls: Emitter | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstTerminal: string | null = null;
  let localIntent: ({ intent: TeardownIntent } & Stamp) | null = null;
  let closeCode: number | null = null;
  let closeReason = reasonMetadata(undefined);
  let tlsHadError: boolean | null = null;
  const events: Array<Stamp & { kind: string; error?: ReturnType<typeof errorMetadata> }> = [];
  const activity: Record<'lastMessage' | 'lastPing' | 'lastPong', Stamp | null> = {
    lastMessage: null, lastPing: null, lastPong: null,
  };
  const listeners: Array<[Emitter, string, (...args: any[]) => void]> = [];
  const stamp = (): Stamp => ({ order: ++sequence, elapsedMs: Math.max(0, Math.round((now() - start) * 1000) / 1000) });
  const safeEmit = (event: object) => { try { emit(event); } catch { /* Diagnostics cannot affect transport. */ } };
  function reportReady() {
    if (readyEmitted || finished) return;
    readyEmitted = true;
    safeEmit({ event: 'whatsapp_transport_observer_ready', schemaVersion: 1, generation,
      websocketObserved: Boolean(raw), tlsObservedAtAttach: Boolean(tls), keepaliveObserved: false });
  }
  function record(kind: string, error?: ReturnType<typeof errorMetadata>) {
    if (finished) return;
    const value = { ...stamp(), kind, ...(error ? { error } : {}) };
    if (events.length < 12) events.push(value); else droppedEvents++;
  }
  function terminal(kind: string) {
    if (finished) return;
    firstTerminal ??= kind;
    if (!timer) {
      // ws normally closes within 30s. Bound listeners even if close never arrives.
      timer = setTimeout(() => finish('close_not_observed'), 35000);
      timer.unref();
    }
  }
  function listen(target: Emitter, event: string, fn: (...args: any[]) => void) {
    target.prependListener(event, fn);
    listeners.push([target, event, fn]);
  }
  function finish(completion: 'transport_close' | 'observer_disposed' | 'close_not_observed') {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    for (const [target, event, fn] of listeners) target.removeListener(event, fn);
    listeners.length = 0;
    if (raw) observers.delete(raw);
    safeEmit({ event: 'whatsapp_transport_close', schemaVersion: 1, generation,
      completion, observedAt: new Date().toISOString(), durationMs: stamp().elapsedMs,
      firstTerminalObservation: firstTerminal, localTeardown: localIntent,
      websocket: { observed: Boolean(raw), closeCode, reason: closeReason,
        closeFrameReceived: typeof raw?._closeFrameReceived === 'boolean' ? raw._closeFrameReceived : null,
        closeFrameSent: typeof raw?._closeFrameSent === 'boolean' ? raw._closeFrameSent : null },
      tls: { observed: Boolean(tls), closeHadError: tlsHadError },
      activity, keepalive: { observed: false }, events, droppedEvents });
  }
  function attachTls() {
    if (finished || tls) return;
    tls = emitter(raw?._socket);
    if (!tls) return;
    // Prepend: ws consumes established TLS errors without forwarding their codes.
    listen(tls, 'error', error => {
      record('tls_error', errorMetadata(error)); terminal('tls_error');
    });
    listen(tls, 'end', () => { record('tls_end'); terminal('tls_end'); });
    listen(tls, 'close', hadError => {
      tlsHadError = typeof hadError === 'boolean' ? hadError : null;
      record('tls_close'); terminal('tls_close');
    });
    reportReady();
  }
  const observer: TransportObserver = {
    localTeardown(intent) {
      if (finished) return;
      // Cleanup after a provider/transport close is not an initiating local close.
      if (firstTerminal || raw?.readyState === 2 || raw?.readyState === 3) {
        record('cleanup_after_terminal'); terminal('already_closing'); return;
      }
      localIntent = { intent, ...stamp() };
      record('local_teardown'); terminal('local_teardown');
    },
    providerClosed() { if (!finished) { record('provider_close'); terminal('provider_close'); } },
    dispose() { finish(closeQueued ? 'transport_close' : 'observer_disposed'); },
  };
  if (raw) {
    observers.set(raw, observer);
    listen(raw, 'open', () => { record('ws_open'); attachTls(); reportReady(); });
    listen(raw, 'error', error => { record('ws_error', errorMetadata(error)); terminal('ws_error'); });
    listen(raw, 'close', (code, reason) => {
      if (finished || closeQueued) return;
      closeQueued = true;
      closeCode = Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null;
      closeReason = reasonMetadata(reason);
      record('ws_close'); terminal('ws_close');
      // Allow TLS close metadata and provider callbacks in the same stack to finish.
      queueMicrotask(() => finish('transport_close'));
    });
    for (const [event, field] of [['message', 'lastMessage'], ['ping', 'lastPing'], ['pong', 'lastPong']] as const) {
      listen(raw, event, () => { if (!finished) activity[field] = stamp(); });
    }
    attachTls();
  }
  if (!raw || raw.readyState === 1) reportReady();
  return observer;
}
