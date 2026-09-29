import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('installed tcpdump writes a bounded private header-only ring in its permitted tmp location', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multiwa-mm-headers-offline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6);
  header.writeUInt32LE(54, 16); header.writeUInt32LE(1, 20);
  const packet = Buffer.alloc(54);
  packet.writeUInt16BE(0x0800, 12); packet[14] = 0x45; packet.writeUInt16BE(40, 16);
  packet[22] = 64; packet[23] = 6;
  Buffer.from([192, 0, 2, 1, 198, 51, 100, 1]).copy(packet, 26);
  packet.writeUInt16BE(12345, 34); packet.writeUInt16BE(443, 36); packet[46] = 0x50; packet[47] = 0x11;
  const record = Buffer.alloc(70);
  record.writeUInt32LE(1, 0); record.writeUInt32LE(54, 8); record.writeUInt32LE(54, 12);
  packet.copy(record, 16);
  const input = path.join(directory, 'fixture.pcap');
  fs.writeFileSync(input, Buffer.concat([header, ...Array(80000).fill(record)]), { mode: 0o600 });
  const oldMask = process.umask(0o077);
  try {
    // -r is offline file processing: no interface, packet socket, or live traffic.
    execFileSync('/usr/bin/tcpdump', ['-r', input, '-nn', '-C', '1', '-W', '4',
      '-w', path.join(directory, 'mm-headers.pcap')], { timeout: 10000, stdio: 'pipe' });
  } finally { process.umask(oldMask); }
  const files = fs.readdirSync(directory).filter(name => /^mm-headers\.pcap[0-3]$/.test(name));
  assert.equal(files.length, 4);
  for (const name of files) {
    const full = path.join(directory, name), stat = fs.statSync(full), data = fs.readFileSync(full);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.ok(stat.size <= 1000100);
    assert.equal(data.readUInt32LE(16), 54);
    for (let offset = 24; offset < data.length; offset += 70) assert.equal(data.readUInt32LE(offset + 8), 54);
  }
});
