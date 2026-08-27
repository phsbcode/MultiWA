import { describe, expect, it, vi } from 'vitest';
import { MessagesService } from './messages.service';

describe('MessagesService sender identity resolution', () => {
  it('returns only validated phone numbers from the connected engine', async () => {
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const resolvePhoneJids = vi.fn().mockResolvedValue({
      [providerIdentity]: '60123456789:12@s.whatsapp.net',
    });
    const service = new MessagesService({
      getEngine: () => ({ resolvePhoneJids }),
    } as any);

    await expect(service.resolveSenderPhones('profile-test', [providerIdentity])).resolves.toEqual({
      phones: { [providerIdentity]: '60123456789' },
    });
  });
});
