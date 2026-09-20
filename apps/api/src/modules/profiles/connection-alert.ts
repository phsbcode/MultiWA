import { prisma } from '@multiwa/database';

const codes = ['FORBIDDEN', 'LOGGED_OUT', 'CONNECTION_REPLACED', 'BAD_SESSION',
  'AUTH_STORAGE_UNAVAILABLE', 'MULTIDEVICE_MISMATCH', 'RETRIES_EXHAUSTED', 'MANUAL_PAUSE'] as const;
export type ConnectionAlertCode = typeof codes[number];
export function connectionAlertCode(reason: string, exhausted: boolean): ConnectionAlertCode | null {
  if (/Forbidden/i.test(reason)) return 'FORBIDDEN';
  if (/Logged Out|loggedOut/i.test(reason)) return 'LOGGED_OUT';
  if (/Connection Replaced/i.test(reason)) return 'CONNECTION_REPLACED';
  if (/Auth Storage Unavailable/i.test(reason)) return 'AUTH_STORAGE_UNAVAILABLE';
  if (/Multidevice Mismatch/i.test(reason)) return 'MULTIDEVICE_MISMATCH';
  if (/Bad Session|Session Expired/i.test(reason)) return 'BAD_SESSION';
  return exhausted ? 'RETRIES_EXHAUSTED' : null;
}
export function readConnectionAlert(settings: unknown) {
  const value = (settings as any)?.connectionAlert;
  if (!value || !codes.includes(value.code) || !Number.isFinite(Date.parse(value.occurredAt))) return null;
  return { code: value.code as ConnectionAlertCode, occurredAt: String(value.occurredAt), active: value.code !== 'MANUAL_PAUSE' };
}
export async function recordConnectionAlert(profileId: string, code: ConnectionAlertCode | null) {
  const value = JSON.stringify(code ? { code, occurredAt: new Date().toISOString() } : null);
  // Atomic JSON update preserves concurrent edits to unrelated profile settings.
  await prisma.$executeRaw`UPDATE profiles SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{connectionAlert}', ${value}::jsonb, true) WHERE id = ${profileId}`;
}
