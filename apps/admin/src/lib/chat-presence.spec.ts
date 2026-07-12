import { describe, expect, it } from 'vitest';
import { applyPresenceEvent, expireTransientPresence, getPresenceLabel, type PresenceRecords } from './chat-presence';

const event = (overrides: Record<string, unknown> = {}) => ({
  profileId: 'profile-1',
  conversationId: 'conversation-1',
  participantJid: '60111@s.whatsapp.net',
  chatJid: '60111@s.whatsapp.net',
  state: 'composing' as const,
  timestamp: '2026-07-13T10:00:00.000Z',
  ...overrides,
});

describe('chat presence', () => {
  it('ignores cross-profile, cross-conversation, and older events', () => {
    const initial = applyPresenceEvent({}, event(), 'profile-1', 'conversation-1');
    expect(applyPresenceEvent(initial, event({ profileId: 'profile-2' }), 'profile-1', 'conversation-1')).toBe(initial);
    expect(applyPresenceEvent(initial, event({ conversationId: 'conversation-2' }), 'profile-1', 'conversation-1')).toBe(initial);
    expect(applyPresenceEvent(initial, event({ timestamp: '2026-07-13T09:59:59.000Z', state: 'recording' }), 'profile-1', 'conversation-1')).toBe(initial);
  });

  it('expires transient presence to the last stable availability state', () => {
    let records: PresenceRecords = {};
    records = applyPresenceEvent(records, event({ state: 'available', timestamp: '2026-07-13T09:59:50.000Z' }), 'profile-1', 'conversation-1');
    records = applyPresenceEvent(records, event(), 'profile-1', 'conversation-1');

    expect(expireTransientPresence(records, Date.parse('2026-07-13T10:00:11.000Z'))['60111@s.whatsapp.net'].state).toBe('available');
  });

  it('formats direct and group activity without inventing restricted last seen', () => {
    const direct = applyPresenceEvent({}, event({ state: 'recording' }), 'profile-1', 'conversation-1');
    expect(getPresenceLabel(direct, 'individual', new Date('2026-07-13T10:00:01.000Z'))).toBe('recording audio…');

    let group: PresenceRecords = {};
    group = applyPresenceEvent(group, event({ participantJid: '60111@s.whatsapp.net' }), 'profile-1', 'conversation-1');
    group = applyPresenceEvent(group, event({ participantJid: '60222@s.whatsapp.net' }), 'profile-1', 'conversation-1');
    expect(getPresenceLabel(group, 'group', new Date('2026-07-13T10:00:01.000Z'), jid => jid.startsWith('60111') ? 'Alice' : 'Bob')).toBe('Alice and Bob typing…');

    const restricted = applyPresenceEvent({}, event({ state: 'unknown', lastSeenAt: undefined }), 'profile-1', 'conversation-1');
    expect(getPresenceLabel(restricted, 'individual', new Date('2026-07-13T10:00:01.000Z'))).toBe('');
  });
});
