export type ChatMessageGroupPosition = 'single' | 'first' | 'middle' | 'last';

export interface GroupableChatMessage {
  id: string;
  timestamp: string;
  direction: 'incoming' | 'outgoing';
  type: string;
  senderPhone?: string;
  senderJid?: string;
  senderName?: string;
  metadata?: {
    senderPhone?: string;
    originalSenderJid?: string;
    senderName?: string;
  };
}

export interface GroupedChatMessage<T extends GroupableChatMessage> {
  message: T;
  position: ChatMessageGroupPosition;
  showTail: boolean;
  showSenderName: boolean;
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const ISOLATED_MESSAGE_TYPES = new Set(['system', 'protocol', 'status', 'revoked']);

const senderIdentity = (message: GroupableChatMessage) => {
  if (message.direction === 'outgoing') return 'outgoing';
  return message.senderPhone
    || message.metadata?.senderPhone
    || message.senderJid
    || message.metadata?.originalSenderJid
    || message.senderName
    || message.metadata?.senderName
    || 'incoming';
};

const canGroup = (left: GroupableChatMessage | undefined, right: GroupableChatMessage | undefined) => {
  if (!left || !right) return false;
  if (ISOLATED_MESSAGE_TYPES.has(left.type) || ISOLATED_MESSAGE_TYPES.has(right.type)) return false;
  if (left.direction !== right.direction || senderIdentity(left) !== senderIdentity(right)) return false;

  const leftTime = new Date(left.timestamp);
  const rightTime = new Date(right.timestamp);
  if (Number.isNaN(leftTime.getTime()) || Number.isNaN(rightTime.getTime())) return false;
  if (leftTime.toDateString() !== rightTime.toDateString()) return false;

  const gap = rightTime.getTime() - leftTime.getTime();
  return gap >= 0 && gap <= GROUP_WINDOW_MS;
};

export function groupChatMessages<T extends GroupableChatMessage>(messages: T[]): GroupedChatMessage<T>[] {
  return messages.map((message, index) => {
    const joinsPrevious = canGroup(messages[index - 1], message);
    const joinsNext = canGroup(message, messages[index + 1]);
    const position: ChatMessageGroupPosition = joinsPrevious
      ? (joinsNext ? 'middle' : 'last')
      : (joinsNext ? 'first' : 'single');

    return {
      message,
      position,
      showTail: position === 'single' || position === 'last',
      showSenderName: message.direction === 'incoming' && (position === 'single' || position === 'first'),
    };
  });
}
