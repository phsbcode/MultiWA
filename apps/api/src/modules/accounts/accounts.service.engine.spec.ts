import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@multiwa/database', () => ({
  prisma: {
    account: { findUnique: vi.fn() },
    profile: { create: vi.fn() },
  },
}));

import { prisma } from '@multiwa/database';
import { AccountsService } from './accounts.service';

describe('AccountsService profile engine persistence', () => {
  const engineManager = {};
  let service: AccountsService;

  beforeEach(() => {
    vi.mocked(prisma.account.findUnique).mockReset();
    vi.mocked(prisma.profile.create).mockReset();
    service = new AccountsService(engineManager as any);
  });

  it('persists the selected Baileys engine from the profile creation UI', async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValue({ id: 'account-1', workspaceId: 'workspace-1' } as any);
    vi.mocked(prisma.profile.create).mockResolvedValue({ id: 'profile-1' } as any);

    await service.createProfile('account-1', {
      displayName: 'Synthetic Baileys Profile',
      settings: { engine: 'baileys' },
    });

    expect(prisma.profile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settings: { engine: 'baileys' },
      }),
    });
  });

  it('defaults legacy profile creation to whatsapp-web-js', async () => {
    vi.mocked(prisma.account.findUnique).mockResolvedValue({ id: 'account-1', workspaceId: 'workspace-1' } as any);
    vi.mocked(prisma.profile.create).mockResolvedValue({ id: 'profile-1' } as any);

    await service.createProfile('account-1', { displayName: 'Synthetic Legacy Profile' });

    expect(prisma.profile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settings: { engine: 'whatsapp-web-js' },
      }),
    });
  });
});
