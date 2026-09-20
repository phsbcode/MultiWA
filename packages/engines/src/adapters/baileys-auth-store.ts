import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto, type AuthenticationState } from '@whiskeysockets/baileys';
import type { EngineAuthStore } from '../types';

/** A profile-scoped durable store. Legacy session files are read, never rewritten. */
export async function createBaileysAuthState(store: EngineAuthStore, legacyDirectory: string) {
  const decode = (text: string) => JSON.parse(text, BufferJSON.reviver);
  const legacy = async (filename: string) => {
    try { return decode(await readFile(join(legacyDirectory, filename), 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const serialized = await store.read();
  let document = serialized ? decode(serialized) : undefined;
  if (serialized && (!document || document.format !== 'baileys-auth-v1')) {
    throw new Error('Unrecognized persisted Baileys authentication format');
  }
  if (!document) {
    document = { format: 'baileys-auth-v1', creds: await legacy('creds.json') || initAuthCreds(), keys: {} };
    await store.write(JSON.stringify(document, BufferJSON.replacer));
  }
  if (!document.creds || !document.keys) throw new Error('Incomplete Baileys authentication state');
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(document, BufferJSON.replacer);
    // A failed write poisons the queue: never keep connecting with unpersisted keys.
    writes = writes.then(() => store.write(snapshot));
    return writes;
  };
  const state: AuthenticationState = {
    creds: document.creds,
    keys: {
      async get(type, ids) {
        const result: Record<string, any> = {};
        let imported = false;
        for (const id of ids) {
          const name = `${type}-${id}`;
          if (!Object.prototype.hasOwnProperty.call(document.keys, name)) {
            const value = await legacy(`${name.replace(/\//g, '__').replace(/:/g, '-')}.json`);
            if (!Object.prototype.hasOwnProperty.call(document.keys, name)) {
              document.keys[name] = value ?? null;
              imported = true;
            }
          }
          let value = document.keys[name];
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          result[id] = value;
        }
        if (imported) await persist();
        else await writes;
        return result;
      },
      async set(data) {
        for (const [type, values] of Object.entries(data)) {
          for (const [id, value] of Object.entries(values || {})) document.keys[`${type}-${id}`] = value ?? null;
        }
        await persist();
      },
    },
  };
  return { state, saveCreds: persist, flush: () => writes };
}
