import { describe, expect, it } from 'vitest';
import { shouldHandleBaileysDisconnect } from './baileys-lifecycle';

describe('Baileys lifecycle', () => {
  it('ignores close events caused by an intentional destroy', () => {
    expect(shouldHandleBaileysDisconnect(true)).toBe(false);
  });

  it('handles unexpected transport closes', () => {
    expect(shouldHandleBaileysDisconnect(false)).toBe(true);
  });
});
