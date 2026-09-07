import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  profileFindUnique: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdate: vi.fn(),
  messageCreate: vi.fn(),
  messageUpdate: vi.fn(),
}));

vi.mock('@multiwa/database', () => ({ prisma: {
  profile: { findUnique: database.profileFindUnique },
  conversation: {
    findFirst: database.conversationFindFirst,
    create: database.conversationCreate,
    update: database.conversationUpdate,
  },
  message: { create: database.messageCreate, update: database.messageUpdate },
} }));

import { MessagesService } from './messages.service';

const cases = [
  { handler: 'sendImage', type: 'image', engine: 'sendImage', dto: {
    profileId: 'profile-a', to: '0601 111 1101', base64: 'aGVsbG8=', caption: 'Synthetic image',
  }, jid: '626011111101@s.whatsapp.net', engineContent: {
    url: undefined, base64: 'aGVsbG8=', caption: 'Synthetic image', mimetype: 'image/jpeg' } },
  { handler: 'sendVideo', type: 'video', engine: 'sendVideo', dto: {
    profileId: 'profile-a', to: '0601 111 1102', base64: 'aGVsbG8=',
  }, jid: '626011111102@s.whatsapp.net', engineContent: {
    url: undefined, base64: 'aGVsbG8=', caption: undefined, mimetype: 'video/mp4' } },
  { handler: 'sendAudio', type: 'audio', engine: 'sendAudio', dto: {
    profileId: 'profile-a', to: '0601 111 1103', base64: 'aGVsbG8=', ptt: true,
  }, jid: '626011111103@s.whatsapp.net', engineContent: {
    url: undefined, base64: 'aGVsbG8=', mimetype: 'audio/mpeg', ptt: true } },
  { handler: 'sendDocument', type: 'document', engine: 'sendDocument', dto: {
    profileId: 'profile-a', to: '0601 111 1104', base64: 'aGVsbG8=', filename: 'synthetic.pdf',
  }, jid: '626011111104@s.whatsapp.net', engineContent: {
    url: undefined, base64: 'aGVsbG8=', filename: 'synthetic.pdf', caption: undefined,
    mimetype: 'application/octet-stream' } },
  { handler: 'sendLocation', type: 'location', engine: 'sendLocation', dto: {
    profileId: 'profile-a', to: '0601 111 1105', latitude: 3.1, longitude: 101.7,
  }, jid: '626011111105@s.whatsapp.net', engineContent: {
    latitude: 3.1, longitude: 101.7, name: undefined, address: undefined } },
  { handler: 'sendContact', type: 'contact', engine: 'sendContact', dto: {
    profileId: 'profile-a', to: '0601 111 1106',
    contacts: [{ name: 'Synthetic Contact', phone: '60111111107' }],
  }, jid: '626011111106@s.whatsapp.net', engineContent: {
    contacts: [{ displayName: 'Synthetic Contact', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Synthetic Contact\nTEL;type=CELL;type=VOICE;waid=60111111107:60111111107\nEND:VCARD' }],
    name: 'Synthetic Contact', phone: '60111111107' } },
  { handler: 'sendPoll', type: 'poll', engine: 'sendPoll', dto: {
    profileId: 'profile-a', to: '0601 111 1107', question: 'Synthetic choice?',
    options: ['One', 'Two'], allowMultipleAnswers: false,
  }, jid: '626011111107@s.whatsapp.net', engineContent: {
    question: 'Synthetic choice?', options: ['One', 'Two'], allowMultipleAnswers: false } },
] as const;

describe('MessagesService direct-send mapping', () => {
  const engine = Object.fromEntries(cases.map(value => [value.engine, vi.fn()])) as
    Record<string, ReturnType<typeof vi.fn>>;
  const engineManager = { getEngine: vi.fn() };
  let service: MessagesService;

  beforeEach(() => {
    vi.clearAllMocks();
    database.profileFindUnique.mockResolvedValue({ id: 'profile-a', phoneNumber: '60100000000' });
    database.conversationFindFirst.mockResolvedValue({ id: 'conversation-a' });
    database.messageCreate.mockResolvedValue({ id: 'message-a' });
    database.messageUpdate.mockResolvedValue({ id: 'message-a' });
    database.conversationUpdate.mockResolvedValue({ id: 'conversation-a' });
    Object.values(engine).forEach(send => send.mockResolvedValue({ success: true, messageId: 'provider-a' }));
    engineManager.getEngine.mockReturnValue(engine);
    service = new MessagesService(engineManager as any);
  });

  it.each(cases)('maps $type and invokes only $engine', async value => {
    const result = await (service[value.handler] as any)(value.dto);
    expect(result).toEqual({ success: true, messageId: 'message-a',
      conversationId: 'conversation-a', waMessageId: 'provider-a', status: 'sent' });
    expect(engineManager.getEngine).toHaveBeenCalledWith('profile-a');
    expect(database.messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      profileId: 'profile-a', conversationId: 'conversation-a', type: value.type,
      direction: 'outgoing', status: 'pending',
      content: value.engineContent,
    }) });
    expect(engine[value.engine]).toHaveBeenCalledOnce();
    expect(engine[value.engine]).toHaveBeenCalledWith(value.jid, value.engineContent);
    for (const other of cases.map(item => item.engine).filter(name => name !== value.engine)) {
      expect(engine[other]).not.toHaveBeenCalled();
    }
  });

  it('persists a pending image for a disconnected profile without provider access', async () => {
    database.conversationFindFirst.mockResolvedValueOnce(null);
    database.conversationCreate.mockResolvedValueOnce({ id: 'conversation-new' });
    engineManager.getEngine.mockReturnValueOnce(undefined);

    const result = await service.sendImage({
      profileId: 'profile-a', to: '60111111999', base64: 'aGVsbG8=',
    });

    expect(result).toEqual({ success: true, messageId: 'message-a',
      conversationId: 'conversation-new', status: 'pending',
      warning: 'Profile not connected, message queued' });
    expect(database.conversationCreate).toHaveBeenCalledOnce();
    expect(Object.values(engine).every(send => send.mock.calls.length === 0)).toBe(true);
  });
});
