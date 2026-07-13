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
        name: 'Group Chat',
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
      contactName: 'Group Chat',
      contactPhone: null,
    });
    expect(groupsService.getById).toHaveBeenCalledWith('profile-1', '120000000000000001@g.us');
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-group' },
      data: { name: 'Synthetic Team' },
    }));
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it('limits background group title refreshes to five concurrent lookups', async () => {
    const groups = Array.from({ length: 6 }, (_, index) => ({
      id: `conv-group-${index}`,
      profileId: 'profile-1',
      jid: `12000000000000000${index}@g.us`,
      name: 'Group Chat',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    }));
    const resolveLookups: Array<(value: any) => void> = [];

    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce(groups as any);
    vi.mocked(prisma.conversation.count).mockResolvedValueOnce(groups.length);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    groupsService.getById.mockImplementation((_profileId, groupId) => new Promise(resolve => {
      resolveLookups.push(resolve);
    }));

    await service.findAll('profile-1', {});

    expect(groupsService.getById).toHaveBeenCalledTimes(5);

    resolveLookups.forEach((resolve, index) => resolve({
      id: groups[index].jid,
      name: `Synthetic Team ${index}`,
      participants: [],
    }));
    await vi.waitFor(() => expect(groupsService.getById).toHaveBeenCalledTimes(6));
    resolveLookups[5]({ id: groups[5].jid, name: 'Synthetic Team 5', participants: [] });
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledTimes(6));
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
  });

  it('deduplicates overlapping background refreshes for the same group', async () => {
    const group = {
      id: 'conv-group',
      profileId: 'profile-1',
      jid: '120000000000000001@g.us',
      name: 'Group Chat',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    };
    let resolveLookup: (value: any) => void = () => {};

    vi.mocked(prisma.conversation.findMany).mockResolvedValue([group] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValue(1);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    groupsService.getById.mockImplementation(() => new Promise(resolve => {
      resolveLookup = resolve;
    }));

    await Promise.all([
      service.findAll('profile-1', {}),
      service.findAll('profile-1', {}),
    ]);

    expect(groupsService.getById).toHaveBeenCalledTimes(1);

    resolveLookup({ id: group.jid, name: 'Synthetic Team', participants: [] });
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
  });

  it('queues different unresolved groups from overlapping requests', async () => {
    const firstGroup = {
      id: 'conv-group-1',
      profileId: 'profile-1',
      jid: '120000000000000001@g.us',
      name: 'Group Chat',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    };
    const secondGroup = {
      ...firstGroup,
      id: 'conv-group-2',
      jid: '120000000000000002@g.us',
    };
    let resolveFirstLookup: (value: any) => void = () => {};

    vi.mocked(prisma.conversation.findMany)
      .mockResolvedValueOnce([firstGroup] as any)
      .mockResolvedValueOnce([secondGroup] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValue(1);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    groupsService.getById
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirstLookup = resolve;
      }))
      .mockResolvedValueOnce({ id: secondGroup.jid, name: 'Synthetic Team 2', participants: [] });

    await service.findAll('profile-1', {});
    await service.findAll('profile-1', {});

    expect(groupsService.getById).toHaveBeenCalledTimes(2);

    resolveFirstLookup({ id: firstGroup.jid, name: 'Synthetic Team 1', participants: [] });
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
  });

  it('releases failed group refreshes so a later request can retry', async () => {
    const group = {
      id: 'conv-group',
      profileId: 'profile-1',
      jid: '120000000000000001@g.us',
      name: 'Group Chat',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    };

    vi.mocked(prisma.conversation.findMany).mockResolvedValue([group] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValue(1);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    groupsService.getById
      .mockRejectedValueOnce(new Error('synthetic lookup failure'))
      .mockResolvedValueOnce({ id: group.jid, name: 'Synthetic Team', participants: [] });

    await service.findAll('profile-1', {});
    await vi.waitFor(() => expect(groupsService.getById).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
    await service.findAll('profile-1', {});

    await vi.waitFor(() => expect(groupsService.getById).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(prisma.conversation.update).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
  });

  it('fills freed concurrency slots while another lookup remains unresolved', async () => {
    const initialGroups = Array.from({ length: 5 }, (_, index) => ({
      id: `conv-group-${index}`,
      profileId: 'profile-1',
      jid: `12000000000000000${index}@g.us`,
      name: 'Group Chat',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    }));
    const queuedGroups = Array.from({ length: 4 }, (_, index) => ({
      ...initialGroups[0],
      id: `conv-queued-${index}`,
      jid: `12000000000000010${index}@g.us`,
    }));
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let active = 0;
    let maxActive = 0;

    vi.mocked(prisma.conversation.findMany)
      .mockResolvedValueOnce(initialGroups as any)
      .mockResolvedValueOnce(queuedGroups as any);
    vi.mocked(prisma.conversation.count).mockResolvedValue(9);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    groupsService.getById.mockImplementation((_profileId, groupId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve, reject) => {
        pending.set(groupId, {
          resolve: (value) => {
            active -= 1;
            resolve(value);
          },
          reject: (error) => {
            active -= 1;
            reject(error);
          },
        });
      });
    });

    await service.findAll('profile-1', {});
    await service.findAll('profile-1', {});

    expect(groupsService.getById).toHaveBeenCalledTimes(5);
    for (const group of initialGroups.slice(1)) {
      pending.get(group.jid)?.resolve({ id: group.jid, name: `Resolved ${group.id}`, participants: [] });
    }

    await vi.waitFor(() => expect(groupsService.getById).toHaveBeenCalledTimes(9));
    expect(active).toBe(5);
    expect(maxActive).toBe(5);

    pending.get(initialGroups[0].jid)?.reject(new Error('synthetic protocol timeout'));
    for (const group of queuedGroups) {
      pending.get(group.jid)?.resolve({ id: group.jid, name: `Resolved ${group.id}`, participants: [] });
    }
    await vi.waitFor(() => expect((service as any).groupNameRefreshes.size).toBe(0));
  });

  it('does not refresh a group that already has a resolved title', async () => {
    const group = {
      id: 'conv-group',
      profileId: 'profile-1',
      jid: '120000000000000001@g.us',
      name: 'Synthetic Team',
      type: 'group',
      contact: null,
      _count: { messages: 0 },
    };

    vi.mocked(prisma.conversation.findMany).mockResolvedValueOnce([group] as any);
    vi.mocked(prisma.conversation.count).mockResolvedValueOnce(1);
    vi.mocked(prisma.$queryRawUnsafe).mockResolvedValueOnce([] as any);

    const result = await service.findAll('profile-1', {});

    expect(result.conversations[0].contactName).toBe('Synthetic Team');
    expect(groupsService.getById).not.toHaveBeenCalled();
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
