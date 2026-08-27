import {
  normalizeMessageContent,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

export type BaileysInboundType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'location'
  | 'contact'
  | 'sticker'
  | 'unknown';

export type BaileysInboundMedia = {
  mimetype?: string;
  filename?: string;
};

export type NormalizedBaileysInbound = {
  content?: WAMessageContent;
  body: string;
  type: BaileysInboundType;
  media?: BaileysInboundMedia;
  quotedMessageId?: string;
};

function quotedMessageId(content: WAMessageContent): string | undefined {
  return content.extendedTextMessage?.contextInfo?.stanzaId
    || content.imageMessage?.contextInfo?.stanzaId
    || content.videoMessage?.contextInfo?.stanzaId
    || content.audioMessage?.contextInfo?.stanzaId
    || content.documentMessage?.contextInfo?.stanzaId
    || content.stickerMessage?.contextInfo?.stanzaId
    || content.locationMessage?.contextInfo?.stanzaId
    || content.liveLocationMessage?.contextInfo?.stanzaId
    || content.contactMessage?.contextInfo?.stanzaId
    || content.contactsArrayMessage?.contextInfo?.stanzaId
    || undefined;
}

export function normalizeBaileysInbound(
  rawContent: WAMessageContent | null | undefined,
): NormalizedBaileysInbound {
  const content = normalizeMessageContent(rawContent);

  if (!content) {
    return { body: '', type: 'unknown' };
  }

  const quoted = quotedMessageId(content);

  if (content.conversation || content.extendedTextMessage) {
    return {
      content,
      body: content.conversation || content.extendedTextMessage?.text || '',
      type: 'text',
      quotedMessageId: quoted,
    };
  }

  if (content.imageMessage) {
    return {
      content,
      body: content.imageMessage.caption || '',
      type: 'image',
      media: { mimetype: content.imageMessage.mimetype || 'image/jpeg' },
      quotedMessageId: quoted,
    };
  }

  if (content.videoMessage) {
    return {
      content,
      body: content.videoMessage.caption || '',
      type: 'video',
      media: { mimetype: content.videoMessage.mimetype || 'video/mp4' },
      quotedMessageId: quoted,
    };
  }

  if (content.audioMessage) {
    return {
      content,
      body: '',
      type: 'audio',
      media: { mimetype: content.audioMessage.mimetype || 'audio/ogg' },
      quotedMessageId: quoted,
    };
  }

  if (content.documentMessage) {
    return {
      content,
      body: content.documentMessage.caption || '',
      type: 'document',
      media: {
        mimetype: content.documentMessage.mimetype || 'application/octet-stream',
        filename: content.documentMessage.fileName || undefined,
      },
      quotedMessageId: quoted,
    };
  }

  if (content.stickerMessage) {
    return {
      content,
      body: '',
      type: 'sticker',
      media: { mimetype: content.stickerMessage.mimetype || 'image/webp' },
      quotedMessageId: quoted,
    };
  }

  if (content.locationMessage || content.liveLocationMessage) {
    return { content, body: '', type: 'location', quotedMessageId: quoted };
  }

  if (content.contactMessage || content.contactsArrayMessage) {
    return { content, body: '', type: 'contact', quotedMessageId: quoted };
  }

  return { content, body: '', type: 'unknown', quotedMessageId: quoted };
}

export function isBaileysProtocolMessage(
  rawContent: WAMessageContent | null | undefined,
): boolean {
  return Boolean(
    rawContent?.protocolMessage
    || rawContent?.editedMessage
    || normalizeMessageContent(rawContent)?.protocolMessage,
  );
}

export function normalizeBaileysProtocolEdit(
  rawContent: WAMessageContent | null | undefined,
): { messageId: string; inbound: NormalizedBaileysInbound; timestampMs?: unknown } | null {
  const protocol = rawContent?.protocolMessage
    || normalizeMessageContent(rawContent)?.protocolMessage;
  const messageId = protocol?.key?.id;
  if (!messageId || !protocol.editedMessage) return null;
  return {
    messageId,
    inbound: normalizeBaileysInbound(protocol.editedMessage),
    timestampMs: protocol.timestampMs,
  };
}

export function normalizeBaileysEditedMessage(
  rawContent: WAMessageContent | null | undefined,
): NormalizedBaileysInbound | null {
  if (rawContent?.editedMessage?.message) {
    return normalizeBaileysInbound(rawContent);
  }
  const content = normalizeMessageContent(rawContent);
  const edited = content?.protocolMessage?.editedMessage;
  return edited ? normalizeBaileysInbound(edited) : null;
}
