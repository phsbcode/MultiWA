import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    conversation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
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
    vi.mocked(prisma.$queryRawUnsafe).mockReset();
    vi.mocked(prisma.conversation.findMany).mockReset();
    vi.mocked(prisma.conversation.findUnique).mockReset();
    vi.mocked(prisma.conversation.findFirst).mockReset();
    vi.mocked(prisma.conversation.count).mockReset();
    vi.mocked(prisma.conversation.update).mockReset();
    vi.mocked(prisma.message.findMany).mockReset();
    vi.mocked(prisma.message.findFirst).mockReset();
    vi.mocked(prisma.message.findUnique).mockReset();
    vi.mocked(prisma.contact.findMany).mockReset();
    groupsService.getById.mockReset();
    service = new ConversationsService(groupsService as any);
  });

  it('refreshes a stale group title in the background for the next conversation load', async () => {
    vi.mocked(prisma.$queryRawUnsafe)
      .mockResolvedValueOnce([{ conversationId: 'conv-group', id: 'msg-1' }] as any)
      .mockResolvedValueOnce([{ id: 'msg-1', conversationId: 'conv-group', content: '{"text":"synthetic group message"}', metadata: '{}' }] as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([
      {
        id: 'conv-group',
        profileId: 'profile-1',
        jid: '120000000000000001@g.us',
        name: 'Synthetic Group',
        type: 'user',
        contact: { name: 'Synthetic Group', phone: '10000000001' },
        messages: [{ id: 'msg-1', content: { text: 'synthetic group message' }, timestamp: new Date('2026-01-01T00:00:00Z') }],
        _count: { messages: 1 },
      },
    ] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValueOnce(1);
    groupsService.getById.mockResolvedValueOnce({
      id: '120000000000000001@g.us',
      name: 'Synthetic Team',
      participants: [],
    });

    const result = await service.findAll('profile-1', {});

    expect(result.conversations[0]).toMatchObject({
      id: 'conv-group',
      jid: '120000000000000001@g.us',
      type: 'group',
      contactName: 'Synthetic Group',
      contactPhone: null,
    });
    expect(groupsService.getById).toHaveBeenCalledWith('profile-1', '120000000000000001@g.us');
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-group' },
      data: { name: 'Synthetic Team' },
    }));
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('adds senderName to messages from metadata or contact lookup', async () => {
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      {
        id: 'msg-2',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '10000000002@s.whatsapp.net',
        metadata: {},
        timestamp: new Date('2026-07-05T02:00:00Z'),
      },
      {
        id: 'msg-lid-old',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '900000000001@lid',
        metadata: {},
        timestamp: new Date('2026-07-05T01:30:00Z'),
      },
      {
        id: 'msg-1',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '900000000002@lid',
        metadata: { senderName: 'Synthetic Sender A', senderPhone: '10000000001' },
        timestamp: new Date('2026-07-05T01:00:00Z'),
      },
      {
        id: 'msg-lid-mapped',
        profileId: 'profile-1',
        conversationId: 'conv-group',
        direction: 'incoming',
        senderJid: '10000000003@s.whatsapp.net',
        metadata: { senderPhone: '10000000003', originalSenderJid: '900000000001@lid' },
        timestamp: new Date('2026-07-05T00:30:00Z'),
      },
    ] as any);
    vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([
      { phone: '10000000002', name: '10000000002', whatsappName: 'Synthetic Contact B', metadata: {} },
      { phone: '10000000003', name: '10000000003', whatsappName: '10000000003', metadata: { pushName: 'Synthetic Contact C' } },
    ] as any);

    const result = await service.getMessages('conv-group', {});

    expect(result.messages).toMatchObject([
      { id: 'msg-lid-mapped', senderName: 'Synthetic Contact C', senderPhone: '10000000003' },
      { id: 'msg-1', senderName: 'Synthetic Sender A', senderPhone: '10000000001' },
      { id: 'msg-lid-old', senderName: 'Synthetic Contact C', senderPhone: '10000000003' },
      { id: 'msg-2', senderName: 'Synthetic Contact B', senderPhone: '10000000002' },
    ]);
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { profileId: 'profile-1', phone: { in: expect.arrayContaining(['10000000002', '10000000001', '10000000003']) } },
      select: { phone: true, name: true, whatsappName: true, metadata: true },
    });
  });

  it('searches text, captions, and filenames only inside the requested profile conversation', async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({ id: 'conv-1', profileId: 'profile-1' } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      { id: 'msg-3', profileId: 'profile-1', conversationId: 'conv-1', senderJid: '10000000004@s.whatsapp.net', content: { caption: 'sample caption' }, timestamp: new Date('2026-01-03T00:00:00Z') },
      { id: 'msg-2', profileId: 'profile-1', conversationId: 'conv-1', senderJid: '10000000004@s.whatsapp.net', content: { filename: 'sample-document.pdf' }, timestamp: new Date('2026-01-02T00:00:00Z') },
      { id: 'msg-1', profileId: 'profile-1', conversationId: 'conv-1', senderJid: '10000000004@s.whatsapp.net', content: { text: 'sample text' }, timestamp: new Date('2026-01-01T00:00:00Z') },
    ] as any);
    vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([]);

    const result = await service.searchMessages('conv-1', 'profile-1', { query: 'sample', limit: 2 });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({ where: { id: 'conv-1', profileId: 'profile-1' }, select: { id: true } });
    expect(prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        conversationId: 'conv-1',
        profileId: 'profile-1',
        OR: expect.arrayContaining([
          { content: { path: ['text'], string_contains: 'sample', mode: 'insensitive' } },
          { content: { path: ['caption'], string_contains: 'sample', mode: 'insensitive' } },
          { content: { path: ['filename'], string_contains: 'sample', mode: 'insensitive' } },
        ]),
      }),
      take: 3,
    }));
    expect(result).toMatchObject({
      messages: [{ id: 'msg-3' }, { id: 'msg-2' }],
      hasMore: true,
      nextCursor: 'msg-2',
    });
  });

  it('returns a chronological context window scoped to the profile conversation', async () => {
    const target = { id: 'target', profileId: 'profile-1', conversationId: 'conv-1', senderJid: '10000000005@s.whatsapp.net', content: { text: 'synthetic target message' }, timestamp: new Date('2026-01-02T00:00:00Z') };
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({ id: 'conv-1' } as any);
    vi.mocked(prisma.message.findFirst).mockResolvedValueOnce(target as any);
    vi.mocked(prisma.message.findMany)
      .mockResolvedValueOnce([{ ...target, id: 'before', timestamp: new Date('2026-01-01T00:00:00Z') }] as any)
      .mockResolvedValueOnce([{ ...target, id: 'after', timestamp: new Date('2026-01-03T00:00:00Z') }] as any);
    vi.mocked(prisma.contact.findMany).mockResolvedValueOnce([]);

    const result = await service.getMessageContext('conv-1', 'target', 'profile-1', { before: 1, after: 1 });

    expect(result.messages.map(message => message.id)).toEqual(['before', 'target', 'after']);
    expect(prisma.message.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'target', conversationId: 'conv-1', profileId: 'profile-1' } }));
  });
});
