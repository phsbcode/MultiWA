import { describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: { profile: { findFirst: vi.fn() } },
}));

import { prisma } from '@multiwa/database';
import { ConversationsController } from './conversations.controller';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MessageContextQueryDto, SearchMessagesQueryDto } from './dto/message-history-query.dto';

describe('ConversationsController message history authorization', () => {
  const service = { searchMessages: vi.fn(), getMessageContext: vi.fn() };
  const request = { user: { organizationId: 'org-1' } };

  it('allows search when the authenticated principal can access the profile', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({ id: 'profile-1' } as any);
    service.searchMessages.mockResolvedValue({ messages: [] });
    const controller = new ConversationsController(service as any);

    await controller.searchMessages('conv-1', request, { profileId: 'profile-1', q: 'invoice', limit: 25 });

    expect(service.searchMessages).toHaveBeenCalledWith('conv-1', 'profile-1', { query: 'invoice', limit: 25, cursor: undefined });
  });

  it('rejects context access to a profile outside the authenticated organization', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
    const controller = new ConversationsController(service as any);

    await expect(controller.getMessageContext('conv-1', 'msg-1', request, {
      profileId: 'profile-elsewhere', before: 10, after: 10,
    })).rejects.toThrow('Profile not found');
    expect(service.getMessageContext).not.toHaveBeenCalled();
  });

  it('rejects out-of-bounds search and context query values', async () => {
    const search = plainToInstance(SearchMessagesQueryDto, { profileId: 'profile-1', q: '', limit: 101 });
    const context = plainToInstance(MessageContextQueryDto, { profileId: 'profile-1', before: -1, after: 51 });

    expect((await validate(search)).map(error => error.property)).toEqual(expect.arrayContaining(['q', 'limit']));
    expect((await validate(context)).map(error => error.property)).toEqual(expect.arrayContaining(['before', 'after']));
  });
});