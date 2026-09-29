import type { EngineAuthStore } from '../types';

/** Allowlisted metadata only: never serialize provider errors, nodes, auth, or message bodies. */
export function disconnectDiagnostic(error: any) {
  const status = error?.output?.statusCode;
  const node = error?.data;
  const conflict = Array.isArray(node?.content) ? node.content.find((item: any) => item?.tag === 'conflict') : null;
  const type = conflict?.attrs?.type;
  return {
    statusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    providerTag: ['stream:error', 'failure', 'conflict'].includes(node?.tag) ? node.tag : null,
    providerCode: /^\d{3}$/.test(String(node?.attrs?.code || '')) ? String(node.attrs.code) : null,
    conflictType: ['device_removed', 'replaced'].includes(type) ? type : null,
  };
}

export function storageFailureCode(error: any): string {
  const code = String(error?.code || '');
  if (/^(?:P\d{4}|53100|53200|53300|ENOSPC|EACCES|EROFS|EIO|ECONNREFUSED|ETIMEDOUT)$/.test(code)) return code;
  if (/No space left on device/i.test(String(error?.message || ''))) return 'ENOSPC';
  return 'UNKNOWN';
}

export function diagnosticAuthStore(store: EngineAuthStore, emit: (event: object) => void): EngineAuthStore {
  const report = (operation: string, error: unknown) => {
    try { emit({ event: 'auth_storage_failure', operation, storageCode: storageFailureCode(error) }); }
    catch { /* Logging must not change credential persistence behavior. */ }
  };
  return {
    async read() {
      try { return await store.read(); } catch (error) { report('read', error); throw error; }
    },
    async write(value) {
      try { await store.write(value); } catch (error) { report('write', error); throw error; }
    },
  };
}
