import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    profile: { findFirst: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { EventsGateway } from './events.gateway';

describe('EventsGateway', () => {
  const jwtService = { verifyAsync: vi.fn() };

  beforeEach(() => vi.clearAllMocks());

  it('emits normalized presence only to the matching profile room', () => {
    const gateway = new EventsGateway(jwtService as any);
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    gateway.server = { to } as any;

    const presence = {
      profileId: 'profile-1',
      conversationId: 'conversation-1',
      chatJid: '60111@s.whatsapp.net',
      participantJid: '60111@s.whatsapp.net',
      state: 'composing',
      timestamp: '2026-07-13T10:00:00.000Z',
    };

    gateway.emitPresence('profile-1', presence);

    expect(to).toHaveBeenCalledWith('profile:profile-1');
    expect(emit).toHaveBeenCalledWith('presence:update', presence);
  });

  it('rejects a Socket.IO connection without valid credentials', async () => {
    const gateway = new EventsGateway(jwtService as any);
    let middleware: any;
    gateway.afterInit({ use: vi.fn((fn) => { middleware = fn; }) } as any);
    const next = vi.fn();

    await middleware({ handshake: { auth: {}, headers: {}, query: {} }, data: {} }, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unauthorized' }));
  });

  it('authenticates a JWT connection and allows joining an owned organization profile', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', isActive: true, organizationId: 'org-1' } as any);
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({ id: 'profile-1' } as any);
    const gateway = new EventsGateway(jwtService as any);
    let middleware: any;
    gateway.afterInit({ use: vi.fn((fn) => { middleware = fn; }) } as any);
    const client: any = {
      id: 'socket-1',
      handshake: { auth: { token: 'jwt-token' }, headers: {}, query: {} },
      data: {},
      join: vi.fn(),
      emit: vi.fn(),
    };
    const next = vi.fn();

    await middleware(client, next);
    const result = await gateway.handleJoin(client, { profileId: 'profile-1' });

    expect(next).toHaveBeenCalledWith();
    expect(client.data.principal).toMatchObject({ id: 'user-1', organizationId: 'org-1' });
    expect(prisma.profile.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'profile-1', workspace: { organizationId: 'org-1' } },
    }));
    expect(client.join).toHaveBeenCalledWith('profile:profile-1');
    expect(result).toEqual({ success: true, profileId: 'profile-1' });
  });

  it('authenticates an API key connection as its owning user', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue({
      id: 'key-1', expiresAt: null, user: { id: 'user-1', isActive: true, organizationId: 'org-1' },
    } as any);
    vi.mocked(prisma.apiKey.update).mockResolvedValue({} as any);
    const gateway = new EventsGateway(jwtService as any);
    let middleware: any;
    gateway.afterInit({ use: vi.fn((fn) => { middleware = fn; }) } as any);
    const client: any = { handshake: { auth: { apiKey: 'secret-key' }, headers: {}, query: {} }, data: {} };
    const next = vi.fn();

    await middleware(client, next);

    expect(next).toHaveBeenCalledWith();
    expect(client.data.principal).toEqual({ id: 'user-1', organizationId: 'org-1', apiKeyId: 'key-1' });
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { keyHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }));
  });

  it('rejects joining a profile outside the authenticated organization', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
    const gateway = new EventsGateway(jwtService as any);
    const client: any = {
      id: 'socket-1',
      data: { principal: { id: 'user-1', organizationId: 'org-1' } },
      join: vi.fn(),
      emit: vi.fn(),
    };

    await expect(gateway.handleJoin(client, { profileId: 'profile-elsewhere' })).rejects.toThrow('Profile access denied');
    expect(client.join).not.toHaveBeenCalled();
  });

  it('expires cached pairing QR codes after two minutes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
      const gateway = new EventsGateway(jwtService as any);
      gateway.server = { to: vi.fn(() => ({ emit: vi.fn() })) } as any;

      gateway.emitQrUpdate('profile-1', 'data:image/png;base64,TEST');
      expect(gateway.getCachedQr('profile-1')).toBe('data:image/png;base64,TEST');

      vi.advanceTimersByTime(120_001);
      expect(gateway.getCachedQr('profile-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
