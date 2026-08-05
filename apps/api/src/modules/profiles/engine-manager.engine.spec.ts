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
    conversation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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

  beforeEach(() => {
    vi.clearAllMocks();
    engine.initialize.mockResolvedValue(undefined);
    engine.connect.mockResolvedValue(undefined);
    engine.destroy.mockResolvedValue(undefined);
    vi.mocked(prisma.profile.update).mockResolvedValue({} as any);
    service = new EngineManagerService(
      eventsGateway as any,
      { processMessage: vi.fn() } as any,
      { createForOrg: vi.fn() } as any,
      { emit: vi.fn() } as any,
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

  it('updates a stored message when Baileys reports an edit', async () => {
    vi.mocked(prisma.profile.findUnique).mockResolvedValue({
      id: 'profile-baileys',
      settings: { engine: 'baileys' },
    } as any);
    vi.mocked(prisma.message.findMany).mockResolvedValue([{
      id: 'database-message',
      type: 'text',
      content: { text: 'Original' },
      metadata: {},
    }] as any);
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
});
