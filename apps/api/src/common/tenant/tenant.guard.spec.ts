import { beforeEach, describe, expect, it, vi } from 'vitest';

const { profileFindFirst, conversationFindFirst } = vi.hoisted(() => ({
  profileFindFirst: vi.fn(),
  conversationFindFirst: vi.fn(),
}));
vi.mock('@multiwa/database', () => ({ prisma: {
  profile: { findFirst: profileFindFirst },
  conversation: { findFirst: conversationFindFirst },
} }));

import { TenantGuard } from './tenant.guard';

function runtime(checks: any[], request: any) {
  const reflector = { getAllAndOverride: vi.fn(() => checks) };
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { guard: new TenantGuard(reflector as any), context: context as any };
}

describe('TenantGuard', () => {
  beforeEach(() => {
    profileFindFirst.mockReset();
    conversationFindFirst.mockReset();
  });
  it('leaves routes without ownership metadata unchanged', async () => {
    const value = runtime([], { user: {} });
    await expect(value.guard.canActivate(value.context)).resolves.toBe(true);
    expect(profileFindFirst).not.toHaveBeenCalled();
  });

  it('rejects missing organization context before a database query', async () => {
    const value = runtime([{ resource: 'profile', from: 'param', key: 'profileId' }],
      { user: {}, params: { profileId: 'profile-a' } });
    await expect(value.guard.canActivate(value.context)).rejects.toThrow(
      'Organization context is required.',
    );
    expect(profileFindFirst).not.toHaveBeenCalled();
  });

  it('checks profile ownership from the declared request location', async () => {
    profileFindFirst.mockResolvedValueOnce({ id: 'profile-a' });
    const value = runtime([{ resource: 'profile', from: 'query', key: 'profileId' }], {
      user: { organizationId: 'org-a' }, query: { profileId: 'profile-a' },
    });
    await expect(value.guard.canActivate(value.context)).resolves.toBe(true);
    expect(profileFindFirst).toHaveBeenCalledWith({
      where: { id: 'profile-a', workspace: { organizationId: 'org-a' } },
      select: { id: true },
    });
  });

  it('checks conversation ownership through its profile workspace', async () => {
    conversationFindFirst.mockResolvedValueOnce({ id: 'conversation-a' });
    const value = runtime([{ resource: 'conversation', from: 'param', key: 'id' }], {
      user: { organizationId: 'org-a' }, params: { id: 'conversation-a' },
    });
    await expect(value.guard.canActivate(value.context)).resolves.toBe(true);
    expect(conversationFindFirst).toHaveBeenCalledWith({
      where: { id: 'conversation-a', profile: { workspace: { organizationId: 'org-a' } } },
      select: { id: true },
    });
  });

  it('returns the same non-disclosing result for missing and foreign resources', async () => {
    profileFindFirst.mockResolvedValue(null);
    const foreign = runtime([{ resource: 'profile', from: 'param', key: 'profileId' }], {
      user: { organizationId: 'org-a' }, params: { profileId: 'profile-b' },
    });
    await expect(foreign.guard.canActivate(foreign.context)).rejects.toThrow('Resource not found.');

    const missing = runtime([{ resource: 'profile', from: 'query', key: 'profileId' }], {
      user: { organizationId: 'org-a' }, query: {},
    });
    await expect(missing.guard.canActivate(missing.context)).rejects.toThrow('Missing profileId.');
  });
});
