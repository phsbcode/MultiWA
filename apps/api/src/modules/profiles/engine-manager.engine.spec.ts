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
    conversation: { findFirst: vi.fn(), update: vi.fn() },
    contact: { findFirst: vi.fn(), create: vi.fn() },
    message: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { EngineManagerService } from './engine-manager.service';

describe('EngineManagerService engine selection', () => {
  const eventsGateway = {
    emitQrUpdate: vi.fn(),
    emitConnectionStatus: vi.fn(),
    emitMessage: vi.fn(),
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
});
