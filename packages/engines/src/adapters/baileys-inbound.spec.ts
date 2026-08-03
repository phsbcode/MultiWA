import { describe, expect, it } from 'vitest';
import type { WAMessageContent } from '@whiskeysockets/baileys';
import { normalizeBaileysInbound } from './baileys-inbound';

describe('Baileys inbound normalization', () => {
  it('unwraps an ephemeral image and preserves its caption and MIME type', () => {
    const inbound = normalizeBaileysInbound({
      ephemeralMessage: {
        message: {
          imageMessage: {
            caption: 'Nimalan mentoring',
            mimetype: 'image/jpeg',
          },
        },
      },
    } as WAMessageContent);

    expect(inbound).toMatchObject({
      body: 'Nimalan mentoring',
      type: 'image',
      media: { mimetype: 'image/jpeg' },
    });
  });

  it('unwraps a view-once document and keeps its filename', () => {
    const inbound = normalizeBaileysInbound({
      viewOnceMessageV2: {
        message: {
          documentMessage: {
            caption: 'Payment receipt',
            mimetype: 'application/pdf',
            fileName: 'receipt.pdf',
          },
        },
      },
    } as WAMessageContent);

    expect(inbound).toMatchObject({
      body: 'Payment receipt',
      type: 'document',
      media: {
        mimetype: 'application/pdf',
        filename: 'receipt.pdf',
      },
    });
  });

  it('preserves ordinary text messages', () => {
    const inbound = normalizeBaileysInbound({ conversation: 'Paid today' });

    expect(inbound).toMatchObject({
      body: 'Paid today',
      type: 'text',
    });
    expect(inbound.media).toBeUndefined();
  });
});
