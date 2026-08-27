import { createCipheriv, hkdfSync, randomBytes } from 'crypto';
import { describe, expect, it } from 'vitest';
import { proto } from '@whiskeysockets/baileys';
import { decryptBaileysSecretEdit } from './baileys-secret-edit';

function encryptedEditFixture() {
  const messageId = 'original-message-id';
  const messageSecret = randomBytes(32);
  const iv = randomBytes(12);
  const originalSender = '60196756799@s.whatsapp.net';
  const modificationSender = '21891515469883@lid';
  const info = Buffer.from(`${messageId}${originalSender}${modificationSender}Message Edit`);
  const key = Buffer.from(hkdfSync('sha256', messageSecret, Buffer.alloc(0), info, 32));
  const inner = proto.Message.encode({
    protocolMessage: {
      type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      key: { id: messageId },
      editedMessage: { conversation: 'Corrected mentoring payment' },
    },
  }).finish();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(inner), cipher.final(), cipher.getAuthTag()]);
  const original = proto.WebMessageInfo.create({
    key: {
      remoteJid: '120363428334614306@g.us',
      participant: originalSender,
      id: messageId,
    },
    message: {
      conversation: 'Original mentoring payment',
      messageContextInfo: { messageSecret },
    },
  });
  const envelope = proto.WebMessageInfo.create({
    key: {
      remoteJid: '120363428334614306@g.us',
      participant: modificationSender,
      id: 'edit-envelope-id',
    },
    message: {
      secretEncryptedMessage: {
        targetMessageKey: {
          remoteJid: '120363428334614306@g.us',
          participant: originalSender,
          id: messageId,
        },
        encPayload: encrypted,
        encIv: iv,
        secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
      },
    },
  });
  return { envelope, original };
}

describe('Baileys secret-encrypted edits', () => {
  it('decrypts a LID-sender edit with the original PN message secret', () => {
    const { envelope, original } = encryptedEditFixture();
    expect(decryptBaileysSecretEdit(envelope, original)).toEqual({
      messageId: 'original-message-id',
      body: 'Corrected mentoring payment',
      type: 'text',
    });
  });

  it('fails closed when the original message secret is unavailable', () => {
    const { envelope } = encryptedEditFixture();
    expect(decryptBaileysSecretEdit(envelope, undefined)).toBeNull();
  });
});
