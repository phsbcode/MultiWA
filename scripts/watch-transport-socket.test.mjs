import test from 'node:test';
import assert from 'node:assert/strict';
import { socketSample } from './watch-transport-socket.mjs';

const target = { localAddress: '192.0.2.10', localPort: 12345, peerAddress: '198.51.100.20', peerPort: 443 };
const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const row = ' 1: 0A0200C0:3039 146433C6:01BB 01 00000010:00000020 01:00000003 00000002 0 0 42\n';
test('decodes only the exact IPv4 transport tuple and kernel fields', () => {
  assert.deepEqual(socketSample(header + row, target), { state: '01', inode: '42',
    txQueueBytes: 16, rxQueueBytes: 32, timer: 1, timerExpiresRawTicks: 3, unrecoveredRetransmissionTimeouts: 2 });
});
test('excludes another peer, source port, and absent sockets', () => {
  assert.equal(socketSample(header + row, { ...target, peerAddress: '203.0.113.30' }), null);
  assert.equal(socketSample(header + row, { ...target, localPort: 1 }), null);
  assert.equal(socketSample(header, target), null);
});
