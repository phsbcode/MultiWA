import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ saved: new Map<string, any>(), engines: [] as any[] }));
vi.mock('./transport-recovery-journal', async () => {
  const actual = await vi.importActual<any>('./transport-recovery-journal');
  return { ...actual, FileRecoveryJournal: class {
    constructor(_directory: string, private id: string) {}
    async read() { return fixture.saved.has(this.id) ? structuredClone(fixture.saved.get(this.id)) : null; }
    async write(state: any) { fixture.saved.set(this.id, structuredClone(state)); }
  } };
});
vi.mock('@multiwa/engines', () => ({
  hasRetainedBaileysIdentity: vi.fn(() => true),
  EngineFactory: { create: vi.fn(() => {
    const engine: any = { ready: false, config: null,
      initialize: vi.fn(async (config: any) => { engine.config = config; }),
      connect: vi.fn(async () => {}),
      destroy: vi.fn(async () => { engine.ready = false; }),
      isReady: () => engine.ready,
      getStatus: () => ({ isConnected: engine.ready }),
      sendText: vi.fn(),
    };
    fixture.engines.push(engine); return engine;
  }) },
}));
vi.mock('@multiwa/database', () => ({ prisma: {
  $executeRaw: vi.fn(async () => 1),
  profile: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) },
} }));
import { prisma } from '@multiwa/database';
import { EngineManagerService } from './engine-manager.service';
import { initialRecoveryState } from './transport-recovery-journal';

const profileId = 'managed-profile';
const gateway = { emitConnectionStatus: vi.fn(), emitQrUpdate: vi.fn() };
const notifications = { createForOrg: vi.fn(async (..._args: any[]) => []) };
const manager = () => new EngineManagerService(gateway as any, {} as any, notifications as any, {} as any, {} as any);
const current = () => fixture.engines.at(-1);
async function ready() { current().ready = true; await current().config.onReady('synthetic-phone', 'Synthetic'); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  vi.stubEnv('MULTIWA_TRANSPORT_RECOVERY_PROFILE_IDS', profileId);
  vi.stubEnv('MULTIWA_MANUAL_RECONNECT_PROFILE_IDS', profileId);
  vi.clearAllMocks(); fixture.saved.clear(); fixture.engines.length = 0;
  fixture.saved.set(profileId, initialRecoveryState());
  vi.mocked(prisma.profile.findUnique).mockResolvedValue({ id: profileId, sessionData: 'synthetic-auth',
    settings: { engine: 'baileys' }, workspace: { organizationId: 'org-a' } } as any);
  vi.mocked(prisma.profile.findMany).mockResolvedValue([] as any);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('engine manager durable recovery wiring', () => {
  it('persists a storage stop when the startup DB read fails, rather than leaving resumable intent', async () => {
    fixture.saved.set(profileId, { ...initialRecoveryState(), phase: 'retry_wait', pauseReason: null,
      resumeOnStartup: true, nextRetryAt: '2026-09-29T11:59:00Z' });
    vi.mocked(prisma.profile.findMany).mockRejectedValueOnce(Error('synthetic database failure'));
    const service = manager(); await service.onModuleInit();
    expect(fixture.saved.get(profileId)).toMatchObject({ phase: 'paused',
      pauseReason: 'AUTH_STORAGE_UNAVAILABLE', resumeOnStartup: false });
    const restarted = manager(); await restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(3600000); expect(fixture.engines).toHaveLength(0);
  });
  it('supersedes blanket stop for the scoped profile, retries with pairing disabled and leaves engine sends intact', async () => {
    const service = manager(); await service.connectProfile(profileId); await ready();
    const first = current(); expect(first.config.investigationMode).toBe(true);
    expect(first.config.allowPairing).toBe(false);
    expect(service.getEngine(profileId)).toBe(first);
    await first.config.onDisconnected('Connection Closed');
    expect(first.destroy).toHaveBeenCalledOnce();
    expect((await service.getTransportRecovery(profileId))?.phase).toBe('retry_wait');
    expect(prisma.profile.update).toHaveBeenLastCalledWith({ where: { id: profileId }, data: { status: 'connecting' } });
    await vi.advanceTimersByTimeAsync(15000);
    expect(fixture.engines).toHaveLength(2);
    expect(current().config).toMatchObject({ investigationMode: true, allowPairing: false });
    await ready(); expect(service.getEngine(profileId)).toBe(current());
    expect(current().sendText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect((await service.getTransportRecovery(profileId))?.markers.settledAt).not.toBeNull();
  });

  it('preserves manual pause across API restart even when the DB previously looked connected', async () => {
    const service = manager(); await service.connectProfile(profileId); await ready();
    const stale = current().config; await service.disconnectProfile(profileId);
    await service.onModuleDestroy();
    const writes = vi.mocked(prisma.profile.update).mock.calls.length;
    await stale.onReady('synthetic-phone', 'Synthetic');
    expect(prisma.profile.update).toHaveBeenCalledTimes(writes);
    vi.mocked(prisma.profile.findMany).mockResolvedValueOnce([{ id: profileId }] as any);
    const restarted = manager(); await restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(fixture.engines).toHaveLength(1);
    expect((await restarted.getTransportRecovery(profileId))?.alert?.code).toBe('MANUAL_PAUSE');
  });

  it('resumes only a clean restart checkpoint and consumes the same durable budget', async () => {
    const service = manager(); await service.connectProfile(profileId); await ready();
    await service.onModuleDestroy();
    await service.onApplicationShutdown();
    expect(fixture.saved.get(profileId).resumeOnStartup).toBe(true);
    const restarted = manager(); await restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(15000);
    expect(fixture.engines).toHaveLength(2);
    expect(current().config.allowPairing).toBe(false);
    expect(fixture.saved.get(profileId).attemptsUsed).toBe(1);
  });

  it('emits exhaustion notification and does not erase the durable stop on restart', async () => {
    const service = manager(); await service.connectProfile(profileId); await ready();
    for (const delay of [15000, 60000, 180000]) {
      await current().config.onDisconnected('Connection Closed');
      await vi.advanceTimersByTimeAsync(delay); await ready();
    }
    await current().config.onDisconnected('Connection Closed');
    const alerts = notifications.createForOrg.mock.calls.filter(args => args[1] === 'disconnection');
    expect(alerts).toHaveLength(1);
    expect((await service.getTransportRecovery(profileId))?.alert?.code).toBe('RETRIES_EXHAUSTED');
    await service.onModuleDestroy();
    const restarted = manager(); await restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(3600000); expect(fixture.engines).toHaveLength(4);
  });
});
