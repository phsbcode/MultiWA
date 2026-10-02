import { describe, expect, it } from 'vitest';
import {
  normalizeBaileysDisconnectReason,
  shouldHandleBaileysDisconnect,
} from './baileys-lifecycle';

describe('Baileys lifecycle', () => {
  it('ignores close events caused by an intentional destroy', () => {
    expect(shouldHandleBaileysDisconnect(true)).toBe(false);
  });

  it('handles unexpected transport closes', () => {
    expect(shouldHandleBaileysDisconnect(false)).toBe(true);
  });

  it('normalizes a logged-out rejection before generic connection-failure handling', () => {
    expect(normalizeBaileysDisconnectReason(true, 'Connection Failure')).toBe('Logged Out');
  });

  it('preserves a temporary provider reason when the session is not logged out', () => {
    expect(normalizeBaileysDisconnectReason(false, 'Connection Failure')).toBe('Connection Failure');
  });
  it('distinguishes the required post-pairing restart from connection failure', () => {
    expect(normalizeBaileysDisconnectReason(false, 'Stream Errored', 515)).toBe('Restart Required');
  });
});

it('retains explicit forbidden and replaced-session reasons despite generic provider messages', () => {
  expect(normalizeBaileysDisconnectReason(false, 'Connection Failure', 403)).toBe('Forbidden');
  expect(normalizeBaileysDisconnectReason(false, 'Connection Failure', 440)).toBe('Connection Replaced');
  expect(normalizeBaileysDisconnectReason(false, 'Timed Out', 408)).toBe('Timed Out');
});

const transient503 = { data: { tag: 'stream:error', attrs: { code: '503' } } };
it('recognizes only the exact observed empty 503 stream stanza as service-unavailable transport', () => {
  expect(normalizeBaileysDisconnectReason(false, 'Stream Errored (unknown)', 503, transient503))
    .toBe('Provider Service Unavailable (503)');
});
it.each([
  undefined,
  { data: { tag: 'stream:error', attrs: Object.create({ code: '503' }) } },
  { data: { tag: 'failure', attrs: { code: '503' } } },
  { data: { tag: 'stream:error', attrs: { code: '401' } } },
  { data: { tag: 'stream:error', attrs: { code: '503', type: 'restricted' } } },
  { data: { tag: 'stream:error', attrs: { code: '503' }, content: [{ tag: 'conflict', attrs: { type: 'replaced' } }] } },
  { data: { tag: 'stream:error', attrs: { code: '503' }, content: 'unknown payload' } },
])('does not infer retryability from a generic 503 without the verified safe stanza', error => {
  expect(normalizeBaileysDisconnectReason(false, 'Stream Errored (unknown)', 503, error))
    .toBe('Stream Errored (unknown)');
});
it('preserves terminal reasons and prevents raw provider text from forging the retry token', () => {
  expect(normalizeBaileysDisconnectReason(true, 'Stream Errored (unknown)', 503, transient503)).toBe('Logged Out');
  expect(normalizeBaileysDisconnectReason(false, 'Reachout Timelock', 503, transient503)).toBe('Reachout Timelock');
  expect(normalizeBaileysDisconnectReason(false, 'Stream Errored (unknown)', 403, transient503)).toBe('Forbidden');
  expect(normalizeBaileysDisconnectReason(false, 'Provider Service Unavailable (503)', 503)).toBe('Unverified Provider Service Failure');
});

it('does not turn a bare numeric 503 with no provider reason into a generic transport close', () => {
  expect(normalizeBaileysDisconnectReason(false, undefined, 503)).toBe('Unverified Provider Service Failure');
});
