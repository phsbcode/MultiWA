export type ChatPresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' | 'unknown';

export interface ChatPresenceEvent {
  profileId: string;
  conversationId: string;
  chatJid: string;
  participantJid: string;
  state: ChatPresenceState;
  timestamp: string;
  lastSeenAt?: string;
}

export interface ChatPresenceRecord extends ChatPresenceEvent {
  fallbackState: 'available' | 'unavailable' | 'unknown';
}

export type PresenceRecords = Record<string, ChatPresenceRecord>;

const transientStates = new Set<ChatPresenceState>(['composing', 'recording']);

export function applyPresenceEvent(current: PresenceRecords, event: ChatPresenceEvent, selectedProfileId: string, selectedConversationId: string): PresenceRecords {
  if (event.profileId !== selectedProfileId || event.conversationId !== selectedConversationId) return current;
  const previous = current[event.participantJid];
  if (previous && Date.parse(event.timestamp) <= Date.parse(previous.timestamp)) return current;

  const fallbackState = event.state === 'available' || event.state === 'unavailable'
    ? event.state
    : previous?.fallbackState || 'unknown';
  const state = event.state === 'paused' ? fallbackState : event.state;

  return {
    ...current,
    [event.participantJid]: {
      ...event,
      state,
      fallbackState,
      lastSeenAt: event.lastSeenAt || previous?.lastSeenAt,
    },
  };
}

export function expireTransientPresence(current: PresenceRecords, now = Date.now(), ttlMs = 10_000): PresenceRecords {
  let changed = false;
  const next = Object.fromEntries(Object.entries(current).map(([jid, record]) => {
    if (!transientStates.has(record.state) || now - Date.parse(record.timestamp) <= ttlMs) return [jid, record];
    changed = true;
    return [jid, { ...record, state: record.fallbackState }];
  }));
  return changed ? next : current;
}

const formatLastSeen = (lastSeenAt: string, now: Date) => {
  const seen = new Date(lastSeenAt);
  if (Number.isNaN(seen.getTime())) return '';
  const time = seen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (seen.toDateString() === now.toDateString()) return `last seen today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (seen.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${seen.toLocaleDateString([], { day: 'numeric', month: 'long' })} at ${time}`;
};

export function getPresenceLabel(records: PresenceRecords, conversationType: string, now = new Date(), participantLabel: (jid: string) => string = jid => jid.split('@')[0]): string {
  const values = Object.values(records);
  if (conversationType === 'group') {
    const active = values.filter(record => transientStates.has(record.state));
    if (active.length === 0) return '';
    if (active.length > 2) return 'Several people typing…';
    const names = active.map(record => participantLabel(record.participantJid));
    const action = active.some(record => record.state === 'recording') ? 'recording audio…' : 'typing…';
    return `${names.join(' and ')} ${action}`;
  }

  const latest = values.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
  if (!latest) return '';
  if (latest.state === 'composing') return 'typing…';
  if (latest.state === 'recording') return 'recording audio…';
  if (latest.state === 'available') return 'online';
  if (latest.lastSeenAt) return formatLastSeen(latest.lastSeenAt, now);
  return '';
}
