import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integration = process.env.MULTIWA_ACK_INTEGRATION === '1' ? describe : describe.skip;

integration('acknowledgement profile isolation with PostgreSQL', () => {
  let prisma: any;
  let applyMessageAck: any;
  const ids = {
    profiles: ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102'],
    conversations: ['00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202'],
    messages: ['00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000302'],
  };

  beforeAll(async () => {
    ({ prisma } = await import('@multiwa/database'));
    ({ applyMessageAck } = await import('./ack-status'));
    for (let index = 0; index < 2; index += 1) {
      await prisma.profile.create({ data: { id: ids.profiles[index] } });
      await prisma.conversation.create({ data: {
        id: ids.conversations[index], profileId: ids.profiles[index],
        jid: `synthetic-${index}@s.whatsapp.net`, type: 'user',
      } });
      await prisma.message.create({ data: {
        id: ids.messages[index], profileId: ids.profiles[index],
        conversationId: ids.conversations[index], messageId: 'shared-provider-id',
        direction: 'outgoing', senderJid: `synthetic-${index}@s.whatsapp.net`,
        type: 'text', content: { text: 'synthetic' }, status: 'sent', timestamp: new Date(0),
      } });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.profile.deleteMany({ where: { id: { in: ids.profiles } } });
    await prisma.$disconnect();
  });

  it('updates one profile and leaves the same provider id in another profile unchanged', async () => {
    await expect(applyMessageAck(ids.profiles[0], 'shared-provider-id', 'delivered'))
      .resolves.toEqual({ applied: true, count: 1, status: 'delivered' });
    expect((await prisma.message.findUnique({ where: { id: ids.messages[0] } })).status)
      .toBe('delivered');
    expect((await prisma.message.findUnique({ where: { id: ids.messages[1] } })).status)
      .toBe('sent');
  });

  it('performs no database write for an absent message id', async () => {
    await expect(applyMessageAck(ids.profiles[0], undefined, 'read'))
      .resolves.toEqual({ applied: false, reason: 'invalid_message_id' });
    expect(await prisma.message.count({ where: { status: 'read' } })).toBe(0);
  });
});
