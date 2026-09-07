import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '@multiwa/database';
import { MessagesService } from './messages.service';

describe('MessagesService local access', () => {
  const engineManager = { getEngine: vi.fn() };
  let service: MessagesService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new MessagesService(engineManager as any);
  });

  it('scopes the cursor to the selected conversation and preserves chronological output', async () => {
    vi.mocked(prisma.message.findFirst).mockResolvedValueOnce({
      timestamp: new Date('2026-09-07T01:02:00Z'),
    } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValueOnce([
      { id: 'message-2', timestamp: new Date('2026-09-07T01:01:00Z') },
      { id: 'message-1', timestamp: new Date('2026-09-07T01:00:00Z') },
    ] as any);

    const result = await service.findByConversation('conversation-a', {
      limit: 2,
      before: 'cursor-a',
    });

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { id: 'cursor-a', conversationId: 'conversation-a' },
      select: { timestamp: true },
    });
    expect(result).toEqual({
      messages: [
        { id: 'message-1', timestamp: new Date('2026-09-07T01:00:00Z') },
        { id: 'message-2', timestamp: new Date('2026-09-07T01:01:00Z') },
      ],
      hasMore: true,
    });
    expect(engineManager.getEngine).not.toHaveBeenCalled();
  });

  it.each(['same-organization cursor', 'foreign cursor', 'missing cursor'])(
    'rejects %s outside the selected conversation',
    async () => {
      vi.mocked(prisma.message.findFirst).mockResolvedValueOnce(null);

      await expect(service.findByConversation('conversation-a', {
        limit: 20,
        before: 'cursor-b',
      })).rejects.toThrow('Pagination cursor not found.');
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(engineManager.getEngine).not.toHaveBeenCalled();
    },
  );

  it('returns a local message with its conversation without provider access', async () => {
    const message = { id: 'message-a', profileId: 'profile-a',
      conversation: { id: 'conversation-a', profileId: 'profile-a' } };
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce(message as any);

    await expect(service.findOne('message-a')).resolves.toEqual(message);
    expect(prisma.message.findUnique).toHaveBeenCalledWith({
      where: { id: 'message-a' }, include: { conversation: true },
    });
    expect(engineManager.getEngine).not.toHaveBeenCalled();
  });

  it('deletes only the selected local message without provider access', async () => {
    vi.mocked(prisma.message.findUnique).mockResolvedValueOnce({ id: 'message-a',
      conversation: { id: 'conversation-a' } } as any);
    vi.mocked(prisma.message.delete).mockResolvedValueOnce({ id: 'message-a' } as any);

    await expect(service.delete('message-a')).resolves.toEqual({ success: true });
    expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'message-a' } });
    expect(engineManager.getEngine).not.toHaveBeenCalled();
  });
});
