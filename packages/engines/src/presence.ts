export type PresenceState = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' | 'unknown';

export interface PresenceUpdate {
  chatJid: string;
  participantJid: string;
  state: PresenceState;
  timestamp: string;
  lastSeenAt?: string;
}

interface BaileysPresenceUpdate {
  id: string;
  presences?: Record<string, {
    lastKnownPresence?: string;
    lastSeen?: number | bigint;
  }>;
}

const supportedStates = new Set<PresenceState>(['available', 'unavailable', 'composing', 'recording', 'paused']);

export const canonicalizePresenceJid = (jid: string) => jid.replace(/:(\d+)@/, '@');

export function normalizeBaileysPresenceUpdate(update: BaileysPresenceUpdate, timestamp = new Date().toISOString()): PresenceUpdate[] {
  return Object.entries(update.presences || {}).map(([participantJid, presence]) => {
    const state = supportedStates.has(presence.lastKnownPresence as PresenceState)
      ? presence.lastKnownPresence as PresenceState
      : 'unknown';
    const lastSeenSeconds = presence.lastSeen == null ? undefined : Number(presence.lastSeen);

    return {
      chatJid: canonicalizePresenceJid(update.id),
      participantJid: canonicalizePresenceJid(participantJid),
      state,
      ...(Number.isFinite(lastSeenSeconds) ? { lastSeenAt: new Date(lastSeenSeconds! * 1000).toISOString() } : {}),
      timestamp,
    };
  });
}
