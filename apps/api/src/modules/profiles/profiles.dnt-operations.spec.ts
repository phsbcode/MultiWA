import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    workspace: { findFirst: vi.fn(), findMany: vi.fn() },
    profile: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { ProfilesService } from './profiles.service';

describe('ProfilesService DNT Operations boundary', () => {
  const engineManager = {
    getEngineStatus: vi.fn(() => ({ isConnected: false })),
    connectProfile: vi.fn(),
    disconnectProfile: vi.fn(),
    getCachedQrCode: vi.fn(),
  };
  let service: ProfilesService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ProfilesService(engineManager as any);
  });

  it('lists only exact-boolean allowed profiles within the organization', async () => {
    vi.mocked(prisma.profile.findMany).mockResolvedValue([
      { id:'allowed', displayName:'Allowed', phoneNumber:null, status:'disconnected', lastConnectedAt:null, settings:{dntOperationsAccess:true,engine:'baileys'} },
      { id:'string-flag', displayName:'String', phoneNumber:null, status:'connected', lastConnectedAt:null, settings:{dntOperationsAccess:'true'} },
      { id:'closed', displayName:'Closed', phoneNumber:null, status:'connected', lastConnectedAt:null, settings:{} },
    ] as any);

    const result = await service.findDntOperationsProfiles('org-1');

    expect(result.map(profile => profile.id)).toEqual(['allowed']);
    expect(prisma.profile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspace: { organizationId: 'org-1' } },
    }));
  });

  it('creates an allowed profile in the organization workspace without accepting a workspace ID', async () => {
    vi.mocked(prisma.workspace.findFirst).mockResolvedValue({ id:'workspace-1' } as any);
    vi.mocked(prisma.profile.create).mockResolvedValue({
      id:'created', workspaceId:'workspace-1', displayName:'DNT Added', settings:{engine:'baileys',dntOperationsAccess:true},
    } as any);

    const result = await service.createForDntOperations({ name:'DNT Added', engine:'baileys' as any }, { organizationId:'org-1' });

    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { organizationId:'org-1' },
      orderBy: { createdAt:'asc' },
    });
    expect(prisma.profile.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      workspaceId:'workspace-1',
      displayName:'DNT Added',
      settings:{engine:'baileys',dntOperationsAccess:true},
    }) });
    expect((result as any).workspaceId).toBe('workspace-1');
  });

  it('does not expose status or QR for an unflagged profile', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({
      id:'closed', displayName:'Closed', phoneNumber:null, status:'disconnected', lastConnectedAt:null, settings:{}, workspace:{organizationId:'org-1'},
    } as any);

    await expect(service.getDntOperationsStatus('closed','org-1')).rejects.toThrow('Profile not found');
    await expect(service.getDntOperationsQr('closed','org-1')).rejects.toThrow('Profile not found');
    expect(engineManager.getCachedQrCode).not.toHaveBeenCalled();
  });

  it('deletes only an organization-owned profile explicitly allowed for DNT Operations', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({
      id:'allowed', displayName:'Allowed', phoneNumber:null, status:'disconnected', lastConnectedAt:null,
      settings:{dntOperationsAccess:true}, workspace:{organizationId:'org-1'},
    } as any);
    vi.mocked(prisma.profile.delete).mockResolvedValue({ id:'allowed' } as any);

    await expect(service.deleteDntOperations('allowed','org-1')).resolves.toEqual({ success:true });

    expect(engineManager.disconnectProfile).toHaveBeenCalledWith('allowed');
    expect(prisma.profile.delete).toHaveBeenCalledWith({ where:{id:'allowed'} });
  });

  it('refuses DNT deletion for a profile without the exact allow flag', async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({
      id:'closed', displayName:'Closed', phoneNumber:null, status:'disconnected', lastConnectedAt:null,
      settings:{}, workspace:{organizationId:'org-1'},
    } as any);

    await expect(service.deleteDntOperations('closed','org-1')).rejects.toThrow('Profile not found');

    expect(engineManager.disconnectProfile).not.toHaveBeenCalled();
    expect(prisma.profile.delete).not.toHaveBeenCalled();
  });
});
