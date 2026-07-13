// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socketState = vi.hoisted(() => {
  const handlers = new Map<string, (data: any) => void>();
  const socket = {
    active: true,
    on: vi.fn((event: string, handler: (data: any) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    io: { on: vi.fn() },
  };
  return { handlers, socket };
});

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => socketState.socket),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import ChatPage from './page';

const profile = {
  id: 'profile-1',
  name: 'Synthetic profile',
  displayName: 'Synthetic profile',
  status: 'connected',
  workspaceId: 'workspace-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const conversation = {
  id: 'conversation-1',
  profileId: profile.id,
  jid: '15550000001@s.whatsapp.net',
  contactId: 'contact-1',
  contactName: 'Synthetic contact',
  name: 'Synthetic contact',
  type: 'user',
  unreadCount: 3,
  metadata: { isPinned: true, isMuted: true },
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  lastMessage: {
    content: { text: 'Synthetic preview' },
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'received',
    type: 'text',
    direction: 'incoming',
  },
};

const failedMessage = {
  id: 'message-1',
  messageId: 'wa-message-1',
  conversationId: conversation.id,
  content: { text: 'Synthetic failed message' },
  type: 'text',
  direction: 'outgoing',
  status: 'failed',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  history.replaceState({}, '', '/dashboard/chat?readOnly=1');
  localStorage.setItem('accessToken', 'synthetic-token');
  socketState.handlers.clear();
  socketState.socket.on.mockClear();
  socketState.socket.emit.mockClear();
  socketState.socket.disconnect.mockClear();
  socketState.socket.io.on.mockClear();

  fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/v1/profiles')) return response([profile]);
    if (url.includes('/api/v1/conversations?')) return response({ conversations: [conversation], total: 1 });
    if (url.includes('/api/v1/messages/conversation/')) return response({ messages: [failedMessage], hasMore: false });
    if (url.includes('/messages/search?')) return response({ messages: [failedMessage], hasMore: false, nextCursor: null });
    if (url.includes('/messages/') && url.includes('/context?')) return response({ messages: [failedMessage], targetMessageId: failedMessage.id });
    if (url.includes('/api/v1/contacts?')) return response([]);
    return response({ message: `Unexpected test URL: ${url}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const assertGetOnly = () => {
  const mutations = fetchMock.mock.calls.filter(([, init]) =>
    ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() !== 'GET'
  );
  expect(mutations).toEqual([]);
};

describe('ChatPage read-only mutation boundary', () => {
  it('keeps navigation and search usable while every HTTP mutation stays blocked', async () => {
    const user = userEvent.setup();
    const view = render(<ChatPage />);

    const contact = await screen.findByRole('button', { name: /Synthetic contact.*pinned.*muted/i });
    await user.click(contact);

    expect(await screen.findByText('Message composer disabled in read-only mode')).toBeTruthy();
    expect(screen.getByText(/Read-only mode/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'New chat disabled in read-only mode' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Conversation actions' })).toBeNull();

    const message = await screen.findByRole('article', { name: /You: Synthetic failed message/ });
    await user.click(message);
    expect(document.activeElement).toBe(message);
    for (const key of ['r', 'Delete']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      message.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} must remain unavailable`).toBe(false);
    }
    fireEvent.contextMenu(message);
    fireEvent.pointerDown(message, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 560));
    });
    expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBeNull();
    fireEvent.pointerUp(message, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBeNull();

    const incomingHandler = socketState.handlers.get('message');
    expect(incomingHandler).toBeTypeOf('function');
    await act(async () => {
      incomingHandler?.({
        profileId: profile.id,
        direction: 'incoming',
        message: {
          id: 'message-2',
          conversationId: conversation.id,
          profileId: profile.id,
          direction: 'incoming',
          content: { text: 'Synthetic incoming message' },
          type: 'text',
          status: 'received',
          timestamp: '2026-01-01T00:01:00.000Z',
        },
      });
    });
    expect(await screen.findByText('Synthetic incoming message')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Search messages' }));
    await user.type(screen.getByPlaceholderText('Search messages'), 'synthetic');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/messages/search?'))).toBe(true), { timeout: 1500 });

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v1/profiles'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/conversations?'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`/api/v1/messages/conversation/${conversation.id}`))).toBe(true);
    expect(socketState.socket.emit.mock.calls.every(([event]) => ['join', 'unsubscribe:profile'].includes(event))).toBe(true);
    assertGetOnly();

    view.unmount();
    assertGetOnly();
  });

  it('activates normal interaction wiring, then blocks it and typing cleanup after a read-only transition', async () => {
    history.replaceState({}, '', '/dashboard/chat');
    const user = userEvent.setup();
    const view = render(<ChatPage />);

    await user.click(await screen.findByRole('button', { name: /Synthetic contact/ }));
    const message = await screen.findByRole('article', { name: /You: Synthetic failed message/ });
    await user.click(message);

    const replyEvent = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
    message.dispatchEvent(replyEvent);
    expect(replyEvent.defaultPrevented).toBe(true);
    expect(await screen.findByText(/Replying to/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel reply' }));

    const deleteEvent = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    message.dispatchEvent(deleteEvent);
    expect(deleteEvent.defaultPrevented).toBe(true);
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.contextMenu(message);
    expect(await screen.findByRole('menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.pointerDown(message, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 560));
    });
    expect(await screen.findByRole('dialog', { name: 'Message actions' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Cancel' }));

    await user.type(await screen.findByPlaceholderText('Type a message'), 'x');

    const typingCallsBefore = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/messages/typing'));
    expect(typingCallsBefore).toHaveLength(1);
    const requestBoundary = fetchMock.mock.calls.length;
    const emitBoundary = socketState.socket.emit.mock.calls.length;

    history.replaceState({}, '', '/dashboard/chat?readOnly=1');
    view.rerender(<ChatPage />);
    expect(await screen.findByText('Message composer disabled in read-only mode')).toBeTruthy();

    const readOnlyMessage = screen.getByRole('article', { name: /You: Synthetic failed message/ });
    await user.click(readOnlyMessage);
    for (const key of ['r', 'Delete']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      readOnlyMessage.dispatchEvent(event);
      expect(event.defaultPrevented, `${key} must be blocked after transition`).toBe(false);
    }
    fireEvent.contextMenu(readOnlyMessage);
    fireEvent.pointerDown(readOnlyMessage, { pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 10 });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 560));
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Message actions' })).toBeNull();

    const typingCallsAfter = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/v1/messages/typing'));
    expect(typingCallsAfter).toHaveLength(1);
    view.unmount();

    const postTransitionRequests = fetchMock.mock.calls.slice(requestBoundary);
    expect(postTransitionRequests.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'GET')).toBe(true);
    const postTransitionEmits = socketState.socket.emit.mock.calls.slice(emitBoundary);
    expect(postTransitionEmits.every(([event]) => ['join', 'unsubscribe:profile'].includes(event))).toBe(true);
  });
});
