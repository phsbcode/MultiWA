export function shouldHandleBaileysDisconnect(isDestroying: boolean): boolean {
  return !isDestroying;
}

export function normalizeBaileysDisconnectReason(
  isLoggedOut: boolean,
  providerMessage?: string,
  statusCode?: number,
  providerError?: unknown,
): string {
  if (isLoggedOut) return 'Logged Out';
  const terminal: Record<number, string> = {
    403: 'Forbidden', 440: 'Connection Replaced',
    411: 'Multidevice Mismatch', 500: 'Bad Session', 515: 'Restart Required',
    408: 'Timed Out', 428: 'Connection Closed',
  };
  if (statusCode && terminal[statusCode]) return terminal[statusCode];
  const node = (providerError as { data?: { tag?: unknown; attrs?: Record<string, unknown>; content?: unknown } })?.data;
  const verified503 = statusCode === 503 && providerMessage === 'Stream Errored (unknown)' &&
    node?.tag === 'stream:error' && node.attrs?.code === '503' &&
    Object.keys(node.attrs).length === 1 && Object.keys(node.attrs).every(key => key === 'code') &&
    (node.content === undefined || (Array.isArray(node.content) && node.content.length === 0));
  if (verified503) return 'Provider Service Unavailable (503)';
  // Reserve the canonical retry token for the verified stanza, not raw text.
  if (providerMessage === 'Provider Service Unavailable (503)' || (statusCode === 503 && !providerMessage)) {
    return 'Unverified Provider Service Failure';
  }
  return providerMessage || 'Connection closed';
}
