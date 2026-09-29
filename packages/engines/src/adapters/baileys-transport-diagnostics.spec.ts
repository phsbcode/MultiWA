import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeBaileysTransport } from './baileys-transport-diagnostics';

function fixture({ attached = true } = {}) {
  const tls = new EventEmitter();
  const raw = Object.assign(new EventEmitter(), { readyState: 1,
    _socket: attached ? tls : undefined as EventEmitter | undefined,
    _closeFrameReceived: false, _closeFrameSent: false });
  const client = { socket: raw };
  const emit = vi.fn();
  let time = 0;
  const now = () => ++time;
  const summaries = () => emit.mock.calls.map(([event]) => event)
    .filter(event => event.event === 'whatsapp_transport_close');
  const close = async (code = 1000, reason = Buffer.alloc(0)) => {
    raw.readyState = 3;
    tls.emit('close', false);
    raw.emit('close', code, reason);
    await Promise.resolve();
  };
  return { tls, raw, client, emit, now, summaries, close };
}
afterEach(() => vi.useRealTimers());

describe('bounded Baileys transport observer', () => {
  it('observes the installed ws library peer-close arguments on an isolated loopback socket', async () => {
    const { WebSocket, WebSocketServer } = createRequire(require.resolve('@whiskeysockets/baileys'))('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    server.on('connection', (peer: any) => peer.close(1001, 'Going Away'));
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const emit = vi.fn();
    const observer = observeBaileysTransport({ socket }, emit);
    try {
      await new Promise<void>(resolve => socket.once('close', () => resolve()));
      await Promise.resolve();
      const summary = emit.mock.calls.map(([event]) => event)
        .find(event => event.event === 'whatsapp_transport_close');
      expect(summary).toMatchObject({ completion: 'transport_close', localTeardown: null,
        websocket: { closeCode: 1001, closeFrameReceived: true, closeFrameSent: true,
          reason: { classification: 'going_away' } } });
      expect(socket.listenerCount('message')).toBe(0);
    } finally {
      observer.dispose(); socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('captures a peer close, frame flags and actual activity without recording payloads', async () => {
    const f = fixture();
    observeBaileysTransport(f.client, f.emit, f.now);
    f.raw.emit('message', Buffer.from('private message and keys'));
    f.raw.emit('ping', Buffer.from('private ping'));
    f.raw.emit('pong', Buffer.from('private pong'));
    f.raw._closeFrameReceived = true; f.raw._closeFrameSent = true;
    f.tls.emit('end');
    await f.close(1001, Buffer.from('Going Away'));
    expect(f.summaries()).toHaveLength(1);
    expect(f.summaries()[0]).toMatchObject({ schemaVersion: 1, completion: 'transport_close',
      firstTerminalObservation: 'tls_end', localTeardown: null,
      websocket: { closeCode: 1001, closeFrameReceived: true, closeFrameSent: true,
        reason: { classification: 'going_away', byteLength: 10, sha256: null } },
      tls: { observed: true, closeHadError: false }, keepalive: { observed: false } });
    expect(f.summaries()[0].activity.lastMessage.order).toBeLessThan(f.summaries()[0].activity.lastPing.order);
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain('private');
  });

  it('sees an established TLS error before the installed ws-style handler swallows it', async () => {
    const f = fixture();
    f.tls.on('error', () => { f.tls.emit('close', true); f.raw.emit('close', 1006, Buffer.alloc(0)); });
    observeBaileysTransport(f.client, f.emit, f.now);
    f.tls.emit('error', Object.assign(new Error('private TLS message'), {
      code: 'ECONNRESET', syscall: 'read', address: 'private endpoint', key: 'private key' }));
    await Promise.resolve();
    const summary = f.summaries()[0];
    expect(summary).toMatchObject({ firstTerminalObservation: 'tls_error',
      websocket: { closeCode: 1006 }, tls: { closeHadError: true } });
    expect(summary.events.map((e: any) => e.kind)).toEqual(['tls_error', 'tls_close', 'ws_close']);
    expect(summary.events[0].error).toEqual({ code: 'ECONNRESET', syscall: 'read' });
    expect(JSON.stringify(summary)).not.toContain('private');
  });

  it('records a local intent before teardown, but never reclassifies subsequent cleanup', async () => {
    const local = fixture(); const observer = observeBaileysTransport(local.client, local.emit, local.now);
    observer.localTeardown('adapter_destroy');
    local.raw.readyState = 2;
    observer.localTeardown('manual_logout');
    await local.close();
    expect(local.summaries()[0]).toMatchObject({ firstTerminalObservation: 'local_teardown',
      localTeardown: { intent: 'adapter_destroy' } });
    expect(local.summaries()[0].localTeardown.order).toBeLessThan(local.summaries()[0].events[0].order);

    const remote = fixture(); const other = observeBaileysTransport(remote.client, remote.emit, remote.now);
    remote.raw.on('close', () => other.localTeardown('adapter_destroy'));
    await remote.close();
    expect(remote.summaries()[0].localTeardown).toBeNull();
    expect(remote.summaries()[0].firstTerminalObservation).toBe('tls_close');
  });

  it('does not infer local initiation when ws is already closing before a callback', async () => {
    const f = fixture(); const observer = observeBaileysTransport(f.client, f.emit);
    f.raw.readyState = 2; observer.localTeardown('adapter_destroy');
    await f.close();
    expect(f.summaries()[0]).toMatchObject({ localTeardown: null, firstTerminalObservation: 'already_closing' });
  });

  it.each(['secret-token@example.test', '__proto__', 'constructor', 'x'.repeat(10000)])(
    'hashes unknown reason bytes without retaining arbitrary text', async reason => {
      const f = fixture(); observeBaileysTransport(f.client, f.emit);
      await f.close(4000, Buffer.from(reason));
      expect(f.summaries()[0].websocket.reason).toEqual({ classification: 'unknown',
        byteLength: Buffer.byteLength(reason), hashedBytes: Math.min(Buffer.byteLength(reason), 4096),
        sha256: createHash('sha256').update(Buffer.from(reason).subarray(0, 4096)).digest('hex') });
      expect(JSON.stringify(f.summaries())).not.toContain(reason);
    },
  );

  it('emits once for duplicate closes and detaches only its own listeners', async () => {
    const f = fixture(); const original = vi.fn();
    f.raw.on('close', original); f.tls.on('error', original);
    const observer = observeBaileysTransport(f.client, f.emit);
    expect(observeBaileysTransport(f.client, f.emit)).toBe(observer);
    await f.close(); f.raw.emit('close', 4000, Buffer.from('secret'));
    observer.dispose(); observer.localTeardown('adapter_destroy');
    expect(f.summaries()).toHaveLength(1);
    expect(f.raw.listeners('close')).toEqual([original]);
    expect(f.tls.listeners('error')).toEqual([original]);
    expect(f.raw.listenerCount('message')).toBe(0);
    expect(f.tls.listenerCount('end')).toBe(0);
    expect(f.tls.listenerCount('close')).toBe(0);
  });

  it('attaches TLS listeners on open and removes them on socket replacement', async () => {
    const first = fixture({ attached: false });
    const observer = observeBaileysTransport(first.client, first.emit);
    expect(first.tls.listenerCount('error')).toBe(0);
    first.raw._socket = first.tls; first.raw.emit('open'); first.raw.emit('open');
    expect(first.tls.listenerCount('error')).toBe(1);
    observer.dispose();
    expect(first.summaries()[0].completion).toBe('observer_disposed');
    expect(first.raw.eventNames()).toEqual([]); expect(first.tls.eventNames()).toEqual([]);
    const second = fixture(); observeBaileysTransport(second.client, second.emit);
    await second.close();
    expect(first.summaries()[0].generation).not.toBe(second.summaries()[0].generation);
  });

  it('bounds metadata and removes listeners if a terminating socket never closes', () => {
    vi.useFakeTimers();
    const f = fixture(); const observer = observeBaileysTransport(f.client, f.emit);
    observer.localTeardown('auth_storage_failure');
    for (let i = 0; i < 100; i++) f.tls.emit('error', { code: 'private error', syscall: 'private syscall' });
    vi.advanceTimersByTime(35000);
    expect(f.summaries()[0]).toMatchObject({ completion: 'close_not_observed', websocket: { closeCode: null } });
    expect(f.summaries()[0].events).toHaveLength(12);
    expect(f.summaries()[0].droppedEvents).toBe(89);
    expect(f.tls.eventNames()).toEqual([]); expect(f.raw.eventNames()).toEqual([]);
    expect(JSON.stringify(f.summaries())).not.toContain('private');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unavailable internals honestly and tolerates a failed log sink', () => {
    const emit = vi.fn(); const observer = observeBaileysTransport({}, emit);
    observer.providerClosed(); observer.localTeardown('adapter_destroy'); observer.dispose();
    expect(emit.mock.calls.at(-1)![0]).toMatchObject({ localTeardown: null,
      websocket: { observed: false, closeCode: null, closeFrameReceived: null }, tls: { observed: false } });
    const f = fixture(); const broken = observeBaileysTransport(f.client, () => { throw Error('logger'); });
    expect(() => broken.dispose()).not.toThrow();
    expect(f.raw.eventNames()).toEqual([]);
  });
});
