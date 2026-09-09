import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@multiwa/database', () => ({ prisma: {
  profile: { findFirst: vi.fn() }, conversation: { findFirst: vi.fn() },
  message: { findFirst: vi.fn() },
} }));
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { prisma } from '@multiwa/database';
import { TENANT_CHECKS } from '../../common/tenant/require-tenant.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuditService } from '../audit/audit.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';
import { SendReactionDto, SendReplyDto, SendTextDto } from './dto';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

const routes = [
  { handler: 'sendText', path: 'text', dto: SendTextDto,
    body: { profileId: 'profile-a', to: '60111111111', text: 'Synthetic text' } },
  { handler: 'sendReply', path: 'reply', dto: SendReplyDto,
    body: { profileId: 'profile-a', quotedMessageId: 'quoted-local', text: 'Synthetic reply' } },
  { handler: 'sendReaction', path: 'reaction', dto: SendReactionDto,
    body: { profileId: 'profile-a', messageId: 'reaction-local', emoji: 'ok' } },
] as const;

describe('MessagesController reference-send authorization', () => {
  let app: NestFastifyApplication;
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = Object.fromEntries(routes.map(route => [route.handler, vi.fn()])) as
    Record<string, ReturnType<typeof vi.fn>>;
  beforeAll(async () => {
    routes.forEach(route => Reflect.defineMetadata('design:paramtypes', [route.dto],
      MessagesController.prototype, route.handler));
    const module = await Test.createTestingModule({ controllers: [MessagesController], providers: [
      { provide: MessagesService, useValue: service },
      { provide: AuditService, useValue: audit },
    ] }).overrideGuard(JwtOrApiKeyGuard).useValue({ canActivate(context: any) {
      context.switchToHttp().getRequest().user = { organizationId: 'org-a' }; return true;
    } }).overrideGuard(TenantGuard).useValue(new TenantGuard(new Reflector())).compile();
    (module.get(MessagesController) as any).service = service;
    (module.get(MessagesController) as any).auditService = audit;
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true,
      transformOptions: { enableImplicitConversion: true } }));
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => vi.clearAllMocks());

  it.each(routes)('declares exact body profile ownership for $handler', route => {
    expect(Reflect.getMetadata(TENANT_CHECKS,
      MessagesController.prototype[route.handler] as any)).toEqual([
      { resource: 'profile', from: 'body', key: 'profileId' },
    ]);
  });
  it.each(routes)('blocks foreign $handler before validation and service', async route => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValueOnce(null);
    const response = await app.inject({ method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: { profileId: 'profile-b' } });
    expect(response.statusCode).toBe(404);
    expect(service[route.handler]).not.toHaveBeenCalled();
  });
  it.each(routes)('passes an owned valid $handler DTO once', async route => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValueOnce({ id: 'profile-a' } as any);
    service[route.handler].mockResolvedValueOnce({ success: true });
    const response = await app.inject({ method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: route.body });
    expect(response.statusCode).toBe(201);
    expect(service[route.handler]).toHaveBeenCalledOnce();
    expect(service[route.handler]).toHaveBeenCalledWith(expect.objectContaining(route.body));
  });
  it.each(routes)('rejects an owned invalid $handler DTO before service', async route => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValueOnce({ id: 'profile-a' } as any);
    const response = await app.inject({ method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: { profileId: 'profile-a' } });
    expect(response.statusCode).toBe(400);
    expect(service[route.handler]).not.toHaveBeenCalled();
  });
});
