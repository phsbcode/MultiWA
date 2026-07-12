const PROTOCOL_STATUS_MESSAGE_TYPES = new Set([
  'e2e_notification',
]);

/** Protocol/status events are not customer messages and must have no chat side effects. */
export function isProtocolStatusMessageType(messageType: unknown): boolean {
  return typeof messageType === 'string'
    && PROTOCOL_STATUS_MESSAGE_TYPES.has(messageType.toLowerCase());
}

/** WhatsApp Status posts are broadcasts, not direct customer messages. */
export function isStatusBroadcastJid(jid: unknown): boolean {
  return typeof jid === 'string' && jid.toLowerCase() === 'status@broadcast';
}

/** Route non-empty customer text unless it belongs to a protocol/status record. */
export function shouldRouteTextToFastBots(
  messageType: unknown,
  messageText: unknown,
): boolean {
  return !isProtocolStatusMessageType(messageType)
    && typeof messageText === 'string'
    && messageText.trim().length > 0;
}
