import { describe, expect, it, vi } from 'vitest';
import { BaileysAdapter } from './baileys.adapter';

describe('Baileys sender identity resolution', () => {
  it('reads reverse mappings from the persisted Baileys session key store', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    (adapter as any).authState = {
      state: {
        keys: { get: vi.fn().mockResolvedValue({ '900000000000001_reverse': '60129876543' }) },
      },
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

  it('normalizes a device-scoped phone JID and persists the recovered mapping', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const onPhoneNumberShare = vi.fn().mockResolvedValue(undefined);
    (adapter as any).config = { onPhoneNumberShare };
    (adapter as any).socket = { signalRepository: { lidMapping: {
      getPNsForLIDs: vi.fn().mockResolvedValue([{
        lid: providerIdentity,
        pn: '60123456789:3@s.whatsapp.net',
      }]),
    } } };

    await expect(adapter.resolvePhoneJids([providerIdentity])).resolves.toEqual({
      [providerIdentity]: '60123456789@s.whatsapp.net',
    });
    expect(onPhoneNumberShare).toHaveBeenCalledWith({
      lid: providerIdentity,
      jid: '60123456789@s.whatsapp.net',
    });
  });

  it('resolves a group sender from persisted state before emitting the incoming message', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const onMessage = vi.fn().mockResolvedValue(undefined);
    (adapter as any).config = { onMessage };
    (adapter as any).authState = { state: { keys: { get: vi.fn().mockResolvedValue({
      '900000000000001_reverse': '60129876543',
    }) } } };
    (adapter as any).socket = { user: { id: '60110000000:1@s.whatsapp.net' } };

    await (adapter as any).emitInboundMessage({
      key: { id: 'message-1', remoteJid: '120363000000000000@g.us', participant: providerIdentity },
      message: { conversation: 'Payment received' },
      messageTimestamp: 1788750000,
      pushName: 'Sender',
    }, false);

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      author: '60129876543@s.whatsapp.net',
      participant: '60129876543@s.whatsapp.net',
    }));
  });

  it('retains an incoming LID when its optional phone lookup fails', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const onMessage = vi.fn().mockResolvedValue(undefined);
    (adapter as any).config = { onMessage };
    (adapter as any).authState = { state: { keys: { get: vi.fn().mockRejectedValue(
      new Error('mapping store unavailable'),
    ) } } };
    (adapter as any).socket = { user: { id: '60110000000:1@s.whatsapp.net' } };

    await (adapter as any).emitInboundMessage({
      key: { id: 'message-2', remoteJid: '120363000000000000@g.us', participant: providerIdentity },
      message: { conversation: 'Payment received' },
      messageTimestamp: 1788750001,
    }, false);

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      author: providerIdentity,
      participant: providerIdentity,
    }));
  });

  it('falls back to the group participant LID and phone-number pair', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    (adapter as any).socket = {
      signalRepository: { lidMapping: { getPNsForLIDs: vi.fn().mockResolvedValue([]) } },
      groupFetchAllParticipating: vi.fn().mockResolvedValue({
        'sample-group@g.us': { participants: [{
          id: providerIdentity,
          lid: providerIdentity,
          phoneNumber: '60129876543@s.whatsapp.net',
        }] },
      }),
    };

    await expect(adapter.resolvePhoneJids([providerIdentity])).resolves.toEqual({
      [providerIdentity]: '60129876543@s.whatsapp.net',
    });
  });

  it('bounds an incoming sender lookup to the current group metadata', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const groupMetadata = vi.fn().mockResolvedValue({ participants: [{
      id: providerIdentity,
      lid: providerIdentity,
      phoneNumber: '60129876543@s.whatsapp.net',
    }] });
    const groupFetchAllParticipating = vi.fn();
    (adapter as any).config = { onMessage };
    (adapter as any).authState = { state: { keys: { get: vi.fn().mockResolvedValue({}) } } };
    (adapter as any).socket = {
      user: { id: '60110000000:1@s.whatsapp.net' },
      signalRepository: { lidMapping: { getPNsForLIDs: vi.fn().mockResolvedValue([]) } },
      groupMetadata,
      groupFetchAllParticipating,
    };

    await (adapter as any).emitInboundMessage({
      key: { id: 'message-3', remoteJid: '120363000000000000@g.us', participant: providerIdentity },
      message: { conversation: 'Payment received' },
      messageTimestamp: 1788750002,
    }, false);

    expect(groupMetadata).toHaveBeenCalledWith('120363000000000000@g.us');
    expect(groupFetchAllParticipating).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      author: '60129876543@s.whatsapp.net',
    }));
  });

  it('retains Baileys participantAlt phone identities and emits a durable mapping', async () => {
    const adapter = new BaileysAdapter();
    const providerIdentity = ['900000000000001', 'lid'].join('@');
    const onPhoneNumberShare = vi.fn().mockResolvedValue(undefined);
    (adapter as any).config = { onPhoneNumberShare };

    await (adapter as any).rememberPhoneNumberShare(
      providerIdentity,
      '60129876543@s.whatsapp.net',
    );

    await expect(adapter.resolvePhoneJids([providerIdentity])).resolves.toEqual({
      [providerIdentity]: '60129876543@s.whatsapp.net',
    });
    expect(onPhoneNumberShare).toHaveBeenCalledWith({
      lid: providerIdentity,
      jid: '60129876543@s.whatsapp.net',
    });
  });
});
