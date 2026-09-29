import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { prune, saveBatch, replaySince } from './archive-container-logs.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'container-archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function archive(dir, day, bytes = 10) {
  const file = `${day}T00-00-00-000Z-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl.gz`;
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(bytes)); return file;
}
const plenty = { freeBytes: () => 10 * 1024 ** 3 };
test('gzip round trip preserves logs and advances the cursor only after a durable archive', t => {
  const dir = fixture(t), records = [JSON.stringify({ stream: 'stderr', data: 'synthetic failure\n' }) + '\n'];
  const state = { containerId: 'fixture', lastTimestamp: '2026-09-28T00:00:00.000Z' };
  const result = saveBatch(dir, records, state, plenty);
  assert.equal(gunzipSync(fs.readFileSync(path.join(dir, result.name))).toString(), records.join(''));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))), state);
  assert.equal(fs.statSync(path.join(dir, result.name)).mode & 0o777, 0o600);
});
test('age retention removes only owned archives and preserves recent logs and unrelated files', t => {
  const dir = fixture(t), old = archive(dir, '2026-09-10'), recent = archive(dir, '2026-09-27');
  fs.writeFileSync(path.join(dir, 'unrelated.gz'), 'keep');
  prune(dir, { ...plenty, now: Date.parse('2026-09-28T00:00:00Z') });
  assert.equal(fs.existsSync(path.join(dir, old)), false);
  assert.equal(fs.existsSync(path.join(dir, recent)), true);
  assert.equal(fs.existsSync(path.join(dir, 'unrelated.gz')), true);
});
test('size retention removes oldest archives first including room for the next segment', t => {
  const dir = fixture(t), old = archive(dir, '2026-09-26', 20), recent = archive(dir, '2026-09-27', 20);
  prune(dir, { ...plenty, now: Date.parse('2026-09-28T00:00:00Z'), maxBytes: 35, incomingBytes: 10 });
  assert.equal(fs.existsSync(path.join(dir, old)), false);
  assert.equal(fs.existsSync(path.join(dir, recent)), true);
});
test('low disk refuses to advance the cursor or touch unrelated data', t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  assert.throws(() => saveBatch(dir, ['test\n'], { lastTimestamp: 'new' }, { freeBytes: () => 0 }), /reserve/);
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
test('same-container restart replays an overlap and a replacement backfills all retained logs', () => {
  const state = { containerId: 'old', lastTimestamp: '2026-09-28T00:02:00.000000001Z' };
  assert.equal(replaySince(state, 'old'), '2026-09-28T00:01:00.000Z');
  assert.equal(replaySince(state, 'new'), null);
});
