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
});
