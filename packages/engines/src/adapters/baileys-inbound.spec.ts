import { describe, expect, it } from 'vitest';
import type { WAMessageContent } from '@whiskeysockets/baileys';
import {
  isBaileysProtocolMessage,
  normalizeBaileysEditedMessage,
  normalizeBaileysInbound,
  normalizeBaileysProtocolEdit,
} from './baileys-inbound';

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

  it('preserves the provider message ID quoted by an inbound reply', () => {
    const inbound = normalizeBaileysInbound({
      extendedTextMessage: {
        text: 'Paid in full',
        contextInfo: { stanzaId: 'quoted-provider-message' },
      },
    } as WAMessageContent);

    expect(inbound).toMatchObject({
      body: 'Paid in full',
      type: 'text',
      quotedMessageId: 'quoted-provider-message',
    });
  });

  it('extracts edited text from a Baileys message update', () => {
    const inbound = normalizeBaileysEditedMessage({
      editedMessage: {
        message: { extendedTextMessage: { text: 'Full edited payment details' } },
      },
    } as WAMessageContent);

    expect(inbound).toMatchObject({
      body: 'Full edited payment details',
      type: 'text',
    });
  });

  it('extracts an edit directly from its protocol envelope', () => {
    const inbound = normalizeBaileysEditedMessage({
      protocolMessage: {
        type: 14,
        editedMessage: { conversation: 'Edited protocol text' },
      },
    } as WAMessageContent);

    expect(inbound?.body).toBe('Edited protocol text');
  });

  it('identifies protocol events so they are not persisted as unknown messages', () => {
    expect(isBaileysProtocolMessage({
      protocolMessage: { type: 14 },
    } as WAMessageContent)).toBe(true);
    expect(isBaileysProtocolMessage({ conversation: 'Customer text' })).toBe(false);
  });

  it('extracts the target and replacement text from an edit protocol upsert', () => {
    const edit = normalizeBaileysProtocolEdit({
      protocolMessage: {
        type: 14,
        key: { id: 'original-provider-id' },
        timestampMs: 1785892500000,
        editedMessage: { conversation: 'Corrected payment details' },
      },
    } as WAMessageContent);

    expect(edit).toMatchObject({
      messageId: 'original-provider-id',
      inbound: { body: 'Corrected payment details', type: 'text' },
    });
  });

  it('treats a direct edited-message wrapper as a provider mutation', () => {
    expect(isBaileysProtocolMessage({
      editedMessage: { message: { conversation: 'Edited text' } },
    } as WAMessageContent)).toBe(true);
  });
});
