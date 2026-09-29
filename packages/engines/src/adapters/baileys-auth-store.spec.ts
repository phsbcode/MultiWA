import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createBaileysAuthState, hasRetainedBaileysIdentity } from './baileys-auth-store';

describe('durable Baileys auth', () => {
  it('accepts retained QR-linked MD auth with registered=false and never rewrites it on load', async () => {
    const creds = initAuthCreds();
    creds.registered = false;
    creds.me = { id: '15550000000:1@s.whatsapp.net', name: 'Synthetic' };
    const saved = JSON.stringify({ format: 'baileys-auth-v1', creds, keys: {} }, BufferJSON.replacer);
    let writes = 0;
    expect(hasRetainedBaileysIdentity(saved)).toBe(true);
    const recovered = await createBaileysAuthState({ read: async () => saved,
      write: async () => { writes++; } }, '/nonexistent-test-directory', { requireRetainedIdentity: true });
    expect(recovered.state.creds.registered).toBe(false);
    expect(recovered.state.creds.me?.id).toBe(creds.me.id);
    expect(writes).toBe(0);
  });
  it('never initializes or writes fresh credentials during automatic recovery without identity/key material', async () => {
    const creds = initAuthCreds();
    creds.registered = true;
    const missingIdentity = JSON.stringify({ format: 'baileys-auth-v1', creds, keys: {} }, BufferJSON.replacer);
    creds.me = { id: '15550000000:1@s.whatsapp.net', name: 'Synthetic' };
    const missingKeys = JSON.stringify({ format: 'baileys-auth-v1', creds: { ...creds, noiseKey: null }, keys: {} }, BufferJSON.replacer);
    for (const saved of [null, missingIdentity, missingKeys]) {
      let writes = 0;
      expect(hasRetainedBaileysIdentity(saved)).toBe(false);
      await expect(createBaileysAuthState({ read: async () => saved,
        write: async () => { writes++; } }, '/nonexistent-test-directory', { requireRetainedIdentity: true }))
        .rejects.toThrow('Retained credentials required');
      expect(writes).toBe(0);
    }
  });
  it('imports legacy credentials and keys without changing files; deletions survive reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baileys-auth-test-'));
    let saved: string | null = null;
    const store = { read: async () => saved, write: async (value: string) => { saved = value; } };
    try {
      const legacy = JSON.stringify(initAuthCreds(), BufferJSON.replacer);
      await writeFile(join(dir, 'creds.json'), legacy);
      await writeFile(join(dir, 'session-test.json'), JSON.stringify(Buffer.from('synthetic'), BufferJSON.replacer));
      const first = await createBaileysAuthState(store, dir);
      expect((await first.state.keys.get('session', ['test'])).test).toEqual(Buffer.from('synthetic'));
      await first.state.keys.set({ session: { test: null } });
      const second = await createBaileysAuthState(store, dir);
      expect((await second.state.keys.get('session', ['test'])).test).toBeNull();
      expect(await readFile(join(dir, 'creds.json'), 'utf8')).toBe(legacy);
      expect(second.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('serializes concurrent credential and key writes and preserves both on restart', async () => {
    let saved: string | null = null;
    const store = { read: async () => saved, write: async (value: string) => { saved = value; } };
    const first = await createBaileysAuthState(store, '/nonexistent-test-directory');
    first.state.creds.registered = true;
    await Promise.all([first.saveCreds(), first.state.keys.set({ session: { first: Buffer.from('a'), second: Buffer.from('b') } })]);
    const next = await createBaileysAuthState(store, '/nonexistent-test-directory');
    expect(next.state.creds.registered).toBe(true);
    expect((await next.state.keys.get('session', ['first', 'second'])).second).toEqual(Buffer.from('b'));
  });
  it('fails closed on unreadable data or failed persistence', async () => {
    await expect(createBaileysAuthState({ read: async () => 'broken', write: async () => {} }, '/none')).rejects.toThrow();
    await expect(createBaileysAuthState({ read: async () => null, write: async () => { throw Error('database unavailable'); } }, '/none')).rejects.toThrow('database unavailable');
  });
  it('keeps the last durable credentials after disk-full and recovers only with a new auth state', async () => {
    let saved: string | null = null;
    let full = false;
    let attempts = 0;
    const store = {
      read: async () => saved,
      write: async (value: string) => {
        attempts++;
        if (full) throw Object.assign(new Error('No space left on device'), { code: '53100' });
        saved = value;
      },
    };
    const first = await createBaileysAuthState(store, '/nonexistent-test-directory');
    await first.state.keys.set({ session: { retained: Buffer.from('durable') } });
    const durable = saved;
    full = true;
    await expect(first.state.keys.set({ session: { unsaved: Buffer.from('lost') } }))
      .rejects.toThrow('No space left on device');
    expect(saved).toBe(durable);
    const failedAttempts = attempts;
    full = false;
    await expect(first.saveCreds()).rejects.toThrow('No space left on device');
    expect(attempts).toBe(failedAttempts);

    const recovered = await createBaileysAuthState(store, '/nonexistent-test-directory');
    expect(recovered.state.creds.noiseKey.private).toEqual(first.state.creds.noiseKey.private);
    expect((await recovered.state.keys.get('session', ['retained'])).retained)
      .toEqual(Buffer.from('durable'));
    await recovered.state.keys.set({ session: { afterRecovery: Buffer.from('new') } });
    await recovered.flush();
    const reloaded = await createBaileysAuthState(store, '/nonexistent-test-directory');
    expect((await reloaded.state.keys.get('session', ['afterRecovery'])).afterRecovery)
      .toEqual(Buffer.from('new'));
    expect(JSON.parse(saved!).keys['session-unsaved']).toBeUndefined();
  });
});
