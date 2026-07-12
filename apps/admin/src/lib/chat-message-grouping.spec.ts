import { describe, expect, it } from 'vitest';
import { groupChatMessages } from './chat-message-grouping';

const message = (id: string, timestamp: string, overrides: Record<string, unknown> = {}) => ({
  id,
  timestamp,
  direction: 'incoming' as const,
  type: 'text',
  senderPhone: '60111111111',
  ...overrides,
});

describe('groupChatMessages', () => {
  it('marks consecutive compatible messages as first, middle, and last with one tail', () => {
    const grouped = groupChatMessages([
      message('1', '2026-07-12T10:00:00Z', { direction: 'outgoing' }),
      message('2', '2026-07-12T10:01:00Z', { direction: 'outgoing' }),
      message('3', '2026-07-12T10:02:00Z', { direction: 'outgoing' }),
    ]);

    expect(grouped.map(item => item.position)).toEqual(['first', 'middle', 'last']);
    expect(grouped.map(item => item.showTail)).toEqual([false, false, true]);
  });

  it('breaks groups when direction, sender, date, or five-minute window changes', () => {
    const grouped = groupChatMessages([
      message('direction-a', '2026-07-12T10:00:00Z'),
      message('direction-b', '2026-07-12T10:01:00Z', { direction: 'outgoing' }),
      message('sender-a', '2026-07-12T11:00:00Z', { senderPhone: '60111111111' }),
      message('sender-b', '2026-07-12T11:01:00Z', { senderPhone: '60222222222' }),
      message('time-a', '2026-07-12T12:00:00Z'),
      message('time-b', '2026-07-12T12:05:01Z'),
      message('date-a', '2026-07-12T23:59:00Z'),
      message('date-b', '2026-07-13T00:01:00Z'),
    ]);

    expect(grouped.every(item => item.position === 'single')).toBe(true);
    expect(grouped.every(item => item.showTail)).toBe(true);
  });

  it('uses canonical sender identity and isolates special messages', () => {
    const grouped = groupChatMessages([
      message('participant-a', '2026-07-12T10:00:00Z', { senderPhone: undefined, senderJid: '60111@s.whatsapp.net', senderName: 'A' }),
      message('participant-a-2', '2026-07-12T10:01:00Z', { senderPhone: undefined, senderJid: '60111@s.whatsapp.net', senderName: 'Renamed A' }),
      message('system', '2026-07-12T10:02:00Z', { type: 'system', senderPhone: undefined, senderJid: '60111@s.whatsapp.net' }),
      message('participant-a-3', '2026-07-12T10:03:00Z', { senderPhone: undefined, senderJid: '60111@s.whatsapp.net' }),
    ]);

    expect(grouped.map(item => item.position)).toEqual(['first', 'last', 'single', 'single']);
    expect(grouped.map(item => item.showSenderName)).toEqual([true, false, true, true]);
  });
});
