import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { saveBatch } from './archive-container-logs.mjs';

export function socketSample(table, target) {
  const address = value => {
    const [ip, port] = value.split(':');
    return { address: Buffer.from(ip, 'hex').reverse().join('.'), port: parseInt(port, 16) };
  };
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const local = address(fields[1]), peer = address(fields[2]);
    if (local.address !== target.localAddress || local.port !== target.localPort ||
        peer.address !== target.peerAddress || peer.port !== target.peerPort) continue;
    const [tx, rx] = fields[4].split(':');
    const [timer, expires] = fields[5].split(':');
    return { state: fields[3], inode: fields[9], txQueueBytes: parseInt(tx, 16),
      rxQueueBytes: parseInt(rx, 16), timer: parseInt(timer, 16), timerExpiresRawTicks: parseInt(expires, 16),
      unrecoveredRetransmissionTimeouts: parseInt(fields[6], 16) };
  }
  return null;
}

export async function watch({ pid, target, inode, generation, directory, seconds = 86400, notifyPane }) {
  process.umask(0o077);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  let records = [], notified = false, stopping = false, missing = 0;
  const start = Date.now();
  const state = { pid, target, inode, generation, startedAt: new Date(start).toISOString() };
  const flush = () => {
    saveBatch(directory, records, state, { days: 1, maxBytes: 16 * 1024 ** 2, minFreeBytes: 2 * 1024 ** 3 });
    records = [];
  };
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopping && Date.now() - start < seconds * 1000) {
      let sample, readError = null;
      try { sample = socketSample(fs.readFileSync(`/proc/${pid}/net/tcp`, 'utf8'), target); }
      catch (error) { readError = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'READ_ERROR'; }
      const replaced = Boolean(sample && sample.inode !== inode && sample.inode !== '0');
      const value = { observedAt: new Date().toISOString(), generation,
        event: 'transport_socket_sample', sample: replaced ? null : sample || null,
        readError, replaced };
      records.push(JSON.stringify(value) + '\n');
      state.lastTimestamp = value.observedAt;
      missing = !sample || readError ? missing + 1 : 0;
      const ended = replaced || missing >= 3 || sample && sample.state !== '01';
      if (records.length >= 30 || ended) flush();
      if (ended && !notified) {
        notified = true;
        console.log(JSON.stringify({ event: 'watched_socket_changed', at: value.observedAt,
          generation, state: sample?.state || null, readError, replaced }));
        if (notifyPane) {
          try {
            execFileSync('herdr', ['agent', 'prompt', notifyPane,
              `MULTIWA CONTINUED OBSERVATION: scoped socket changed at ${value.observedAt}; ` +
              `generation ${generation}, state ${sample?.state || 'absent'}, readError ${readError}, ` +
              `replaced ${replaced}. Private metadata is in ${directory}. ` +
              'No reconnect or scan was performed. Inspect real transport diagnostics before any restoration. No acknowledgement requested.'],
            { timeout: 10000, stdio: 'ignore' });
          } catch { console.log('Scoped observation notification could not be delivered'); }
        }
      }
      if (replaced || missing >= 30) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    flush();
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: Object.fromEntries([
    'pid', 'local-address', 'local-port', 'peer-address', 'peer-port', 'inode', 'generation', 'directory',
    'seconds', 'notify-pane',
  ].map(name => [name, { type: 'string' }])) });
  const ip = value => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) &&
    value.split('.').every(n => Number(n) <= 255);
  const positive = (value, max) => /^\d+$/.test(value || '') && Number(value) > 0 && Number(value) <= max;
  if (!positive(values.pid, 2 ** 31 - 1) || !positive(values['local-port'], 65535) ||
      !positive(values['peer-port'], 65535) || !ip(values['local-address']) || !ip(values['peer-address']) ||
      !/^\d+$/.test(values.inode || '') || !/^[a-f0-9-]{36}$/.test(values.generation || '') ||
      !values.directory || !path.isAbsolute(values.directory) ||
      values.seconds && !positive(values.seconds, 86400) ||
      values['notify-pane'] && !/^w\d+:p\d+$/.test(values['notify-pane'])) throw Error('Invalid scoped observation arguments');
  watch({ pid: Number(values.pid), inode: values.inode, generation: values.generation,
    directory: values.directory, seconds: Number(values.seconds || 86400), notifyPane: values['notify-pane'],
    target: { localAddress: values['local-address'], localPort: Number(values['local-port']),
      peerAddress: values['peer-address'], peerPort: Number(values['peer-port']) } })
    .catch(() => { console.error('Scoped socket observation stopped; inspect permissions/capacity'); process.exitCode = 1; });
}
