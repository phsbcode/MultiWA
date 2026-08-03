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
};

export function normalizeBaileysInbound(
  rawContent: WAMessageContent | null | undefined,
): NormalizedBaileysInbound {
  const content = normalizeMessageContent(rawContent);

  if (!content) {
    return { body: '', type: 'unknown' };
  }

  if (content.conversation || content.extendedTextMessage) {
    return {
      content,
      body: content.conversation || content.extendedTextMessage?.text || '',
      type: 'text',
    };
  }

  if (content.imageMessage) {
    return {
      content,
      body: content.imageMessage.caption || '',
      type: 'image',
      media: { mimetype: content.imageMessage.mimetype || 'image/jpeg' },
    };
  }

  if (content.videoMessage) {
    return {
      content,
      body: content.videoMessage.caption || '',
      type: 'video',
      media: { mimetype: content.videoMessage.mimetype || 'video/mp4' },
    };
  }

  if (content.audioMessage) {
    return {
      content,
      body: '',
      type: 'audio',
      media: { mimetype: content.audioMessage.mimetype || 'audio/ogg' },
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
    };
  }

  if (content.stickerMessage) {
    return {
      content,
      body: '',
      type: 'sticker',
      media: { mimetype: content.stickerMessage.mimetype || 'image/webp' },
    };
  }

  if (content.locationMessage || content.liveLocationMessage) {
    return { content, body: '', type: 'location' };
  }

  if (content.contactMessage || content.contactsArrayMessage) {
    return { content, body: '', type: 'contact' };
  }

  return { content, body: '', type: 'unknown' };
}
