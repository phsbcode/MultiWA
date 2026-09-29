import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRecoveryJournal, initialRecoveryState } from './transport-recovery-journal';

it('persists private recovery markers across independent journal instances without credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multiwa-recovery-'));
  try {
    const journal = new FileRecoveryJournal(dir, 'profile-a');
    expect(await journal.read()).toBeNull();
    const state = { ...initialRecoveryState(), pauseReason: 'MANUAL_PAUSE' as const,
      firstGapAt: '2026-09-28T19:08:19.319Z', lastDisconnectedAt: '2026-09-29T09:28:50.918Z' };
    await journal.write(state);
    expect(await new FileRecoveryJournal(dir, 'profile-a').read()).toEqual(state);
    const file = join(dir, '.connection-recovery', 'profile-a.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.connection-recovery'))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).not.toContain('sessionData');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('refuses corrupt state, invalid retries and traversal instead of silently resetting a stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multiwa-recovery-invalid-'));
  try {
    const journal = new FileRecoveryJournal(dir, 'profile-a');
    await journal.write(initialRecoveryState());
    await expect(journal.write({ ...initialRecoveryState(), attemptsUsed: 99 })).rejects.toThrow();
    await writeFile(join(dir, '.connection-recovery', 'profile-a.json'), '{broken');
    await expect(journal.read()).rejects.toThrow();
    expect(() => new FileRecoveryJournal(dir, '../escape')).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
