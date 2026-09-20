import { beforeEach, describe, expect, it, vi } from 'vitest';

const { engine, createEngine } = vi.hoisted(() => {
  const engine = {
    engineType: 'baileys',
    initialize: vi.fn(),
    connect: vi.fn(),
    destroy: vi.fn(),
    getStatus: vi.fn(() => ({ isConnected: false, isAuthenticated: false })),
    isReady: vi.fn(() => false),
  };
  return { engine, createEngine: vi.fn(() => engine) };
});

vi.mock('@multiwa/engines', () => ({
  EngineFactory: { create: createEngine },
}));

vi.mock('@multiwa/database', () => ({
  prisma: {
    profile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversation: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '@multiwa/database';
import { EngineManagerService } from './engine-manager.service';

describe('EngineManagerService engine selection', () => {
  const eventsGateway = {
    emitQrUpdate: vi.fn(),
    emitConnectionStatus: vi.fn(),
    emitMessage: vi.fn(),
    emitMessageUpdate: vi.fn(),
    emitMessageAck: vi.fn(),
    emitPresence: vi.fn(),
  };
  let service: EngineManagerService;
  const hooksService = { emit: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    engine.initialize.mockResolvedValue(undefined);
    engine.connect.mockResolvedValue(undefined);
    engine.destroy.mockResolvedValue(undefined);
    vi.mocked(prisma.profile.update).mockResolvedValue({} as any);
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as any);
    service = new EngineManagerService(
      eventsGateway as any,
      { processMessage: vi.fn() } as any,
      { createForOrg: vi.fn() } as any,
      hooksService as any,
      { handleIncomingMessage: vi.fn() } as any,
    );
  });

  it('creates a Baileys adapter for a profile persisted with the Baileys engine', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);

    await service.connectProfile('profile-baileys');

    expect(createEngine).toHaveBeenCalledWith('baileys');
    expect(engine.initialize).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'profile-baileys',
      sessionDir: expect.stringContaining('profile-baileys'),
    }));
    expect(engine.connect).toHaveBeenCalledOnce();
  });

  it('does not auto-reconnect deliberately disconnected profiles', async () => {
    vi.mocked(prisma.profile.findMany).mockResolvedValueOnce([] as any);

    await service.onModuleInit();

    expect(prisma.profile.findMany).toHaveBeenCalledOnce();
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('recovers profiles left connecting when the API process restarts', async () => {
    vi.mocked(prisma.profile.findMany).mockResolvedValueOnce([
      { id: 'profile-connecting', displayName: 'Recovering profile' },
    ] as any);
    vi.mocked(prisma.profile.updateMany).mockResolvedValue({ count: 1 } as any);
    const reconnect = vi.spyOn(service as any, 'autoReconnectProfiles').mockResolvedValue(undefined);

    await service.onModuleInit();

    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['connected', 'connecting'] } },
      select: { id: true, displayName: true },
    });
    expect(prisma.profile.updateMany).toHaveBeenCalledWith({
      where: { status: { in: ['connected', 'connecting'] } },
      data: { status: 'disconnected' },
    });
    expect(reconnect).toHaveBeenCalledWith(['profile-connecting']);
  });

  it('updates a stored message when Baileys reports an edit', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValue([{
      id: 'database-message',
      messageId: 'provider-message',
      conversationId: 'group-conversation',
      senderJid: '60123456789@s.whatsapp.net',
      type: 'text',
      content: { text: 'Original' },
      metadata: {},
    }] as any);
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      id: 'group-conversation',
      jid: '120363000000000000@g.us',
      name: 'TEST Group',
      type: 'group',
    } as any);
    vi.mocked(prisma.message.update).mockResolvedValue({
      id: 'database-message',
      messageId: 'provider-message',
      content: { text: 'Expanded edited message' },
    } as any);

    await service.connectProfile('profile-baileys');
    const config = engine.initialize.mock.calls[0][0];
    await config.onMessageEdit({
      messageId: 'provider-message',
      body: 'Expanded edited message',
      type: 'text',
      editedAt: new Date('2026-08-05T10:00:00Z'),
    });

    expect(prisma.message.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'database-message' },
      data: expect.objectContaining({
        content: { text: 'Expanded edited message' },
        metadata: expect.objectContaining({ isEdited: true }),
      }),
    }));
    expect(eventsGateway.emitMessageUpdate).toHaveBeenCalledOnce();
    expect(hooksService.emit).toHaveBeenCalledWith('message.edited', expect.objectContaining({
      profileId: 'profile-baileys',
      messageId: 'provider-message',
      isGroup: true,
      conversationId: 'group-conversation',
      chatJid: '120363000000000000@g.us',
    }));
  });

  it('ignores an acknowledgement without a provider message id', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);

    await service.connectProfile('profile-baileys');
    const config = engine.initialize.mock.calls[0][0];
    await config.onMessageAck('', 'read');

    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(eventsGateway.emitMessageAck).not.toHaveBeenCalled();
  });

  it('scopes a valid acknowledgement to its active profile', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);

    await service.connectProfile('profile-baileys');
    const config = engine.initialize.mock.calls[0][0];
    await config.onMessageAck('provider-message', 'delivered');

    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { profileId: 'profile-baileys', messageId: 'provider-message' },
      data: { status: 'delivered' },
    });
    expect(eventsGateway.emitMessageAck).toHaveBeenCalledWith(
      'profile-baileys', 'provider-message', 'delivered',
    );
  });

  it('persists replayed history once without firing live-message side effects', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);
    vi.mocked(prisma.message.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: 'conversation',
      jid: '60123456789@s.whatsapp.net',
      lastMessageAt: null,
    } as any);
    vi.mocked(prisma.message.create).mockResolvedValue({ id: 'database-message' } as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);

    await service.connectProfile('profile-baileys');
    const config = engine.initialize.mock.calls[0][0];
    const replayedMessage = {
      id: 'history-message',
      from: '60123456789@s.whatsapp.net',
      body: 'Past payment context',
      type: 'text',
      timestamp: new Date('2026-08-04T10:00:00Z'),
      isHistorical: true,
      fromMe: false,
    };
    await Promise.all([
      config.onMessage(replayedMessage),
      config.onMessage(replayedMessage),
    ]);

    expect(prisma.message.create).toHaveBeenCalledOnce();
    expect(prisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ unreadCount: expect.anything() }),
    }));
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
  });

  it('persists inbound quoted-message linkage for reply-aware consumers', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);
    vi.mocked(prisma.message.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue({
      id: 'conversation',
      jid: 'payment-group@g.us',
      lastMessageAt: null,
    } as any);
    vi.mocked(prisma.message.create).mockResolvedValue({ id: 'database-message' } as any);
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);

    await service.connectProfile('profile-baileys');
    const config = engine.initialize.mock.calls[0][0];
    await config.onMessage({
      id: 'reply-message',
      from: 'payment-group@g.us',
      author: '60123456789@s.whatsapp.net',
      body: 'Payment context',
      type: 'text',
      timestamp: new Date('2026-08-05T10:00:00Z'),
      quotedMessageId: 'quoted-slip-message',
      isGroup: true,
      isHistorical: true,
      fromMe: false,
    });

    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ quotedMessageId: 'quoted-slip-message' }),
    }));
  });
});

describe('reconnect restrictions and operator pause', () => {
  function manager() {
    return new EngineManagerService({ emitConnectionStatus: vi.fn(), emitQrUpdate: vi.fn(), getCachedQr: vi.fn() } as any,
      {} as any, {} as any, {} as any, {} as any);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({ id: 'paused-profile', settings: { engine: 'baileys' }, sessionData: null } as any);
    vi.mocked(prisma.profile.update).mockResolvedValue({} as any);
    engine.initialize.mockResolvedValue(undefined);engine.connect.mockResolvedValue(undefined);engine.destroy.mockResolvedValue(undefined);
  });
  it('does not reconnect after forbidden and retains credentials', async () => {
    const service = manager();await service.connectProfile('paused-profile');
    const config = engine.initialize.mock.calls.at(-1)![0];
    await config.onDisconnected('Forbidden');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(prisma.profile.update).toHaveBeenLastCalledWith({ where: { id: 'paused-profile' }, data: { status: 'disconnected' } });
    expect(vi.mocked(prisma.profile.update).mock.calls.some(([arg]) => arg.data.sessionData === null)).toBe(false);
  });
  it('manual disconnect cancels an already waiting retry and stale ready callback', async () => {
    vi.useFakeTimers();
    try {
      const service = manager();await service.connectProfile('paused-profile');
      const config = engine.initialize.mock.calls.at(-1)![0];
      const retry = config.onDisconnected('Connection Failure');
      await vi.advanceTimersByTimeAsync(1);
      await service.disconnectProfile('paused-profile');
      const writes = vi.mocked(prisma.profile.update).mock.calls.length;
      await config.onReady('synthetic-phone','Synthetic');
      await vi.advanceTimersByTimeAsync(60000);await retry;
      expect(createEngine).toHaveBeenCalledTimes(1);
      expect(vi.mocked(prisma.profile.update).mock.calls.length).toBe(writes);
    } finally { vi.useRealTimers(); }
  });
  it('three retries remain bounded across newly created sockets', async () => {
    vi.useFakeTimers();
    try {
      const service = manager();await service.connectProfile('paused-profile');
      for (const delay of [5000,15000,45000]) {
        const config = engine.initialize.mock.calls.at(-1)![0];
        const retry = config.onDisconnected('Connection Failure');
        await vi.advanceTimersByTimeAsync(delay + 1);await retry;
      }
      await engine.initialize.mock.calls.at(-1)![0].onDisconnected('Connection Failure');
      await vi.advanceTimersByTimeAsync(120000);
      expect(createEngine).toHaveBeenCalledTimes(4);
      expect(prisma.profile.update).toHaveBeenLastCalledWith({ where: { id: 'paused-profile' }, data: { status: 'disconnected' } });
    } finally { vi.useRealTimers(); }
  });
});
