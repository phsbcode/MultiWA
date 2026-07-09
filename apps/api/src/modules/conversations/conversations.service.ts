// MultiWA Gateway - Conversations Service
// apps/api/src/modules/conversations/conversations.service.ts

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { prisma } from '@multiwa/database';
import { GroupsService } from '../groups/groups.service';

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly groupsService: GroupsService) {}

  // List conversations
  async findAll(profileId: string, options: {
    type?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = { profileId };
    
    if (options.type) {
      where.type = options.type;
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        take: options.limit || 50,
        skip: options.offset || 0,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          _count: { select: { messages: true } },
          contact: { select: { name: true, phone: true } },
        },
      }),
      prisma.conversation.count({ where }),
    ]);

    // Efficiently fetch the latest message per conversation using DISTINCT ON.
    // Fetch only IDs first (fast), then use Prisma findMany for deserialization.
    let lastMessageMap: Map<string, any> = new Map();
    if (conversations.length > 0) {
      const convIds = conversations.map(c => c.id);
      const lastIds: { conversationId: string; id: string }[] = await prisma.$queryRawUnsafe(`
        SELECT m."conversationId", m."id"
        FROM messages m
        INNER JOIN (
          SELECT "conversationId", MAX("timestamp") AS max_ts
          FROM messages
          WHERE "conversationId" = ANY($1)
          GROUP BY "conversationId"
        ) latest ON m."conversationId" = latest."conversationId" AND m."timestamp" = latest.max_ts
        WHERE m."conversationId" = ANY($1)
      `, convIds);
      if (lastIds.length > 0) {
        // Fetch last messages via raw query returning only text columns to
        // avoid the extreme overhead of Prisma's JSONB deserialization.
        const msgs: any[] = await prisma.$queryRawUnsafe(`
          SELECT m."id", m."profileId", m."conversationId", m."messageId",
                 m."direction", m."senderJid", m."type", m."status",
                 m."quotedMessageId", m."timestamp", m."createdAt",
                 m."content"::text AS "content", m."metadata"::text AS "metadata"
          FROM messages m
          WHERE m."id" = ANY($1)
        `, lastIds.map(l => l.id));
        for (const m of msgs) {
          // Parse jsonb fields back since we got them as text
          try { m.content = typeof m.content === 'string' ? JSON.parse(m.content) : m.content; } catch {}
          try { m.metadata = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata; } catch {}
          lastMessageMap.set(m.conversationId, m);
        }
      }
    }

    // For conversations without a contact, try to resolve names by JID phone number
    const unlinkedConvs = conversations.filter(c => !c.contact && c.jid?.includes('@s.whatsapp.net'));
    let phoneToName: Record<string, string> = {};
    
    if (unlinkedConvs.length > 0) {
      const phones = unlinkedConvs.map(c => c.jid.split('@')[0]);
      const contacts = await prisma.contact.findMany({
        where: {
          profileId,
          phone: { in: phones },
        },
        select: { phone: true, name: true },
      });
      for (const ct of contacts) {
        if (ct.phone && ct.name) {
          phoneToName[ct.phone] = ct.name;
        }
      }
    }

    // Resolve group names from WhatsApp engine (per-JID for reliability).
    // Older rows may have been seeded with the latest participant/sender name
    // (e.g. "AzwaHanee") instead of the actual group title, and those names
    // look human-readable. Refresh every visible group row so group identity
    // wins over stale sender/contact labels.
    //
    // Group name resolution runs fire-and-forget to avoid blocking the
    // conversation list response on potentially dozens of engine network calls.
    // Resolved names persist to the DB and appear on the next page load.
    const groupConvs = conversations.filter(c => c.type === 'group' || c.jid?.includes('@g.us'));

    if (groupConvs.length > 0) {
      // Fire-and-forget with concurrency control: resolve group names in the
      // background so they don't block the conversation list response, but
      // limit parallelism to avoid exhausting the Prisma connection pool.
      void this.resolveGroupNames(profileId, groupConvs);
    }

    return {
      conversations: conversations.map((c) => {
        const jidPhone = c.jid?.split('@')[0] || '';
        const isGroup = c.type === 'group' || c.jid?.includes('@g.us');
        const resolvedName = isGroup ? null : (c.contact?.name || phoneToName[jidPhone] || null);
        
        // For groups: use stored DB name, fall back to 'Group Chat' for raw JIDs
        const isJidLikeName = !c.name || /^[0-9]+(@g\\.us|@s\\.whatsapp\\.net|@lid)?$/.test(c.name) || c.name === c.jid;
        const displayName = isGroup
          ? (isJidLikeName ? 'Group Chat' : c.name)
          : resolvedName;

        return {
          ...c,
          type: isGroup ? 'group' : c.type,
          messageCount: c._count.messages,
          lastMessage: lastMessageMap.get(c.id) || null,
          contactName: displayName,
          contactPhone: isGroup ? null : (c.contact?.phone || (c.jid?.includes('@s.whatsapp.net') ? jidPhone : null)),
          messages: undefined,
          _count: undefined,
          contact: undefined,
        };
      }),
      total,
    };
  }

  // Get conversation with recent messages
  async findOne(id: string, messageLimit = 50) {
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          take: messageLimit,
          orderBy: { timestamp: 'desc' },
        },
        contact: true,
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    
    // Reverse messages to chronological order
    conversation.messages.reverse();
    
    return conversation;
  }

  // Mark conversation as read
  async markAsRead(id: string) {
    await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    // Mark all messages as read
    await prisma.message.updateMany({
      where: { conversationId: id, status: { not: 'read' } },
      data: { status: 'read' },
    });

    return { success: true };
  }

  // Archive conversation
  async archive(id: string) {
    await prisma.conversation.update({
      where: { id },
      data: { metadata: { archived: true } },
    });
    return { success: true };
  }

  // Unarchive conversation
  async unarchive(id: string) {
    await prisma.conversation.update({
      where: { id },
      data: { metadata: { archived: false } },
    });
    return { success: true };
  }

  // Toggle mute conversation
  async toggleMute(id: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    const meta = (conversation.metadata as any) || {};
    const isMuted = !meta.isMuted;
    await prisma.conversation.update({
      where: { id },
      data: { metadata: { ...meta, isMuted } },
    });
    return { success: true, isMuted };
  }

  // Toggle pin conversation
  async togglePin(id: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    const meta = (conversation.metadata as any) || {};
    const isPinned = !meta.isPinned;
    await prisma.conversation.update({
      where: { id },
      data: { metadata: { ...meta, isPinned } },
    });
    return { success: true, isPinned };
  }

  // Clear all messages in conversation (without deleting the conversation)
  async clearMessages(id: string) {
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    await prisma.message.deleteMany({ where: { conversationId: id } });
    await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0, lastMessageAt: null },
    });
    return { success: true };
  }

  // Delete conversation and messages
  async delete(id: string) {
    await prisma.message.deleteMany({ where: { conversationId: id } });
    await prisma.conversation.delete({ where: { id } });
    return { success: true };
  }

  // Get messages with pagination
  async getMessages(id: string, options: { limit?: number; before?: string }) {
    const where: any = { conversationId: id };
    
    if (options.before) {
      const beforeMsg = await prisma.message.findUnique({
        where: { id: options.before },
        select: { timestamp: true },
      });
      if (beforeMsg) {
        where.timestamp = { lt: beforeMsg.timestamp };
      }
    }

    const messages = await prisma.message.findMany({
      where,
      take: options.limit || 50,
      orderBy: { timestamp: 'desc' },
    });

    // Reverse to chronological
    messages.reverse();

    return { messages: await this.withSenderNames(messages), hasMore: messages.length === (options.limit || 50) };
  }

  private async withSenderNames(messages: any[]) {
    if (messages.length === 0) return messages;

    const profileId = messages[0]?.profileId;
    const lidToPhone = new Map<string, string>();
    for (const message of messages) {
      const metadata = (message.metadata as any) || {};
      if (metadata.originalSenderJid?.includes('@lid') && metadata.senderPhone) {
        lidToPhone.set(metadata.originalSenderJid, metadata.senderPhone);
      }
      if (message.senderJid?.includes('@lid') && metadata.senderPhone) {
        lidToPhone.set(message.senderJid, metadata.senderPhone);
      }
    }

    const senderPhones = Array.from(new Set(messages
      .map((message) => {
        const metadata = (message.metadata as any) || {};
        return metadata.senderPhone || this.phoneFromJid(message.senderJid) || lidToPhone.get(message.senderJid);
      })
      .filter(Boolean)));

    const contacts = profileId && senderPhones.length > 0
      ? await prisma.contact.findMany({
          where: { profileId, phone: { in: senderPhones } },
          select: { phone: true, name: true, whatsappName: true, metadata: true },
        })
      : [];

    const contactNameByPhone = new Map(contacts.map((contact) => [contact.phone, this.bestContactName(contact)]));

    return messages.map((message) => {
      const metadata = (message.metadata as any) || {};
      const senderPhone = metadata.senderPhone || this.phoneFromJid(message.senderJid) || lidToPhone.get(message.senderJid);
      const metadataName = this.humanName(metadata.senderName) ? metadata.senderName : undefined;
      const senderName = metadataName || (senderPhone ? contactNameByPhone.get(senderPhone) : undefined);

      return {
        ...message,
        senderPhone,
        senderName: senderName || (senderPhone ? senderPhone : 'Unknown WhatsApp contact'),
      };
    });
  }

  private bestContactName(contact: { name?: string | null; whatsappName?: string | null; metadata?: any }) {
    return [
      contact.name,
      contact.whatsappName,
      contact.metadata?.pushName,
    ].find((name) => this.humanName(name));
  }

  private humanName(name?: string | null) {
    if (!name) return false;
    const normalized = name.trim();
    if (!normalized) return false;
    return !/^\+?\d+$/.test(normalized);
  }

  private phoneFromJid(jid?: string | null) {
    if (!jid || jid.includes('@g.us') || jid.includes('@lid')) return undefined;
    if (!/@(?:c\.us|s\.whatsapp\.net)$/i.test(jid)) return undefined;
    const digits = jid.replace(/\D/g, '');
    return digits || undefined;
  }

  // Get or create conversation
  async getOrCreate(profileId: string, jid: string, name?: string) {
    let conversation = await prisma.conversation.findFirst({
      where: { profileId, jid },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          profileId,
          jid,
          name: name || jid.split('@')[0],
          type: jid.includes('@g.us') ? 'group' : 'user',
        },
      });
    }

    return conversation;
  }

  // Increment unread count
  async incrementUnread(id: string) {
    await prisma.conversation.update({
      where: { id },
      data: { unreadCount: { increment: 1 }, lastMessageAt: new Date() },
    });
  }

  // Resolve group names from the WhatsApp engine and persist to DB.
  // Runs fire-and-forget from findAll() with concurrency control so the
  // conversation list is never blocked on engine network calls and the
  // Prisma connection pool is not exhausted by 100+ concurrent updates.
  // Silently skips disconnected engines.
  private async resolveGroupNames(profileId: string, groupConvs: any[]): Promise<void> {
    const CONCURRENCY = 5;
    const results: Promise<void>[] = [];

    for (let i = 0; i < groupConvs.length; i += CONCURRENCY) {
      const batch = groupConvs.slice(i, i + CONCURRENCY);
      const batchPromises = batch.map(async (gc) => {
        try {
          const groupInfo = await this.groupsService.getById(profileId, gc.jid);
          if (groupInfo?.name) {
            await prisma.conversation.update({
              where: { id: gc.id },
              data: { name: groupInfo.name },
            });
          }
        } catch {
          // Engine not connected or group not found — skip silently
        }
      });
      results.push(Promise.allSettled(batchPromises).then(() => {}));
    }

    await Promise.allSettled(results);
  }
}
