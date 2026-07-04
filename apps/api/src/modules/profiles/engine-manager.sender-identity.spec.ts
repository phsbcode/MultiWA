import { describe, expect, it } from 'vitest';

import { resolveSenderIdentity } from './sender-identity';

describe('resolveSenderIdentity', () => {
  it('uses a resolved contact phone instead of a group sender LID', () => {
    expect(
      resolveSenderIdentity({
        from: '120363373411642286@g.us',
        author: '27999026077946@lid',
        contactPhone: '60123456789',
      }),
    ).toEqual({
      senderJid: '60123456789@s.whatsapp.net',
      senderPhone: '60123456789',
      originalSenderJid: '27999026077946@lid',
      isGroup: true,
    });
  });

  it('keeps a LID when no resolved phone is available', () => {
    expect(
      resolveSenderIdentity({
        from: '120363373411642286@g.us',
        author: '27999026077946@lid',
      }),
    ).toEqual({
      senderJid: '27999026077946@lid',
      senderPhone: undefined,
      originalSenderJid: '27999026077946@lid',
      isGroup: true,
    });
  });

  it('normalizes non-group c.us senders to s.whatsapp.net', () => {
    expect(
      resolveSenderIdentity({
        from: '60123456789@c.us',
      }),
    ).toEqual({
      senderJid: '60123456789@s.whatsapp.net',
      senderPhone: '60123456789',
      originalSenderJid: '60123456789@c.us',
      isGroup: false,
    });
  });
});
