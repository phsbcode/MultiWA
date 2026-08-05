import { describe, expect, it, vi } from 'vitest';
import { BaileysAdapter } from './baileys.adapter';

describe('Baileys sender identity resolution', () => {
  it('reads reverse mappings from the persisted Baileys session key store', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    (adapter as any).authState = {
      keys: { get: vi.fn().mockResolvedValue({ '900000000000001_reverse': '60129876543' }) },
    };

    await expect(adapter.resolvePhoneJids([providerIdentity])).resolves.toEqual({
      [providerIdentity]: '60129876543@s.whatsapp.net',
    });
  });

  it('uses the persistent Baileys LID mapping store', async () => {
    const adapter = new BaileysAdapter();
    const getPNsForLIDs = vi.fn().mockResolvedValue([{
      lid: ['900000000000001', 'lid'].join('@'),
      pn: '60123456789@s.whatsapp.net',
    }]);
    (adapter as any).socket = { signalRepository: { lidMapping: { getPNsForLIDs } } };

    const result = await adapter.resolvePhoneJids([
      ['900000000000001', 'lid'].join('@'),
      '60111111111@s.whatsapp.net',
    ]);

    expect(result).toEqual({
      [['900000000000001', 'lid'].join('@')]: '60123456789@s.whatsapp.net',
    });
    expect(getPNsForLIDs).toHaveBeenCalledTimes(1);
  });
});
