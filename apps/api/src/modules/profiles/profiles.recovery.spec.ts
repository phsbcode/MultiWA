import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('@multiwa/database', () => ({ prisma: { profile: { findFirst: vi.fn() } } }));
import { prisma } from '@multiwa/database';
import { ProfilesService } from './profiles.service';

const markers = { version: 1, firstGapAt: '2026-09-28T19:08:19.319Z',
  lastDisconnectedAt: '2026-09-29T09:28:50.918Z', lastConnectedAt: '2026-09-29T12:00:00Z',
  revision: 5, settledAt: null, gapAccuracy: 'observed', persistence: 'durable' };
const engine = { getTransportRecovery: vi.fn(), getEngineStatus: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.profile.findFirst).mockResolvedValue({ id: 'profile-a', status: 'disconnected',
    settings: { engine: 'baileys' }, workspace: { organizationId: 'org-a' } } as any);
  engine.getTransportRecovery.mockResolvedValue({ markers, phase: 'retry_wait', alert: null });
  engine.getEngineStatus.mockReturnValue({ isConnected: false });
});
it('exposes read-only markers with connecting state during persisted backoff', async () => {
  const result = await new ProfilesService(engine as any).getStatus('profile-a', 'org-a');
  expect(result).toMatchObject({ status: 'connecting', engineConnected: false, transportRecovery: markers });
  expect(prisma.profile.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { id: 'profile-a', workspace: { organizationId: 'org-a' } },
  }));
});
it('does not read recovery markers before organization ownership succeeds', async () => {
  vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
  await expect(new ProfilesService(engine as any).getStatus('profile-a', 'foreign')).rejects.toThrow();
  expect(engine.getTransportRecovery).not.toHaveBeenCalled();
});
it('requires current engine readiness for connected status and retains the first gap', async () => {
  engine.getTransportRecovery.mockResolvedValue({ markers: { ...markers, settledAt: '2026-09-29T12:00:30Z' },
    phase: 'stabilizing', alert: null });
  engine.getEngineStatus.mockReturnValue({ isConnected: true });
  const result = await new ProfilesService(engine as any).getStatus('profile-a', 'org-a');
  expect(result.status).toBe('connected');
  expect(result.transportRecovery.firstGapAt).toBe(markers.firstGapAt);
});
