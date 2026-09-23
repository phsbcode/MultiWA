import { describe, expect, it, vi } from 'vitest';
vi.mock('@multiwa/database', () => ({ prisma: { message: { findMany: vi.fn().mockResolvedValue([]) } } }));
import { prisma } from '@multiwa/database';
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

it('uses unique stored provider identity without contacting WhatsApp',async()=>{
 const identity='900000000000001@lid';
 vi.mocked(prisma.message.findMany).mockResolvedValue([{senderJid:'60123456789@s.whatsapp.net',metadata:{originalSenderJid:identity}}] as any);
 const getEngine=vi.fn();const service=new MessagesService({getEngine} as any);
 expect(await service.resolveSenderPhones('synthetic-profile',[identity])).toEqual({phones:{[identity]:'60123456789'}});
 expect(getEngine).not.toHaveBeenCalled();
 expect(prisma.message.findMany).toHaveBeenLastCalledWith(expect.objectContaining({where:{profileId:'synthetic-profile',OR:[{metadata:{path:['originalSenderJid'],equals:identity}}]}}));
});
it('conflicting stored mappings are not guessed or replaced by group lookups',async()=>{
 const identity='900000000000002@lid';
 vi.mocked(prisma.message.findMany).mockResolvedValue(['60123456789','60123456780'].map(phone=>({senderJid:phone+'@s.whatsapp.net',metadata:{originalSenderJid:identity}})) as any);
 const getEngine=vi.fn();const service=new MessagesService({getEngine} as any);
 expect(await service.resolveSenderPhones('synthetic-profile',[identity])).toEqual({phones:{}});expect(getEngine).not.toHaveBeenCalled();
});
