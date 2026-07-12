import { describe, expect, it, vi } from 'vitest';
import { applyLiveTimelineUpdate, createLongPressController, getVisibleWindow, resolveChatShortcut, shouldSendTypingStop } from './chat-interactions';

describe('getVisibleWindow', () => {
  it('caps large lists and reports the hidden count', () => {
    const items = Array.from({ length: 300 }, (_, index) => index);
    expect(getVisibleWindow(items, 250)).toEqual({ items: items.slice(0, 250), hiddenCount: 50 });
  });
});

describe('shouldSendTypingStop', () => {
  it('only clears presence after this client started typing', () => {
    expect(shouldSendTypingStop(0, false)).toBe(false);
    expect(shouldSendTypingStop(Date.now(), false)).toBe(true);
    expect(shouldSendTypingStop(0, true)).toBe(true);
  });
});

describe('resolveChatShortcut', () => {
  it('maps cross-platform search and only sends from the composer', () => {
    const composer = { tagName: 'TEXTAREA' };
    expect(resolveChatShortcut({ key: 'f', ctrlKey: true })).toBe('open-message-search');
    expect(resolveChatShortcut({ key: 'k', metaKey: true })).toBe('focus-conversation-search');
    expect(resolveChatShortcut({ key: 'Enter', metaKey: true, target: composer }, false, composer)).toBe('send-message');
    expect(resolveChatShortcut({ key: 'Enter', ctrlKey: true, target: { tagName: 'INPUT' } }, false, composer)).toBeNull();
    expect(resolveChatShortcut({ key: 'Enter', metaKey: true, target: { tagName: 'TEXTAREA' } }, false, composer)).toBeNull();
    expect(resolveChatShortcut({ key: 'Enter', ctrlKey: true, target: null }, false, composer)).toBeNull();
  });

  it('suppresses single-key message actions in editable targets', () => {
    expect(resolveChatShortcut({ key: 'r', target: { tagName: 'INPUT' } }, true)).toBeNull();
    expect(resolveChatShortcut({ key: 'c', target: { isContentEditable: true } }, true)).toBeNull();
    expect(resolveChatShortcut({ key: 'r', target: { tagName: 'DIV' } }, true)).toBe('reply-focused');
    expect(resolveChatShortcut({ key: 'Delete', target: { tagName: 'DIV' } }, true)).toBe('delete-focused');
  });

  it('prioritizes escape and maps search navigation', () => {
    expect(resolveChatShortcut({ key: 'Escape', target: { tagName: 'INPUT' } })).toBe('escape');
    expect(resolveChatShortcut({ key: 'ArrowUp', altKey: true, target: { tagName: 'INPUT' } })).toBe('previous-search-result');
    expect(resolveChatShortcut({ key: 'ArrowDown', altKey: true })).toBe('next-search-result');
  });
});

describe('applyLiveTimelineUpdate', () => {
  it('updates both visible context and the canonical timeline kept while context search is open', () => {
    const canonical = [{ id: 'old', status: 'sent' }, { id: 'latest', status: 'sent' }];
    const context = [{ id: 'old', status: 'sent' }];
    const update = (messages: typeof canonical) => [
      ...messages.map(message => message.id === 'latest' ? { ...message, status: 'read' } : message),
      { id: 'incoming', status: 'received' },
    ];

    expect(applyLiveTimelineUpdate(canonical, context, update)).toEqual({
      canonical: [{ id: 'old', status: 'sent' }, { id: 'latest', status: 'read' }, { id: 'incoming', status: 'received' }],
      visible: [{ id: 'old', status: 'sent' }, { id: 'incoming', status: 'received' }],
    });
  });

  it('only updates the visible timeline when no remote context is open', () => {
    expect(applyLiveTimelineUpdate(null, [{ id: 'one' }], messages => [...messages, { id: 'two' }])).toEqual({
      canonical: null,
      visible: [{ id: 'one' }, { id: 'two' }],
    });
  });
});

describe('createLongPressController', () => {
  it('opens after the delay and cancels on early release', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const controller = createLongPressController({ delayMs: 500, onLongPress: open });
    controller.start(10, 10, 'message-1');
    vi.advanceTimersByTime(499);
    expect(open).not.toHaveBeenCalled();
    controller.end();
    vi.advanceTimersByTime(1);
    expect(open).not.toHaveBeenCalled();
    controller.start(10, 10, 'message-2');
    vi.advanceTimersByTime(500);
    expect(open).toHaveBeenCalledWith('message-2');
    vi.useRealTimers();
  });

  it('cancels when movement exceeds the threshold or scrolling starts', () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const controller = createLongPressController({ delayMs: 500, movementPx: 10, onLongPress: open });
    controller.start(10, 10, 'moving');
    controller.move(21, 10);
    vi.advanceTimersByTime(500);
    controller.start(10, 10, 'scrolling');
    controller.cancel();
    vi.advanceTimersByTime(500);
    expect(open).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
