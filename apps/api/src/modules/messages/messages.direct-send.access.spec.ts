import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    profile: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn() },
  },
}));

import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { prisma } from '@multiwa/database';
import { TENANT_CHECKS } from '../../common/tenant/require-tenant.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuditService } from '../audit/audit.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';

const routes = [
  { handler: 'sendImage', path: 'image', body: { profileId: 'profile-a', to: '60111111111', base64: 'aGVsbG8=' } },
  { handler: 'sendVideo', path: 'video', body: { profileId: 'profile-a', to: '60111111112', base64: 'aGVsbG8=' } },
  { handler: 'sendAudio', path: 'audio', body: { profileId: 'profile-a', to: '60111111113', base64: 'aGVsbG8=', ptt: true } },
  { handler: 'sendDocument', path: 'document', body: { profileId: 'profile-a', to: '60111111114', base64: 'aGVsbG8=', filename: 'synthetic.pdf' } },
  { handler: 'sendLocation', path: 'location', body: { profileId: 'profile-a', to: '60111111115', latitude: 3.1, longitude: 101.7 } },
  { handler: 'sendContact', path: 'contact', body: { profileId: 'profile-a', to: '60111111116', contacts: [{ name: 'Synthetic Contact', phone: '60111111117' }] } },
  { handler: 'sendPoll', path: 'poll', body: { profileId: 'profile-a', to: '60111111118', question: 'Synthetic choice?', options: ['One', 'Two'] } },
] as const;

describe('MessagesController routed direct-send authorization', () => {
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
        const request = context.switchToHttp().getRequest();
        request.user = request.headers['x-test-no-org'] ? {} : { organizationId: 'org-a' };
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

  it.each(routes)('declares exact profile ownership for $handler', route => {
    expect(Reflect.getMetadata(TENANT_CHECKS,
      MessagesController.prototype[route.handler] as any)).toEqual([
      { resource: 'profile', from: 'body', key: 'profileId' },
    ]);
  });

  it.each(routes)('blocks foreign $handler before DTO validation or service execution', async route => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValueOnce(null);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: { profileId: 'profile-b' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, message: 'Resource not found.' });
    expect(service[route.handler]).not.toHaveBeenCalled();
  });

  it.each(routes)('invokes $handler once for an owned profile', async route => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValueOnce({ id: 'profile-a' } as any);
    service[route.handler].mockResolvedValueOnce({ success: true, status: 'sent' });
    const response = await app.inject({
      method: 'POST', url: `/api/v1/messages/${route.path}`, payload: route.body,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ success: true, status: 'sent' });
    expect(service[route.handler]).toHaveBeenCalledOnce();
    expect(service[route.handler]).toHaveBeenCalledWith(expect.objectContaining(route.body));
  });

  it.each(routes)('rejects missing $handler profile before service execution', async route => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: { ...route.body, profileId: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(service[route.handler]).not.toHaveBeenCalled();
  });

  it.each(routes)('rejects non-string $handler profile before service execution', async route => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/messages/${route.path}`,
      payload: { ...route.body, profileId: ['profile-a'] },
    });
    expect(response.statusCode).toBe(400);
    expect(service[route.handler]).not.toHaveBeenCalled();
  });

  it.each(routes)('denies $handler without organization context', async route => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/messages/${route.path}`,
      headers: { 'x-test-no-org': '1' }, payload: route.body,
    });
    expect(response.statusCode).toBe(403);
    expect(service[route.handler]).not.toHaveBeenCalled();
  });
});
