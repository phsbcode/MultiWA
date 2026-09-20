export function shouldHandleBaileysDisconnect(isDestroying: boolean): boolean {
  return !isDestroying;
}

export function normalizeBaileysDisconnectReason(
  isLoggedOut: boolean,
  providerMessage?: string,
  statusCode?: number,
): string {
  if (isLoggedOut) return 'Logged Out';
  const terminal: Record<number, string> = {
    403: 'Forbidden', 440: 'Connection Replaced',
    411: 'Multidevice Mismatch', 500: 'Bad Session',
  };
  if (statusCode && terminal[statusCode]) return terminal[statusCode];
  return providerMessage || 'Connection closed';
}
