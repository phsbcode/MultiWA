import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { createBaileysAuthState } from './baileys-auth-store';

describe('durable Baileys auth', () => {
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
});
