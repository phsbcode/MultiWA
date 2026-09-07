import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    profile: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { AuditService } from '../audit/audit.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { TENANT_CHECKS } from '../../common/tenant/require-tenant.decorator';

const routes = [
  { handler: 'findByConversation', method: 'GET', path: 'conversation/conversation-a',
    check: { resource: 'conversation', from: 'param', key: 'conversationId' },
    expected: { messages: [], hasMore: false }, args: ['conversation-a', { limit: undefined, before: undefined }] },
  { handler: 'findOne', method: 'GET', path: 'message-a',
    check: { resource: 'message', from: 'param', key: 'id' },
    expected: { id: 'message-a' }, args: ['message-a'] },
  { handler: 'delete', method: 'DELETE', path: 'message-a',
    check: { resource: 'message', from: 'param', key: 'id' },
    expected: { success: true }, args: ['message-a'] },
] as const;

describe('MessagesController routed local access authorization', () => {
  let app: NestFastifyApplication;
  const service = Object.fromEntries(routes.map(route => [route.handler, vi.fn()])) as
    Record<string, ReturnType<typeof vi.fn>>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [
        { provide: MessagesService, useValue: service },
        { provide: AuditService, useValue: { log: vi.fn() } },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({ canActivate(context: any) {
        context.switchToHttp().getRequest().user = { organizationId: 'org-a' };
        return true;
      } })
      .overrideGuard(TenantGuard)
      .useValue(new TenantGuard(new Reflector()))
      .compile();
    (module.get(MessagesController) as any).service = service;
    (module.get(MessagesController) as any).auditService = { log: vi.fn() };
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => { await app.close(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(routes)('declares exact ownership for $handler', ({ handler, check }) => {
    expect(Reflect.getMetadata(TENANT_CHECKS,
      MessagesController.prototype[handler] as any)).toEqual([check]);
  });

  it.each(routes)('blocks $handler before service execution', async route => {
    if (route.check.resource === 'conversation') {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce(null);
    } else {
      vi.mocked(prisma.message.findFirst).mockResolvedValueOnce(null);
    }
    const response = await app.inject({ method: route.method, url: `/api/v1/messages/${route.path}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, message: 'Resource not found.' });
    expect(service[route.handler]).not.toHaveBeenCalled();
  });

  it.each(routes)('invokes $handler once after ownership succeeds', async route => {
    if (route.check.resource === 'conversation') {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({ id: 'conversation-a' } as any);
    } else {
      vi.mocked(prisma.message.findFirst).mockResolvedValueOnce({ id: 'message-a',
        profileId: 'profile-a', conversation: { profileId: 'profile-a' } } as any);
    }
    service[route.handler].mockResolvedValueOnce(route.expected);
    const response = await app.inject({ method: route.method, url: `/api/v1/messages/${route.path}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(route.expected);
    expect(service[route.handler]).toHaveBeenCalledOnce();
    expect(service[route.handler]).toHaveBeenCalledWith(...route.args);
  });

  it('uses production query conversion for an explicit conversation limit', async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({ id: 'conversation-a' } as any);
    service.findByConversation.mockResolvedValueOnce({ messages: [], hasMore: false });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/conversation/conversation-a?limit=2&before=message-before',
    });

    expect(response.statusCode).toBe(200);
    expect(service.findByConversation).toHaveBeenCalledOnce();
    expect(service.findByConversation).toHaveBeenCalledWith('conversation-a', {
      limit: 2,
      before: 'message-before',
    });
  });

  it('rejects a non-integer conversation limit before service execution', async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({ id: 'conversation-a' } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/messages/conversation/conversation-a?limit=word',
    });

    expect(response.statusCode).toBe(400);
    expect(service.findByConversation).not.toHaveBeenCalled();
  });

  it.each(['findOne', 'delete'])('blocks inconsistent message parentage for %s', async handler => {
    vi.mocked(prisma.message.findFirst).mockResolvedValueOnce({ id: 'message-a',
      profileId: 'profile-a', conversation: { profileId: 'profile-b' } } as any);
    const method = handler === 'delete' ? 'DELETE' : 'GET';
    const response = await app.inject({ method, url: '/api/v1/messages/message-a' });
    expect(response.statusCode).toBe(404);
    expect(service[handler]).not.toHaveBeenCalled();
  });
});
