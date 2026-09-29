export function boundedRecoveryProfileIds(): string[] {
  return [...new Set((process.env.MULTIWA_TRANSPORT_RECOVERY_PROFILE_IDS || '').split(',')
    .map(value => value.trim()).filter(Boolean))];
}
export function usesBoundedRecovery(profileId: string): boolean {
  return boundedRecoveryProfileIds().includes(profileId);
}
/** Explicit bounded recovery supersedes a profile's blanket investigation stop. */
export function requiresManualReconnect(profileId: string): boolean {
  return (process.env.MULTIWA_MANUAL_RECONNECT_PROFILE_IDS || '').split(',')
    .map(value => value.trim()).filter(Boolean).includes(profileId) && !usesBoundedRecovery(profileId);
}
