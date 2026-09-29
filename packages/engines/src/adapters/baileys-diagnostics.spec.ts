import { it, expect, vi, afterEach } from 'vitest';
import { disconnectDiagnostic, diagnosticAuthStore } from './baileys-diagnostics';
import { BaileysAdapter } from './baileys.adapter';

afterEach(() => vi.restoreAllMocks());
it('retains only allowlisted disconnect metadata from credential-bearing provider errors', () => {
  const result = disconnectDiagnostic({ output: { statusCode: 401 }, message: 'secret message',
    stack: 'secret stack', data: { tag: 'stream:error', attrs: { code: '401', key: 'secret key' },
      content: [{ tag: 'conflict', attrs: { type: 'device_removed', token: 'secret token' } }] } });
  expect(result).toEqual({ statusCode: 401, providerTag: 'stream:error', providerCode: '401', conflictType: 'device_removed' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(disconnectDiagnostic({ data: { tag: 'private-value', attrs: { code: 'private-value' } } }))
    .toEqual({ statusCode: null, providerTag: null, providerCode: null, conflictType: null });
});
it('reports failed storage reads and writes without copying credentials and rethrows the original error', async () => {
  const emit = vi.fn(), failure = new Error('No space left on device: secret credentials');
  const store = diagnosticAuthStore({ read: async () => { throw failure; }, write: async () => { throw failure; } }, emit);
  await expect(store.read()).rejects.toBe(failure);
  await expect(store.write('secret auth document')).rejects.toBe(failure);
  expect(emit.mock.calls.map(([value]) => value)).toEqual([
    { event: 'auth_storage_failure', operation: 'read', storageCode: 'ENOSPC' },
    { event: 'auth_storage_failure', operation: 'write', storageCode: 'ENOSPC' },
  ]);
});
it('a failing diagnostic sink cannot mask the original storage failure', async () => {
  const error = Error('original');
  const store = diagnosticAuthStore({ read: async () => { throw error; }, write: async () => {} }, () => { throw Error('logger'); });
  await expect(store.read()).rejects.toBe(error);
});
it('active timelock stops an investigation socket without logging raw provider data', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const adapter = new BaileysAdapter() as any, handlers: Record<string, Function> = {};
  adapter.config = { profileId: 'synthetic', investigationMode: true, onDisconnected: vi.fn() };
  adapter.socket = { ev: { on: (name: string, fn: Function) => { handlers[name] = fn; } } };
  const destroy = vi.spyOn(adapter, 'destroy').mockResolvedValue(undefined);
  adapter.setupEventHandlers();
  await handlers['connection.update']({ reachoutTimeLock: { isActive: true,
    enforcementType: 'WEB_COMPANION_ONLY', rawToken: 'secret' } });
  expect(destroy).toHaveBeenCalledOnce();
  expect(adapter.config.onDisconnected).toHaveBeenCalledWith('Reachout Timelock');
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
});
it('automatic recovery stops an unexpected QR without caching or emitting it', async () => {
  const adapter = new BaileysAdapter() as any, handlers: Record<string, Function> = {};
  adapter.config = { profileId: 'synthetic', allowPairing: false, onDisconnected: vi.fn(), onQR: vi.fn() };
  adapter.qrCallbacks = [vi.fn()];
  adapter.socket = { ev: { on: (name: string, fn: Function) => { handlers[name] = fn; } } };
  vi.spyOn(adapter, 'destroy').mockResolvedValue(undefined);
  adapter.setupEventHandlers();
  await handlers['connection.update']({ qr: 'synthetic-private-QR' });
  expect(adapter.config.onDisconnected).toHaveBeenCalledWith('Pairing Required');
  expect(adapter.config.onQR).not.toHaveBeenCalled();
  expect(adapter.qrCallbacks[0]).not.toHaveBeenCalled();
  expect(adapter.currentQR).toBeNull();
});
