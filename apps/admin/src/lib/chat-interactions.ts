export type ChatShortcutAction =
  | 'open-message-search'
  | 'focus-conversation-search'
  | 'send-message'
  | 'escape'
  | 'previous-search-result'
  | 'next-search-result'
  | 'reply-focused'
  | 'copy-focused'
  | 'delete-focused';

export function getVisibleWindow<T>(items: T[], limit: number) {
  return {
    items: items.slice(0, limit),
    hiddenCount: Math.max(0, items.length - limit),
  };
}

export function getNextVisibleLimit(current: number, total: number, step: number) {
  return Math.min(total, current + step);
}

export function isReadOnlyChatMode(value: string | null) {
  return value === '1';
}

export function shouldMarkConversationRead({
  readOnly,
  isDraft,
  unreadCount,
}: {
  readOnly: boolean;
  isDraft: boolean;
  unreadCount: number;
}) {
  return !readOnly && !isDraft && unreadCount > 0;
}

export function shouldLoadOlderMessages({
  scrollTop,
  initialScrollSettled,
  messagesLoading,
  olderMessagesLoading,
}: {
  scrollTop: number;
  initialScrollSettled: boolean;
  messagesLoading: boolean;
  olderMessagesLoading: boolean;
}) {
  return initialScrollSettled && !messagesLoading && !olderMessagesLoading && scrollTop < 80;
}

export function scrollTimelineToBottom(timeline: { scrollTop: number; scrollHeight: number } | null) {
  if (timeline) timeline.scrollTop = timeline.scrollHeight;
}

export function getCenteredScrollTop({
  elementOffsetTop,
  elementHeight,
  containerHeight,
}: {
  elementOffsetTop: number;
  elementHeight: number;
  containerHeight: number;
}) {
  return Math.max(0, elementOffsetTop - (containerHeight / 2) + (elementHeight / 2));
}

export function getAccessibleMessageLabel(sender: string, preview: string, timestamp: string) {
  const maxPreviewLength = 140;
  const boundedPreview = preview.length > maxPreviewLength
    ? `${preview.slice(0, maxPreviewLength - 1)}…`
    : preview;
  return `${sender}: ${boundedPreview}, ${timestamp}`;
}

export function shouldSendTypingStop(lastTypingSentAt: number, hasPendingTimer: boolean) {
  return lastTypingSentAt > 0 || hasPendingTimer;
}

interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
}

const isEditableTarget = (target: ShortcutEventLike['target']) => {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tagName = element?.tagName?.toUpperCase();
  return Boolean(element?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT');
};

export function resolveChatShortcut(
  event: ShortcutEventLike,
  hasFocusedMessage = false,
  composerTarget?: ShortcutEventLike['target'],
): ChatShortcutAction | null {
  const key = event.key.toLowerCase();
  const command = Boolean(event.ctrlKey || event.metaKey);
  if (key === 'escape') return 'escape';
  if (command && key === 'f') return 'open-message-search';
  if (command && key === 'k') return 'focus-conversation-search';
  if (command && key === 'enter') return composerTarget != null && event.target === composerTarget ? 'send-message' : null;
  if (event.altKey && key === 'arrowup') return 'previous-search-result';
  if (event.altKey && key === 'arrowdown') return 'next-search-result';
  if (isEditableTarget(event.target)) return null;
  if (!hasFocusedMessage || command || event.altKey) return null;
  if (key === 'r') return 'reply-focused';
  if (key === 'c') return 'copy-focused';
  if (key === 'delete' || key === 'backspace') return 'delete-focused';
  return null;
}

export function applyLiveTimelineUpdate<T>(
  canonical: T[] | null,
  visible: T[],
  update: (messages: T[]) => T[],
) {
  return {
    canonical: canonical ? update(canonical) : null,
    visible: update(visible),
  };
}

interface LongPressOptions<T> {
  delayMs?: number;
  movementPx?: number;
  onLongPress: (value: T) => void;
}

export function createLongPressController<T>({ delayMs = 500, movementPx = 10, onLongPress }: LongPressOptions<T>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    start(x: number, y: number, value: T) {
      cancel();
      startX = x;
      startY = y;
      timer = setTimeout(() => {
        timer = null;
        onLongPress(value);
      }, delayMs);
    },
    move(x: number, y: number) {
      if (Math.hypot(x - startX, y - startY) > movementPx) cancel();
    },
    end: cancel,
    cancel,
  };
}
