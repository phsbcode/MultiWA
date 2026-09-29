import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const ARCHIVE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]+\.jsonl\.gz$/;
export function prune(directory, { now = Date.now(), days = 7, maxBytes = 512 * 1024 ** 2,
  minFreeBytes = 2 * 1024 ** 3, incomingBytes = 0,
  freeBytes = () => { const s = fs.statfsSync(directory); return s.bavail * s.bsize; } } = {}) {
  const entries = fs.readdirSync(directory).filter(name => ARCHIVE.test(name)).map(name => {
    const full = path.join(directory, name), stat = fs.lstatSync(full);
    return { full, name, size: stat.size, time: Date.parse(name.slice(0, 19).replace(/T(\d+)-(\d+)-(\d+)/, 'T$1:$2:$3')),
      regular: stat.isFile() };
  }).filter(x => x.regular).sort((a, b) => a.name.localeCompare(b.name));
  let total = entries.reduce((n, x) => n + x.size, 0), removedBytes = 0;
  for (const entry of entries) {
    if (entry.time >= now - days * 86400000 && total + incomingBytes <= maxBytes &&
      freeBytes() >= minFreeBytes + incomingBytes) break;
    fs.unlinkSync(entry.full); total -= entry.size; removedBytes += entry.size;
  }
  if (total + incomingBytes > maxBytes || freeBytes() < minFreeBytes + incomingBytes) {
    throw new Error('Archive capacity reserve reached; collection paused until space is available');
  }
  return { totalBytes: total, removedBytes };
}

export function saveBatch(directory, records, state, policy = {}) {
  if (!records.length) return;
  const payload = gzipSync(records.join(''), { level: 6 });
  prune(directory, { ...policy, incomingBytes: payload.length });
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.jsonl.gz';
  const target = path.join(directory, name), temp = target + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  // Archive becomes durable before advancing the replay cursor. A crash may duplicate, never intentionally skip, records.
  const dirfd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  const checkpoint = path.join(directory, 'state.json');
  fs.writeFileSync(checkpoint + '.tmp', JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(checkpoint + '.tmp', checkpoint);
  return { name, compressedBytes: payload.length };
}

export function replaySince(state, containerId) {
  if (state.containerId !== containerId || !Number.isFinite(Date.parse(state.lastTimestamp))) return null;
  return new Date(Date.parse(state.lastTimestamp) - 60000).toISOString();
}

async function main() {
  process.umask(0o077);
  const container = process.env.ARCHIVE_CONTAINER || 'multiwa-api';
  const directory = process.env.ARCHIVE_DIRECTORY;
  if (!directory) throw new Error('ARCHIVE_DIRECTORY is required');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  // One service owns the directory. Refuse a second collector instead of racing checkpoints/pruning.
  const lock = path.join(directory, 'collector.pid');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid collector lock');
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('Another log collector is running');
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let child, stopping = false, records = [], bytes = 0, state = {};
  function flush() {
    const result = saveBatch(directory, records, state);
    if (result) { records = []; bytes = 0; console.log(`Archived ${result.compressedBytes} compressed bytes`); }
  }
  function stop() { stopping = true; child?.kill('SIGTERM'); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    try { state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    prune(directory);
    const inspect = () => execFileSync('/usr/bin/docker', ['inspect', '--format', '{{.Id}}', container],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    while (!stopping) {
      const id = inspect(), since = replaySince(state, id);
      state = { containerId: id, lastTimestamp: since ? state.lastTimestamp : null };
      const args = ['logs', '--follow', '--timestamps'];
      if (since) args.push('--since', since);
      args.push(id);
      child = spawn('/usr/bin/docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let failure;
      const collect = (stream, decoder) => chunk => {
        if (failure) return;
        try {
          const data = decoder.write(chunk);
          for (const match of data.matchAll(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) /g)) {
            if (!state.lastTimestamp || match[1] > state.lastTimestamp) state.lastTimestamp = match[1];
          }
          const record = JSON.stringify({ containerId: id, stream, capturedAt: new Date().toISOString(), data }) + '\n';
          records.push(record); bytes += Buffer.byteLength(record);
          if (bytes >= 1024 ** 2) flush();
        } catch (error) { failure = error; child.kill('SIGTERM'); }
      };
      child.stdout.on('data', collect('stdout', new StringDecoder('utf8')));
      child.stderr.on('data', collect('stderr', new StringDecoder('utf8')));
      const timer = setInterval(() => {
        try { flush(); prune(directory); if (inspect() !== id) child.kill('SIGTERM'); }
        catch (error) { failure = error; child.kill('SIGTERM'); }
      }, 15000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      }).finally(() => clearInterval(timer));
      if (failure) throw failure;
      flush();
      if (code && !stopping) throw new Error(`Docker log stream exited with status ${code}`);
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } finally {
    child?.kill('SIGTERM');
    fs.unlinkSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
