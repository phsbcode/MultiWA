import { it, expect, vi } from 'vitest';
import { BaileysAdapter } from './baileys.adapter';
it('coalesces group lookups and refreshes cached membership after invalidation', async () => {
  const adapter = new BaileysAdapter() as any;
  const first = { id: 'synthetic@g.us', participants: [] };
  const next = { ...first, subject: 'Changed' };
  adapter.socket = { groupMetadata: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next) };
  expect(await Promise.all([adapter.cachedGroupMetadata(first.id),adapter.cachedGroupMetadata(first.id)])).toEqual([first,first]);
  expect(adapter.socket.groupMetadata).toHaveBeenCalledTimes(1);
  adapter.invalidateGroupMetadata(first.id);
  expect(await adapter.cachedGroupMetadata(first.id)).toEqual(next);
  expect(adapter.socket.groupMetadata).toHaveBeenCalledTimes(2);
});
it('does not restore stale metadata when a group changes during an outstanding lookup', async () => {
  const adapter = new BaileysAdapter() as any;
  let resolve: (value: any) => void;
  adapter.socket = { groupMetadata: vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ id: 'group', subject: 'New' }) };
  const old = adapter.cachedGroupMetadata('group');
  adapter.invalidateGroupMetadata('group');
  await adapter.cachedGroupMetadata('group');
  resolve!({ id: 'group', subject: 'Old' });await old;
  expect((await adapter.cachedGroupMetadata('group')).subject).toBe('New');
});
