import { describe, expect, it } from 'vitest';

import {
  isProtocolStatusMessageType,
  isStatusBroadcastJid,
  shouldRouteTextToFastBots,
} from './message-type-filter';

describe('isProtocolStatusMessageType', () => {
  it('filters WhatsApp end-to-end encryption status notifications', () => {
    expect(isProtocolStatusMessageType('e2e_notification')).toBe(true);
  });

  it.each(['chat', 'text', 'image', undefined, null])(
    'allows real customer message type %s',
    (messageType) => {
      expect(isProtocolStatusMessageType(messageType)).toBe(false);
    },
  );
});

describe('isStatusBroadcastJid', () => {
  it('filters WhatsApp Status broadcast updates', () => {
    expect(isStatusBroadcastJid('status@broadcast')).toBe(true);
  });

  it.each([
    '15550000001@c.us',
    '15550000001@s.whatsapp.net',
    '120363000000000000@g.us',
    undefined,
  ])('allows customer or group JID %s', (jid) => {
    expect(isStatusBroadcastJid(jid)).toBe(false);
  });
});

describe('shouldRouteTextToFastBots', () => {
  it.each([
    'Hello',
    'Can you share more information?',
    'Thanks',
    'A routine customer update',
    '👍',
  ])('routes non-empty customer text without inspecting its content: %s', (text) => {
    expect(shouldRouteTextToFastBots('chat', text)).toBe(true);
  });

  it.each(['', '   ', undefined, null])(
    'ignores missing customer text: %s',
    (text) => {
      expect(shouldRouteTextToFastBots('chat', text)).toBe(false);
    },
  );

  it('ignores protocol events even when they contain ordinary text', () => {
    expect(
      shouldRouteTextToFastBots('e2e_notification', 'Example customer message'),
    ).toBe(false);
  });
});
