import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    conversation: {
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
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
    vi.mocked(prisma.conversation.count).mockReset();
    vi.mocked(prisma.conversation.update).mockReset();
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
});
