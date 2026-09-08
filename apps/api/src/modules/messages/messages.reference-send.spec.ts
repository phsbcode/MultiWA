import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  messageFindFirst: vi.fn(), profileFindUnique: vi.fn(), conversationFindFirst: vi.fn(),
  conversationCreate: vi.fn(), conversationUpdate: vi.fn(), messageCreate: vi.fn(),
  messageUpdate: vi.fn(),
}));
vi.mock('@multiwa/database', () => ({ prisma: {
  message: { findFirst: db.messageFindFirst, create: db.messageCreate, update: db.messageUpdate },
  profile: { findUnique: db.profileFindUnique },
  conversation: { findFirst: db.conversationFindFirst, create: db.conversationCreate,
    update: db.conversationUpdate },
} }));

import { MessagesService } from './messages.service';

describe('MessagesService reference-bound sends', () => {
  const engine = { sendText: vi.fn(), sendReaction: vi.fn() };
  const manager = { getEngine: vi.fn() };
  let service: MessagesService;

  beforeEach(() => {
    vi.clearAllMocks();
    db.profileFindUnique.mockResolvedValue({ id: 'profile-a', phoneNumber: '60100000000' });
    db.conversationFindFirst.mockResolvedValue({ id: 'conversation-a' });
    db.conversationUpdate.mockResolvedValue({});
    db.messageCreate.mockResolvedValue({ id: 'new-message' });
    db.messageUpdate.mockResolvedValue({});
    engine.sendText.mockResolvedValue({ success: true, messageId: 'provider-new' });
    engine.sendReaction.mockResolvedValue({ success: true, messageId: 'provider-reaction' });
    manager.getEngine.mockReturnValue(engine);
    service = new MessagesService(manager as any);
  });

  it('keeps unquoted text free of reference lookup', async () => {
    await service.sendText({ profileId: 'profile-a', to: '60111111111', text: 'Hello' });
    expect(db.messageFindFirst).not.toHaveBeenCalled();
    expect(engine.sendText).toHaveBeenCalledWith('60111111111@s.whatsapp.net', 'Hello',
      { quotedMessageId: undefined });
  });

  it('persists the local quote and sends the provider quote ID', async () => {
    db.messageFindFirst.mockResolvedValue({ id: 'quoted-local', profileId: 'profile-a',
      messageId: 'quoted-provider', conversation: { id: 'conversation-a',
        profileId: 'profile-a', jid: '60111111111@s.whatsapp.net' } });
    await service.sendText({ profileId: 'profile-a', to: '60111111111', text: 'Quoted',
      quotedMessageId: 'quoted-local' });
    expect(db.messageFindFirst).toHaveBeenCalledWith({
      where: { id: 'quoted-local', profileId: 'profile-a',
        conversation: { profileId: 'profile-a' } }, include: { conversation: true },
    });
    expect(db.messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      quotedMessageId: 'quoted-local',
    }) });
    expect(engine.sendText).toHaveBeenCalledWith('60111111111@s.whatsapp.net', 'Quoted',
      { quotedMessageId: 'quoted-provider' });
  });

  it('rejects a quote whose destination differs before persistence', async () => {
    db.messageFindFirst.mockResolvedValue({ id: 'quoted-local', profileId: 'profile-a',
      messageId: 'quoted-provider', conversation: { profileId: 'profile-a',
        jid: '60111111112@s.whatsapp.net' } });
    await expect(service.sendText({ profileId: 'profile-a', to: '60111111111', text: 'Wrong',
      quotedMessageId: 'quoted-local' })).rejects.toThrow('Quoted message not found');
    expect(db.messageCreate).not.toHaveBeenCalled();
    expect(manager.getEngine).not.toHaveBeenCalled();
  });

  it.each(['missing', 'same-organization other profile', 'inconsistent parent'])(
    'rejects %s quote containment before persistence', async () => {
      db.messageFindFirst.mockResolvedValue(null);
      await expect(service.sendReply({ profileId: 'profile-a', quotedMessageId: 'quoted-local',
        text: 'Reply' })).rejects.toThrow('Quoted message not found');
      expect(db.messageCreate).not.toHaveBeenCalled();
      expect(manager.getEngine).not.toHaveBeenCalled();
    });

  it('derives reply destination and provider quote from the authorized message', async () => {
    db.messageFindFirst.mockResolvedValue({ id: 'quoted-local', profileId: 'profile-a',
      messageId: 'quoted-provider', conversation: { profileId: 'profile-a',
        jid: '60111111113@s.whatsapp.net' } });
    await service.sendReply({ profileId: 'profile-a', quotedMessageId: 'quoted-local', text: 'Reply' });
    expect(engine.sendText).toHaveBeenCalledWith('60111111113@s.whatsapp.net', 'Reply',
      { quotedMessageId: 'quoted-provider' });
  });

  it('derives reaction destination and provider message from the authorized message', async () => {
    db.messageFindFirst.mockResolvedValue({ id: 'reaction-local', profileId: 'profile-a',
      messageId: 'reaction-provider', conversation: { profileId: 'profile-a',
        jid: '60111111114@s.whatsapp.net' } });
    await service.sendReaction({ profileId: 'profile-a', messageId: 'reaction-local', emoji: 'ok' });
    expect(engine.sendReaction).toHaveBeenCalledWith('reaction-provider', 'ok');
    expect(db.messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      profileId: 'profile-a', type: 'reaction', content: {
        messageId: 'reaction-provider', emoji: 'ok' },
    }) });
  });
});
