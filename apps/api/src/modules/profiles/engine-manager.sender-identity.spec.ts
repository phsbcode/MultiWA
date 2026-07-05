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

  it('keeps a LID as provider metadata but does not synthesize a phone from it', () => {
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

  it('does not trust contact.number when the resolved contact JID is a LID', () => {
    expect(
      resolveSenderIdentity({
        from: '2061718544578@lid',
        contactJid: '2061718544578@lid',
        contactPhone: '2061718544578',
      }),
    ).toEqual({
      senderJid: '2061718544578@lid',
      senderPhone: undefined,
      originalSenderJid: '2061718544578@lid',
      isGroup: false,
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

  it('keeps group identity when the adapter flags isGroup separately from from', () => {
    expect(
      resolveSenderIdentity({
        from: '60123456789@s.whatsapp.net',
        chatJid: '120363373411642286@g.us',
        author: '60123456789@s.whatsapp.net',
        isGroup: true,
      }),
    ).toEqual({
      senderJid: '60123456789@s.whatsapp.net',
      senderPhone: '60123456789',
      originalSenderJid: '60123456789@s.whatsapp.net',
      isGroup: true,
    });
  });
});
