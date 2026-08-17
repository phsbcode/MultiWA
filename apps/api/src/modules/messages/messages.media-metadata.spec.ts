import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock('@multiwa/database', () => ({ prisma: { message: { findMany } } }));

import { MessagesService } from './messages.service';

describe('MessagesService media metadata reads', () => {
  beforeEach(() => findMany.mockReset());

  it('replaces encoded media with a stable fingerprint for metadata-first scans', async () => {
    const base64 = Buffer.from('payment-slip').toString('base64');
    findMany.mockResolvedValue([{ id: 'message-1', profileId: 'profile-1', type: 'image',
      content: { url: `data:image/jpeg;base64,${base64}`, caption: 'Paid', mimetype: 'image/jpeg' },
      conversation: { id: 'conversation-1' } }]);
    const service = new MessagesService({} as any);

    const result = await service.findByProfile('profile-1', { includeMedia: false, since: new Date(0) });

    expect(result[0].content).toEqual({ caption: 'Paid', mimetype: 'image/jpeg' });
    expect((result[0] as any).mediaFingerprint).toBe(createHash('sha256')
      .update(`image/jpeg:${base64}`).digest('base64url'));
    expect((result[0] as any).mediaBytes).toBe(Buffer.from(base64, 'base64').length);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      profileId: 'profile-1', timestamp: { gte: new Date(0) }
    } }));
  });

  it('retrieves full media only for bounded IDs inside the requested profile', async () => {
    findMany.mockResolvedValue([{ id: 'message-2', profileId: 'profile-1', content: { url: 'data:x' } },
      { id: 'message-1', profileId: 'profile-1', content: { url: 'data:y' } }]);
    const service = new MessagesService({} as any);

    const result = await service.findMediaByProfile('profile-1', ['message-1', 'message-2', 'message-1']);

    expect(result.map((row: any) => row.id)).toEqual(['message-1', 'message-2']);
    expect(findMany).toHaveBeenCalledWith({
      where: { profileId: 'profile-1', id: { in: ['message-1', 'message-2'] } },
      include: { conversation: true },
    });
  });
});
