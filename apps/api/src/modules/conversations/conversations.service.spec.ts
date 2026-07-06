import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    contact: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@multiwa/database';
import { ConversationsService } from './conversations.service';

describe('ConversationsService', () => {
  let service: ConversationsService;
  const groupsService = {
    getById: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(prisma.conversation.findMany).mockReset();
    vi.mocked(prisma.conversation.findUnique).mockReset();
    vi.mocked(prisma.conversation.count).mockReset();
    vi.mocked(prisma.conversation.update).mockReset();
    vi.mocked(prisma.message.findMany).mockReset();
    vi.mocked(prisma.message.findUnique).mockReset();
    vi.mocked(prisma.contact.findMany).mockReset();
    groupsService.getById.mockReset();
    service = new ConversationsService(groupsService as any);
  });

  it('uses engine group title instead of stale sender name for group conversations', async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        id: 'conv-group',
        profileId: 'profile-1',
        jid: '120363373411642286@g.us',
        name: 'Ali Sender',
        type: 'user',
        contact: { name: 'Ali Sender', phone: '60123456789' },
        messages: [{ id: 'msg-1', content: { text: 'hello' }, timestamp: new Date() }],
        _count: { messages: 1 },
      },
    ] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValueOnce(1);
    groupsService.getById.mockResolvedValueOnce({
      id: '120363373411642286@g.us',
      name: 'Ops Team',
      participants: [],
    });

    const result = await service.findAll('profile-1', {});

    expect(result.conversations[0]).toMatchObject({
      id: 'conv-group',
      jid: '120363373411642286@g.us',
      type: 'group',
      contactName: 'Ops Team',
      contactPhone: null,
    });
    expect(groupsService.getById).toHaveBeenCalledWith('profile-1', '120363373411642286@g.us');
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-group' },
      data: { name: 'Ops Team' },
    });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('adds senderName to messages from metadata or contact lookup', async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      {
        id: 'msg-2',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '60122222222@s.whatsapp.net',
        metadata: {},
        timestamp: new Date('2026-07-05T02:00:00Z'),
      },
      {
        id: 'msg-lid-old',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '111111111111@lid',
        metadata: {},
        timestamp: new Date('2026-07-05T01:30:00Z'),
      },
      {
        id: 'msg-1',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '2061718544578@lid',
        metadata: { senderName: 'AzwaHanee', senderPhone: '60111111111' },
        timestamp: new Date('2026-07-05T01:00:00Z'),
      },
      {
        id: 'msg-lid-mapped',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '60133333333@s.whatsapp.net',
        metadata: { senderPhone: '60133333333', originalSenderJid: '111111111111@lid' },
        timestamp: new Date('2026-07-05T00:30:00Z'),
      },
    ] as any);
    vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([
      { phone: '60122222222', name: '60122222222', whatsappName: 'Dayana', metadata: {} },
      { phone: '60133333333', name: '60133333333', whatsappName: '60133333333', metadata: { pushName: 'M.I.R' } },
    ] as any);

    const result = await service.getMessages('conv-group', {});

    expect(result.messages).toMatchObject([
      { id: 'msg-lid-mapped', senderName: 'M.I.R', senderPhone: '60133333333' },
      { id: 'msg-1', senderName: 'AzwaHanee', senderPhone: '60111111111' },
      { id: 'msg-lid-old', senderName: 'M.I.R', senderPhone: '60133333333' },
      { id: 'msg-2', senderName: 'Dayana', senderPhone: '60122222222' },
    ]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { profileId: 'profile-1', phone: { in: expect.arrayContaining(['60122222222', '60111111111', '60133333333']) } },
      select: { phone: true, name: true, whatsappName: true, metadata: true },
    });
  });
});
