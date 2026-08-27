import { createDecipheriv, hkdfSync } from 'crypto';
import { proto } from '@whiskeysockets/baileys';
import { normalizeBaileysInbound, normalizeBaileysProtocolEdit } from './baileys-inbound';

type MessageKeyWithAlt = proto.IMessageKey & { participantAlt?: string | null };

function nonDeviceJid(jid: string): string {
  return jid.replace(/:\d+@/, '@');
}

function uniqueJids(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)).map(nonDeviceJid))];
}

function decryptPayload(key: Buffer, iv: Uint8Array, payload: Uint8Array): Uint8Array | null {
  if (payload.length <= 16) return null;
  try {
    const ciphertext = Buffer.from(payload).subarray(0, payload.length - 16);
    const authTag = Buffer.from(payload).subarray(payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

export type DecryptedBaileysSecretEdit = {
  messageId: string;
  body: string;
  type: string;
};

export function decryptBaileysSecretEdit(
  envelope: proto.IWebMessageInfo,
  original: proto.IWebMessageInfo | undefined,
): DecryptedBaileysSecretEdit | null {
  const encrypted = envelope.message?.secretEncryptedMessage;
  const target = encrypted?.targetMessageKey;
  const messageSecret = original?.message?.messageContextInfo?.messageSecret;
  if (
    encrypted?.secretEncType !== proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
    || !target?.id
    || !encrypted.encIv
    || !encrypted.encPayload
    || !messageSecret
  ) return null;

  const envelopeKey = envelope.key as MessageKeyWithAlt;
  const originalKey = original.key as MessageKeyWithAlt;
  const targetKey = target as MessageKeyWithAlt;
  const modificationSenders = uniqueJids([
    envelopeKey.participant,
    envelopeKey.participantAlt,
  ]);
  const originalSenders = target.fromMe
    ? modificationSenders
    : uniqueJids([
      targetKey.participant,
      targetKey.participantAlt,
      originalKey.participant,
      originalKey.participantAlt,
      target.remoteJid,
    ]);

  for (const originalSender of originalSenders) {
    for (const modificationSender of modificationSenders) {
      const info = Buffer.from(
        `${target.id}${originalSender}${modificationSender}Message Edit`,
        'utf8',
      );
      const key = Buffer.from(hkdfSync('sha256', Buffer.from(messageSecret), Buffer.alloc(0), info, 32));
      const plaintext = decryptPayload(key, encrypted.encIv, encrypted.encPayload);
      if (!plaintext) continue;
      try {
        const decoded = proto.Message.decode(plaintext);
        const protocolEdit = normalizeBaileysProtocolEdit(decoded);
        if (protocolEdit) {
          return {
            messageId: protocolEdit.messageId,
            body: protocolEdit.inbound.body,
            type: protocolEdit.inbound.type,
          };
        }
        const inbound = normalizeBaileysInbound(decoded);
        if (inbound.type !== 'unknown' || inbound.body) {
          return { messageId: target.id, body: inbound.body, type: inbound.type };
        }
      } catch {
        // Try the next PN/LID identity combination.
      }
    }
  }
  return null;
}
