import { describe, expect, it } from 'vitest';
import { normalizeBaileysPresenceUpdate } from './presence';

describe('normalizeBaileysPresenceUpdate', () => {
  it('normalizes each participant and strips device suffixes from canonical JIDs', () => {
    expect(normalizeBaileysPresenceUpdate({
      id: '120363025@g.us',
      presences: {
        '60111:4@s.whatsapp.net': { lastKnownPresence: 'composing', lastSeen: 1_720_000_000 },
        '60222@s.whatsapp.net': { lastKnownPresence: 'recording' },
      },
    }, '2026-07-13T10:00:00.000Z')).toEqual([
      {
        chatJid: '120363025@g.us',
        participantJid: '60111@s.whatsapp.net',
        state: 'composing',
        lastSeenAt: '2024-07-03T09:46:40.000Z',
        timestamp: '2026-07-13T10:00:00.000Z',
      },
      {
        chatJid: '120363025@g.us',
        participantJid: '60222@s.whatsapp.net',
        state: 'recording',
        timestamp: '2026-07-13T10:00:00.000Z',
      },
    ]);
  });

  it('maps unsupported presence values to unknown without inventing last seen', () => {
    expect(normalizeBaileysPresenceUpdate({
      id: '60111@s.whatsapp.net',
      presences: { '60111@s.whatsapp.net': { lastKnownPresence: 'restricted' } },
    }, '2026-07-13T10:00:00.000Z')).toEqual([
      {
        chatJid: '60111@s.whatsapp.net',
        participantJid: '60111@s.whatsapp.net',
        state: 'unknown',
        timestamp: '2026-07-13T10:00:00.000Z',
      },
    ]);
  });
});
