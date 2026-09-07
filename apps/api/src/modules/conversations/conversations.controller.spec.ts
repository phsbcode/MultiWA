import { describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    profile: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { Reflector } from '@nestjs/core';
import { ConversationsController } from './conversations.controller';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MessageContextQueryDto, SearchMessagesQueryDto } from './dto/message-history-query.dto';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { TENANT_CHECKS } from '../../common/tenant/require-tenant.decorator';

const mutationHandlers = [
  'markAsRead',
  'archive',
  'unarchive',
  'toggleMute',
  'togglePin',
  'clearMessages',
  'delete',
] as const;

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

  it.each(mutationHandlers)('declares conversation ownership for %s', handler => {
    expect(Reflect.getMetadata(TENANT_CHECKS, ConversationsController.prototype[handler]))
      .toEqual([{ resource: 'conversation', from: 'param', key: 'id' }]);
  });

  it.each(mutationHandlers)('does not invoke %s when conversation ownership fails', async handler => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce(null);
    const mutationService = { [handler]: vi.fn() };
    const controller = new ConversationsController(mutationService as any);
    const requestWithForeignConversation = {
      user: { organizationId: 'org-a' },
      params: { id: 'conversation-b' },
    };
    const context = {
      getHandler: () => ConversationsController.prototype[handler],
      getClass: () => ConversationsController,
      switchToHttp: () => ({ getRequest: () => requestWithForeignConversation }),
    };

    await expect(new TenantGuard(new Reflector()).canActivate(context as any))
      .rejects.toThrow('Resource not found.');
    expect(mutationService[handler]).not.toHaveBeenCalled();
  });
});
