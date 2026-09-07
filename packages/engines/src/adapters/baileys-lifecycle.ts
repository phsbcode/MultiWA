export function shouldHandleBaileysDisconnect(isDestroying: boolean): boolean {
  return !isDestroying;
}

export function normalizeBaileysDisconnectReason(
  isLoggedOut: boolean,
  providerMessage?: string,
): string {
  if (isLoggedOut) return 'Logged Out';
  return providerMessage || 'Connection closed';
}
