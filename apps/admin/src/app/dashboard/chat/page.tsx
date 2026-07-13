// MultiWA Admin - WhatsApp-style Chat Interface
// apps/admin/src/app/dashboard/chat/page.tsx

'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { getSocketUrl } from '@/lib/socket';
import { api, Profile, Conversation, Contact } from '@/lib/api';
import { groupChatMessages } from '@/lib/chat-message-grouping';
import { applyPresenceEvent, expireTransientPresence, getPresenceLabel, type ChatPresenceEvent, type PresenceRecords } from '@/lib/chat-presence';
import { applyLiveTimelineUpdate, createLongPressController, getAccessibleMessageLabel, getCenteredScrollTop, getVisibleWindow, isReadOnlyChatMode, resolveChatShortcut, scrollTimelineToBottom, shouldLoadOlderMessages, shouldMarkConversationRead, shouldSendTypingStop } from '@/lib/chat-interactions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

// Message interface
interface Message {
  id: string;
  messageId?: string; // WhatsApp serialized message ID
  conversationId: string;
  content: any;
  type: string;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
  timestamp: string;
  senderName?: string;
  senderPhone?: string;
  senderJid?: string;
  quotedMessageId?: string;
  reactions?: string[];
  metadata?: {
    senderName?: string;
    senderPhone?: string;
    originalSenderJid?: string;
  };
}

interface PendingAttachment {
  file: File;
  objectUrl: string;
  type: 'image' | 'video' | 'audio' | 'document';
}

const MESSAGE_PAGE_SIZE = 40;

const normalizeNewChatPhone = (value: string) => {
  let phone = value.replace(/\D/g, '');
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  return phone;
};

const isValidInternationalPhone = (phone: string) => /^[1-9]\d{6,14}$/.test(phone);

const canonicalConversationPhone = (jid: string) => jid.replace(/@(s\.whatsapp\.net|c\.us)$/, '');

// Format phone number for display
const formatPhone = (phone: string) => {
  if (!phone) return '';
  if (phone.includes('@lid')) return '';
  const cleaned = phone.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@c.us', '');
  if (cleaned.startsWith('62')) {
    return `+${cleaned.slice(0, 2)} ${cleaned.slice(2, 5)}-${cleaned.slice(5, 9)}-${cleaned.slice(9)}`;
  }
  return cleaned;
};

const displayPhone = (conv: any) => formatPhone(conv?.contactPhone || '');

const displayWhatsAppId = (jid?: string) => {
  if (!jid) return '';
  if (jid.includes('@lid')) return 'Provider alias hidden';
  return jid;
};

const contactLookupPhone = (conv: any) => {
  const phone = conv?.contactPhone || (conv?.jid?.includes('@s.whatsapp.net') ? conv.jid.split('@')[0] : '');
  return phone && !phone.includes('@lid') ? phone : '';
};

const sanitizeChatText = (text?: string) => {
  if (!text) return text;
  return text.replace(/@(\d{12,})/g, (match, digits) => {
    if (digits.startsWith('60') && digits.length <= 13) return match;
    return '@Unknown WhatsApp contact';
  });
};

const getLastMessagePreview = (lastMessage: any) => {
  if (!lastMessage) return 'No messages';

  const rawText = lastMessage.content?.text || lastMessage.content?.caption;
  if (rawText) return sanitizeChatText(rawText);

  switch (lastMessage.type) {
    case 'image': return '🖼️ Image';
    case 'video': return '🎥 Video';
    case 'audio': return '🎵 Audio';
    case 'document': return '📄 Document';
    case 'location': return `📍 ${sanitizeChatText(lastMessage.content?.name) || 'Location'}`;
    case 'vcard':
    case 'contact':
    case 'contacts': return '👤 Contact';
    case 'sticker': return '🏷️ Sticker';
    case 'poll':
    case 'poll_creation': return '📊 Poll';
    case 'ptt': return '🎙️ Voice message';
    default: return '💬 Message';
  }
};

const getMessagePreview = (message: Message) => {
  const text = message.content?.text || message.content?.caption;
  if (text) return sanitizeChatText(text);
  return getLastMessagePreview(message);
};

const foldReactionMessages = (items: Message[]) => {
  const visible = items.filter(message => message.type !== 'reaction').map(message => ({ ...message }));
  for (const reaction of items.filter(message => message.type === 'reaction')) {
    const targetId = reaction.content?.messageId;
    const target = visible.find(message => message.id === targetId || message.messageId === targetId);
    const emoji = reaction.content?.emoji;
    if (target && emoji) target.reactions = [...(target.reactions || []), emoji];
  }
  return visible;
};

// Fix media URLs that use Docker-internal hostnames
// Replaces internal addresses with the browser's current hostname
// so images load correctly from any machine on the network.
const fixMediaUrl = (url?: string): string => {
  if (!url) return '';
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    return url
      .replace(/http:\/\/minio:9000/g, `http://${hostname}:9000`)
      .replace(/http:\/\/0\.0\.0\.0:3333/g, `http://${hostname}:3333`)
      .replace(/http:\/\/127\.0\.0\.1:3333/g, `http://${hostname}:3333`);
  }
  return url
    .replace(/http:\/\/minio:9000/g, 'http://localhost:9000')
    .replace(/http:\/\/0\.0\.0\.0:3333/g, 'http://127.0.0.1:3333');
};

// Check if a name looks like a raw JID (e.g. "120363421805328930@g.us" or "6282283011108@s.whatsapp.net" or all digits)
const isJidLikeName = (name: string) => {
  if (!name) return true;
  const trimmed = name.trim();
  // Check for full JID pattern
  if (trimmed.includes('@s.whatsapp.net') || trimmed.includes('@g.us') || trimmed.includes('@c.us') || trimmed.includes('@lid')) return true;
  // Check for all-digit string
  return /^[0-9]+$/.test(trimmed);
};

// Get best display name for a conversation
const getDisplayName = (conv: any) => {
  // Groups must use the group title, not the latest participant/contact name.
  if (conv.type === 'group' || conv.jid?.includes('@g.us')) {
    if (conv.name && !isJidLikeName(conv.name)) return conv.name;
    if (conv.contactName && !isJidLikeName(conv.contactName)) return conv.contactName;
    return 'Group Chat';
  }
  // Prefer real human-readable names only. Numeric contact names are usually
  // raw provider/phone identities and should not be shown as chat names.
  if (conv.contactName && !isJidLikeName(conv.contactName)) return conv.contactName;
  // If name exists and doesn't look like a raw JID, use it (e.g. actual group names synced from WA)
  if (conv.name && !isJidLikeName(conv.name)) return conv.name;
  // Do not fall back to raw phone/JID in chat identity surfaces.
  return 'Unknown WhatsApp contact';
};

const getConversationSubtitle = (conv: any) => {
  if (!conv) return '';
  if (conv.type === 'group' || conv.jid?.includes('@g.us')) return '';
  return displayPhone(conv);
};

const getMessageSenderLabel = (msg: Message) => {
  const name = msg.senderName || msg.metadata?.senderName;
  if (name && !isJidLikeName(name)) return name;

  const phone = msg.senderPhone || msg.metadata?.senderPhone;
  if (phone) return formatPhone(phone);

  const jidPhone = msg.senderJid?.includes('@s.whatsapp.net') || msg.senderJid?.includes('@c.us')
    ? msg.senderJid.split('@')[0]
    : '';

  return jidPhone ? formatPhone(jidPhone) : 'Unknown WhatsApp contact';
};

const getReplySenderLabel = (msg: Message, conversation: Conversation) => {
  if (msg.direction === 'outgoing') return 'You';
  const sender = getMessageSenderLabel(msg);
  return sender === 'Unknown WhatsApp contact' ? getDisplayName(conversation) : sender;
};

// Format timestamp
const formatTime = (timestamp: string) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const formatDateLabel = (timestamp: string) => {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'TODAY';
  if (date.toDateString() === yesterday.toDateString()) return 'YESTERDAY';
  return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
};

const startsNewDay = (messages: Message[], index: number) => {
  if (index === 0) return true;
  return new Date(messages[index - 1].timestamp).toDateString() !== new Date(messages[index].timestamp).toDateString();
};

// Message status icon
const MessageStatus = ({ status }: { status: string }) => {
  switch (status) {
    case 'pending':
      return <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2"/></svg>;
    case 'sent':
      return <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>;
    case 'delivered':
      return (
        <svg className="w-4 h-4 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 13l4 4L16 7" /><path d="M8 13l4 4L22 7" />
        </svg>
      );
    case 'read':
      return (
        <svg className="w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 13l4 4L16 7" /><path d="M8 13l4 4L22 7" />
        </svg>
      );
    case 'failed':
      return <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
    default:
      return null;
  }
};

export default function ChatPage() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const readOnly = isReadOnlyChatMode(searchParams.get('readOnly'));
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('connecting');
  const [presenceRecords, setPresenceRecords] = useState<PresenceRecords>({});
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [attachmentCaption, setAttachmentCaption] = useState('');
  const [attachmentSending, setAttachmentSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentTempMessageId, setAttachmentTempMessageId] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatContacts, setNewChatContacts] = useState<Contact[]>([]);
  const [newChatQuery, setNewChatQuery] = useState('');
  const [newChatLoading, setNewChatLoading] = useState(false);
  const [newChatError, setNewChatError] = useState<string | null>(null);
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [activeMessageMenu, setActiveMessageMenu] = useState<string | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [actionSheetMessage, setActionSheetMessage] = useState<Message | null>(null);
  const [reactionPickerMessage, setReactionPickerMessage] = useState<Message | null>(null);
  const [showMessageSearch, setShowMessageSearch] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [remoteMessageSearchMatches, setRemoteMessageSearchMatches] = useState<Message[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [messageSearchError, setMessageSearchError] = useState<string | null>(null);
  const [messageSearchRetryNonce, setMessageSearchRetryNonce] = useState(0);
  const [messageSearchHasMore, setMessageSearchHasMore] = useState(false);
  const [messageSearchNextCursor, setMessageSearchNextCursor] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showThreeDotMenu, setShowThreeDotMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showContactInfo, setShowContactInfo] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [emojiCategory, setEmojiCategory] = useState('smileys');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messageElementRefs = useRef(new Map<string, HTMLDivElement>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  const messageSearchInputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const lastTypingSentRef = useRef<number>(0);
  const typingStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const conversationRequestRef = useRef(0);
  const messageRequestRef = useRef(0);
  const olderMessagesRequestRef = useRef(false);
  const initialScrollSettledRef = useRef(false);
  const previousLastMessageIdRef = useRef<string | null>(null);
  const retryingMessageRef = useRef<string | null>(null);
  const selectedConversationRef = useRef<Conversation | null>(null);
  const materializedConversationIdRef = useRef<string | null>(null);
  const startingNewChatRef = useRef(false);
  const messageSearchRequestRef = useRef(0);
  const messageContextRequestRef = useRef(0);
  const preSearchMessagesRef = useRef<Message[] | null>(null);
  const longPressControllerRef = useRef<ReturnType<typeof createLongPressController<Message>> | null>(null);
  if (!longPressControllerRef.current) {
    longPressControllerRef.current = createLongPressController({
      delayMs: 500,
      movementPx: 10,
      onLongPress: message => {
        setFocusedMessageId(message.id);
        setActionSheetMessage(message);
      },
    });
  }

  // Emoji categories
  const emojiCategories: Record<string, { label: string; emojis: string[] }> = {
    smileys: { label: '😊', emojis: ['😊', '😂', '🤣', '😍', '🥰', '😘', '😜', '🤔', '😎', '🥳', '😴', '🤯', '😱', '😇', '🫡', '🙄'] },
    gestures: { label: '👍', emojis: ['👍', '👎', '👏', '🙌', '🤝', '💪', '🤞', '✌️', '🤟', '👋', '🫶', '🙏', '✋', '🤙', '👊', '🤘'] },
    hearts: { label: '❤️', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💕', '💖', '💗', '💝', '💘', '❣️', '💔', '🫀'] },
    objects: { label: '🎉', emojis: ['🎉', '🎊', '🏆', '🎯', '🎵', '📱', '💻', '📸', '🔑', '💡', '📌', '📎', '✏️', '📝', '📋', '📊'] },
    symbols: { label: '✅', emojis: ['✅', '❌', '⭐', '🔥', '💯', '⚡', '💫', '🌟', '✨', '🎯', '🚀', '💎', '🏅', '🎗️', '🔔', '📢'] },
    nature: { label: '🌿', emojis: ['🌿', '🌸', '🌺', '🌻', '🌼', '🍀', '🌙', '☀️', '🌈', '🔥', '💧', '⛄', '🌊', '🌴', '🍁', '🌾'] },
  };

  const normalizedMessageSearch = messageSearchQuery.trim().toLowerCase();
  const localMessageSearchMatches = normalizedMessageSearch
    ? messages.filter(message => {
        const searchableText = message.content?.text || message.content?.caption || message.content?.filename || '';
        return searchableText.toLowerCase().includes(normalizedMessageSearch);
      })
    : [];
  const messageSearchMatches = Array.from(new Map(
    [...localMessageSearchMatches, ...remoteMessageSearchMatches].map(message => [message.id, message])
  ).values());
  const activeSearchMessageId = messageSearchMatches[currentSearchIndex]?.id;
  const groupedMessages = groupChatMessages(messages);
  const presenceLabel = getPresenceLabel(
    presenceRecords,
    selectedConversation?.type || 'individual',
    new Date(),
    jid => {
      const sender = messages.find(message => message.senderJid === jid || message.metadata?.originalSenderJid === jid);
      return sender ? getMessageSenderLabel(sender) : formatPhone(jid.split('@')[0]);
    },
  );
  const conversationSubtitle = presenceLabel || getConversationSubtitle(selectedConversation);
  const scrollMessageIntoTimeline = (element: HTMLDivElement, behavior: ScrollBehavior = 'smooth') => {
    const timeline = messagesContainerRef.current;
    if (!timeline) return;
    const timelineRect = timeline.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    timeline.scrollTo({
      top: getCenteredScrollTop({
        elementOffsetTop: timeline.scrollTop + elementRect.top - timelineRect.top,
        elementHeight: elementRect.height,
        containerHeight: timeline.clientHeight,
      }),
      behavior,
    });
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    const requestId = ++messageSearchRequestRef.current;
    setCurrentSearchIndex(0);
    setRemoteMessageSearchMatches([]);
    setMessageSearchHasMore(false);
    setMessageSearchNextCursor(null);
    setMessageSearchError(null);
    if (!showMessageSearch || normalizedMessageSearch.length < 2 || !selectedConversation || selectedConversation.id.startsWith('draft:') || !selectedProfile) {
      setMessageSearchLoading(false);
      return;
    }

    const timeout = window.setTimeout(async () => {
      setMessageSearchLoading(true);
      const conversationId = selectedConversation.id;
      try {
        const response = await api.searchConversationMessages(conversationId, selectedProfile, messageSearchQuery.trim(), { limit: 30 });
        if (requestId !== messageSearchRequestRef.current || selectedConversationRef.current?.id !== conversationId) return;
        if (!response.data) throw new Error(response.error || 'Could not search message history');
        setRemoteMessageSearchMatches(response.data.messages || []);
        setMessageSearchHasMore(response.data.hasMore);
        setMessageSearchNextCursor(response.data.nextCursor);
      } catch (error) {
        if (requestId !== messageSearchRequestRef.current) return;
        setMessageSearchError(error instanceof Error ? error.message : 'Could not search message history');
      } finally {
        if (requestId === messageSearchRequestRef.current) setMessageSearchLoading(false);
      }
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [messageSearchQuery, normalizedMessageSearch, selectedConversation?.id, selectedProfile, showMessageSearch, messageSearchRetryNonce]);

  useEffect(() => {
    if (!activeSearchMessageId || !selectedConversation || !selectedProfile) return;
    const loadedElement = messageElementRefs.current.get(activeSearchMessageId);
    if (loadedElement) {
      scrollMessageIntoTimeline(loadedElement);
      return;
    }

    const requestId = ++messageContextRequestRef.current;
    const conversationId = selectedConversation.id;
    void api.getConversationMessageContext(conversationId, activeSearchMessageId, selectedProfile, { before: 20, after: 20 }).then(response => {
      if (requestId !== messageContextRequestRef.current || selectedConversationRef.current?.id !== conversationId || !response.data) return;
      setMessages(current => {
        if (!preSearchMessagesRef.current) preSearchMessagesRef.current = current;
        return response.data?.messages || [];
      });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const element = messageElementRefs.current.get(activeSearchMessageId);
        if (element) scrollMessageIntoTimeline(element);
      }));
    }).catch(() => {
      if (requestId === messageContextRequestRef.current) setMessageSearchError('Could not load message context');
    });
  }, [activeSearchMessageId, selectedConversation?.id, selectedProfile]);

  useEffect(() => {
    const objectUrl = pendingAttachment?.objectUrl;
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pendingAttachment?.objectUrl]);

  // WebSocket connection for real-time message status updates
  useEffect(() => {
    if (!selectedProfile) return;

    setConnectionState('connecting');
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const socket = io(`${getSocketUrl()}/ws`, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[WS] Connected, joining profile:', selectedProfile);
      setConnectionState('connected');
      socket.emit('join', { profileId: selectedProfile });
    });

    socket.on('disconnect', (reason) => {
      console.log('[WS] Disconnected:', reason);
      setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
      setPresenceRecords({});
    });

    socket.io.on('reconnect_attempt', () => {
      setConnectionState('reconnecting');
    });

    socket.io.on('reconnect', (attempt) => {
      console.log('[WS] Reconnected after', attempt, 'attempts');
      setConnectionState('connected');
      socket.emit('join', { profileId: selectedProfile });
    });

    socket.on('connection:status', (data: { profileId: string; status: string }) => {
      if (data.profileId !== selectedProfile) return;
      if (data.status === 'connected') setConnectionState('connected');
      if (data.status === 'disconnected') {
        setConnectionState('disconnected');
        setPresenceRecords({});
      }
      if (data.status === 'connecting' || data.status === 'reconnecting') setConnectionState('reconnecting');
    });

    // Real-time message status updates (sent → delivered → read)
    socket.on('message:ack', (data: { profileId: string; messageId: string; status: string }) => {
      if (data.profileId === selectedProfile) {
        setMessages(prev => {
          const update = (timeline: Message[]) => timeline.map(msg => {
            // Match by WhatsApp messageId (primary match)
            if (msg.messageId && msg.messageId === data.messageId) {
              return { ...msg, status: data.status as Message['status'] };
            }
            return msg;
          });
          const updated = applyLiveTimelineUpdate(preSearchMessagesRef.current, prev, update);
          preSearchMessagesRef.current = updated.canonical;
          return updated.visible;
        });
      }
    });

    socket.on('presence:update', (data: ChatPresenceEvent) => {
      const conversationId = selectedConversationRef.current?.id;
      if (!conversationId) return;
      setPresenceRecords(current => applyPresenceEvent(current, data, selectedProfile, conversationId));
    });

    // Real-time incoming messages
    // Backend emits: { type: 'message:received', message: savedMessage, conversation }
    socket.on('message', (data: any) => {
      const msg = data.message || data;
      const msgProfileId = msg.profileId || data.profileId;
      const msgDirection = msg.direction || data.direction;
      
      if (msgProfileId === selectedProfile && msgDirection === 'incoming') {
        if (msg.conversationId !== selectedConversationRef.current?.id) {
          loadConversations();
          return;
        }
        setMessages(prev => {
          const update = (timeline: Message[]) => {
            // Avoid duplicates
            if (timeline.some(m => m.id === msg.id || (m.messageId && msg.messageId && m.messageId === msg.messageId))) return timeline;
            return foldReactionMessages([...timeline, msg as Message]);
          };
          const updated = applyLiveTimelineUpdate(preSearchMessagesRef.current, prev, update);
          preSearchMessagesRef.current = updated.canonical;
          return updated.visible;
        });
        // Refresh conversations to update last message
        loadConversations().then(() => {
          // If this message belongs to the currently open conversation, 
          // mark it as read immediately so badge doesn't increment
          setSelectedConversation(current => {
            if (!readOnly && current && msg.conversationId === current.id) {
              api.markAsRead(current.id).catch(() => {});
              // Also clear badge in conversation list
              setConversations(prev => prev.map(c =>
                c.id === current.id ? { ...c, unreadCount: 0 } : c
              ));
            }
            return current;
          });
        });
      }
    });

    return () => {
      socket.emit('unsubscribe:profile', { profileId: selectedProfile });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [selectedProfile, readOnly]);

  useEffect(() => {
    setPresenceRecords({});
    const interval = setInterval(() => {
      setPresenceRecords(current => expireTransientPresence(current));
    }, 1000);
    return () => clearInterval(interval);
  }, [selectedProfile, selectedConversation?.id]);

  useEffect(() => () => {
    const clearRemoteTyping = shouldSendTypingStop(lastTypingSentRef.current, Boolean(typingStopTimeoutRef.current));
    if (typingStopTimeoutRef.current) {
      clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }
    lastTypingSentRef.current = 0;
    if (!readOnlyRef.current && clearRemoteTyping && selectedProfile && selectedConversation) {
      api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid, state: 'available' }).catch(() => {});
    }
  }, [readOnly, selectedProfile, selectedConversation?.id]);

  useEffect(() => {
    if (selectedProfile) {
      setConversations([]);
      setSelectedConversation(null);
      setMessages([]);
      setShowNewChat(false);
      setNewChatContacts([]);
      setNewChatQuery('');
      setNewChatError(null);
      setHasMoreMessages(false);
      loadConversations(true);
    }
  }, [selectedProfile]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversation;
    if (selectedConversation) {
      if (materializedConversationIdRef.current === selectedConversation.id) {
        materializedConversationIdRef.current = null;
        return;
      }
      longPressControllerRef.current?.cancel();
      setFocusedMessageId(null);
      setActionSheetMessage(null);
      setActiveMessageMenu(null);
      setReactionPickerMessage(null);
      setShowDeleteConfirm(null);
      setReplyTo(null);
      setShowMessageSearch(false);
      setMessageSearchQuery('');
      setRemoteMessageSearchMatches([]);
      setMessageSearchError(null);
      messageSearchRequestRef.current += 1;
      messageContextRequestRef.current += 1;
      preSearchMessagesRef.current = null;
      setPendingAttachment(null);
      setAttachmentCaption('');
      setAttachmentError(null);
      setAttachmentTempMessageId(null);
      setMessages([]);
      setHasMoreMessages(false);
      setOlderMessagesLoading(false);
      setIsAtBottom(true);
      setNewMessagesBelow(0);
      initialScrollSettledRef.current = false;
      previousLastMessageIdRef.current = null;
      if (selectedConversation.id.startsWith('draft:')) {
        setMessagesLoading(false);
      } else {
        loadMessages(selectedConversation.id);
      }
      // Mark as read when opening a conversation unless this is an explicitly read-only session.
      if (shouldMarkConversationRead({
        readOnly,
        isDraft: selectedConversation.id.startsWith('draft:'),
        unreadCount: selectedConversation.unreadCount,
      })) {
        api.markAsRead(selectedConversation.id).catch(() => {});
        // Clear unread badge in local state
        setConversations(prev => prev.map(c =>
          c.id === selectedConversation.id ? { ...c, unreadCount: 0 } : c
        ));
        setSelectedConversation(prev => prev ? { ...prev, unreadCount: 0 } : prev);
      }
    }
  }, [selectedConversation?.id, readOnly]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    const nearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    const lastMessageId = messages[messages.length - 1]?.id || null;
    const appendedAtTail = Boolean(previousLastMessageIdRef.current && lastMessageId && previousLastMessageIdRef.current !== lastMessageId);

    if (!previousLastMessageIdRef.current || nearBottom || messagesLoading) {
      scrollToBottom(messagesLoading ? 'auto' : 'smooth');
      setIsAtBottom(true);
      setNewMessagesBelow(0);
    } else if (appendedAtTail) {
      setNewMessagesBelow(count => count + 1);
    }
    previousLastMessageIdRef.current = lastMessageId;
  }, [messages, messagesLoading]);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const timeline = messagesContainerRef.current;
    if (behavior === 'smooth' && timeline?.scrollTo) {
      timeline.scrollTo({ top: timeline.scrollHeight, behavior });
    } else {
      scrollTimelineToBottom(timeline);
    }
    requestAnimationFrame(() => {
      initialScrollSettledRef.current = true;
    });
    setIsAtBottom(true);
    setNewMessagesBelow(0);
  };

  const loadProfiles = async () => {
    const res = await api.getProfiles();
    if (res.data) {
      setProfiles(res.data);
      if (res.data.length > 0) {
        conversationRequestRef.current += 1;
        messageRequestRef.current += 1;
        setConversationsLoading(true);
        setSelectedProfile(res.data[0].id);
      }
    }
    setLoading(false);
  };

  const loadConversations = async (showLoading = false) => {
    const requestId = ++conversationRequestRef.current;
    if (showLoading) setConversationsLoading(true);
    setConversationsError(null);
    try {
      const res = await api.getConversations(selectedProfile);
      if (requestId !== conversationRequestRef.current) return;
      if (res.data) {
        const rawConvs = res.data.conversations || [];
        // Filter out status@broadcast (WhatsApp broadcast status updates)
        const filteredConvs = rawConvs.filter((conv: Conversation) =>
          !conv.jid?.includes('status@broadcast') && !conv.jid?.includes('@broadcast')
        );
        // Deduplicate by normalized JID (strip @c.us / @s.whatsapp.net / @g.us suffixes)
        // This handles legacy @c.us vs current @s.whatsapp.net for the same phone number
        const normalizeJid = (jid: string) => jid?.replace(/@(s\.whatsapp\.net|c\.us|g\.us)$/, '') || jid;
        const jidMap = new Map<string, Conversation>();
        for (const conv of filteredConvs) {
          const key = normalizeJid(conv.jid);
          const existing = jidMap.get(key);
          if (!existing) {
            jidMap.set(key, conv);
          } else {
            // Keep the one with the most recent lastMessageAt, sum unreadCounts
            const existingTime = new Date(existing.lastMessageAt || 0).getTime();
            const newTime = new Date(conv.lastMessageAt || 0).getTime();
            if (newTime > existingTime) {
              jidMap.set(key, { ...conv, unreadCount: conv.unreadCount + existing.unreadCount });
            } else {
              jidMap.set(key, { ...existing, unreadCount: existing.unreadCount + conv.unreadCount });
            }
          }
        }
        setConversations(Array.from(jidMap.values()));
      } else {
        setConversationsError('Could not load conversations.');
      }
    } catch {
      if (requestId === conversationRequestRef.current) {
        setConversationsError('Could not load conversations.');
      }
    } finally {
      if (requestId === conversationRequestRef.current) {
        setConversationsLoading(false);
      }
    }
  };

  const loadMessages = async (conversationId: string) => {
    const requestId = ++messageRequestRef.current;
    setMessagesLoading(true);
    setMessagesError(null);
    try {
      const res = await api.getMessages(conversationId, { limit: MESSAGE_PAGE_SIZE });
      if (requestId !== messageRequestRef.current) return;
      if (res.data) {
        // API returns { messages: [...], hasMore } or possibly an array
        const raw = res.data as any;
        const msgArray = Array.isArray(raw) ? raw : (raw.messages || []);
        setMessages(foldReactionMessages(msgArray));
        setHasMoreMessages(Array.isArray(raw) ? msgArray.length === MESSAGE_PAGE_SIZE : Boolean(raw.hasMore));
      } else {
        setMessagesError('Could not load messages.');
      }
    } catch {
      if (requestId === messageRequestRef.current) {
        setMessagesError('Could not load messages.');
      }
    } finally {
      if (requestId === messageRequestRef.current) {
        setMessagesLoading(false);
      }
    }
  };

  const loadOlderMessages = async () => {
    if (!selectedConversation || !hasMoreMessages || olderMessagesRequestRef.current || messages.length === 0) return;

    const timeline = messagesContainerRef.current;
    const oldestMessage = messages[0];
    const requestId = messageRequestRef.current;
    const previousScrollHeight = timeline?.scrollHeight || 0;
    olderMessagesRequestRef.current = true;
    setOlderMessagesLoading(true);

    try {
      const res = await api.getMessages(selectedConversation.id, {
        limit: MESSAGE_PAGE_SIZE,
        before: oldestMessage.id,
      });
      if (requestId !== messageRequestRef.current || !res.data) return;

      const raw = res.data as any;
      const older = Array.isArray(raw) ? raw : (raw.messages || []);
      setHasMoreMessages(Array.isArray(raw) ? older.length === MESSAGE_PAGE_SIZE : Boolean(raw.hasMore));
      setMessages(current => {
        const currentIds = new Set(current.map(message => message.id));
        const uniqueOlder = older.filter((message: Message) => !currentIds.has(message.id));
        return foldReactionMessages([...uniqueOlder, ...current]);
      });

      requestAnimationFrame(() => requestAnimationFrame(() => {
        const currentTimeline = messagesContainerRef.current;
        if (currentTimeline) currentTimeline.scrollTop = currentTimeline.scrollHeight - previousScrollHeight;
      }));
    } catch {
      toast({ title: 'Could not load older messages', variant: 'destructive' });
    } finally {
      olderMessagesRequestRef.current = false;
      if (requestId === messageRequestRef.current) setOlderMessagesLoading(false);
    }
  };

  const handleSend = async () => {
    if (readOnly || !messageInput.trim() || !selectedConversation || sending) return;

    setSending(true);
    const tempId = `temp-${Date.now()}`;
    const tempMessage: Message = {
      id: tempId,
      conversationId: selectedConversation.id,
      content: { text: messageInput },
      type: 'text',
      direction: 'outgoing',
      status: 'pending',
      timestamp: new Date().toISOString(),
      quotedMessageId: replyTo?.id,
    };

    // Optimistic update
    setMessages(prev => [...prev, tempMessage]);
    requestAnimationFrame(() => scrollToBottom());
    const messageText = messageInput;
    const quotedMessage = replyTo;
    setMessageInput('');
    setReplyTo(null);
    if (typingStopTimeoutRef.current) {
      clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }

    try {
      // Briefly show the recipient a typing indicator before sending.
      api.sendTyping({
        profileId: selectedProfile,
        to: selectedConversation.jid,
        duration: 2000,
      }).catch(() => {});

      await new Promise(resolve => setTimeout(resolve, 1500));

      const res = quotedMessage
        ? await api.sendReply({
            profileId: selectedProfile,
            quotedMessageId: quotedMessage.id,
            text: messageText,
          })
        : await api.sendMessage({
            profileId: selectedProfile,
            to: selectedConversation.jid,
            text: messageText,
          });

      if (res.data) {
        // Update message with real data including WhatsApp messageId for ack matching
        setMessages(prev => prev.map(m => 
          m.id === tempId ? { ...m, id: res.data.messageId || tempId, conversationId: res.data.conversationId || m.conversationId, messageId: res.data.waMessageId, status: 'sent' } : m
        ));
        if (selectedConversation.id.startsWith('draft:') && res.data.conversationId) {
          const materialized: Conversation = {
            ...selectedConversation,
            id: res.data.conversationId,
            lastMessageAt: new Date().toISOString(),
            lastMessage: { type: 'text', content: { text: messageText }, timestamp: new Date().toISOString(), status: 'sent', direction: 'outgoing' },
          };
          materializedConversationIdRef.current = materialized.id;
          setConversations(current => [materialized, ...current.filter(conversation => conversation.id !== materialized.id)]);
          setSelectedConversation(materialized);
        }
      } else {
        setMessages(prev => prev.map(m => 
          m.id === tempId ? { ...m, status: 'failed' } : m
        ));
        toast({ title: 'Failed to send message', variant: 'destructive' });
      }
    } catch (error) {
      setMessages(prev => prev.map(m => 
        m.id === tempId ? { ...m, status: 'failed' } : m
      ));
      toast({ title: 'Failed to send message', variant: 'destructive' });
    }
    api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid, state: 'available' }).catch(() => {});
    lastTypingSentRef.current = 0;
    setSending(false);
  };

  const handleRetryMessage = async (message: Message) => {
    if (readOnly || !selectedConversation || message.status !== 'failed' || retryingMessageRef.current) return;

    retryingMessageRef.current = message.id;
    setRetryingMessageId(message.id);
    setMessages(current => current.map(item => item.id === message.id ? { ...item, status: 'pending' } : item));

    try {
      api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid, duration: 2000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1500));

      const text = message.content?.text || message.content?.caption || '';
      const res = message.quotedMessageId
        ? await api.sendReply({ profileId: selectedProfile, quotedMessageId: message.quotedMessageId, text })
        : await api.sendMessage({ profileId: selectedProfile, to: selectedConversation.jid, text });

      if (!res.data) throw new Error('Retry failed');
      setMessages(current => current.map(item => item.id === message.id
        ? { ...item, id: res.data.messageId || item.id, messageId: res.data.waMessageId, status: 'sent' }
        : item));
    } catch {
      setMessages(current => current.map(item => item.id === message.id ? { ...item, status: 'failed' } : item));
      toast({ title: 'Retry failed', description: 'The message was not sent. Try again when the connection is restored.', variant: 'destructive' });
    } finally {
      retryingMessageRef.current = null;
      setRetryingMessageId(null);
    }
  };

  const clearAttachmentPreview = () => {
    setPendingAttachment(null);
    setAttachmentCaption('');
    setAttachmentError(null);
    setAttachmentTempMessageId(null);
    if (attachRef.current) attachRef.current.value = '';
  };

  const handleAttachmentSelected = (file: File) => {
    if (readOnly) return;
    const allowedMimes = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/quicktime', 'video/webm',
      'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
      'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'application/zip',
    ]);
    if (!allowedMimes.has(file.type)) {
      toast({ title: 'Unsupported file type', description: 'Choose an image, video, audio file, PDF, Office document, text file, or ZIP archive.', variant: 'destructive' });
      return;
    }

    const type: PendingAttachment['type'] = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
      : file.type.startsWith('audio/') ? 'audio'
      : 'document';
    const maxSize = type === 'document' ? 20 * 1024 * 1024 : 16 * 1024 * 1024;
    if (file.size > maxSize) {
      toast({ title: 'File is too large', description: `${type === 'document' ? 'Documents' : 'Media'} must be ${maxSize / (1024 * 1024)} MB or smaller.`, variant: 'destructive' });
      return;
    }

    setPendingAttachment({ file, objectUrl: URL.createObjectURL(file), type });
    setAttachmentCaption('');
    setAttachmentError(null);
    setAttachmentTempMessageId(null);
    setShowAttachMenu(false);
  };

  const handleAttachmentSend = async () => {
    if (readOnly || !pendingAttachment || !selectedConversation || !selectedProfile || attachmentSending) return;

    const { file, type, objectUrl } = pendingAttachment;
    const tempId = attachmentTempMessageId || `temp-attachment-${Date.now()}`;
    const caption = attachmentCaption.trim();
    const optimisticContent = { url: objectUrl, caption: caption || undefined, filename: file.name, mimetype: file.type };
    if (!attachmentTempMessageId) {
      setAttachmentTempMessageId(tempId);
      setMessages(current => [...current, {
        id: tempId,
        conversationId: selectedConversation.id,
        content: optimisticContent,
        type,
        direction: 'outgoing',
        status: 'pending',
        timestamp: new Date().toISOString(),
      }]);
    } else {
      setMessages(current => current.map(message => message.id === tempId ? { ...message, status: 'pending', content: optimisticContent } : message));
    }
    setAttachmentSending(true);
    setAttachmentError(null);
    requestAnimationFrame(() => scrollToBottom());

    try {
      const uploadRes = await api.uploadMedia(file);
      const mediaUrl = uploadRes.data?.url;
      if (!mediaUrl) throw new Error(uploadRes.error || 'Upload failed');

      const common = { profileId: selectedProfile, to: selectedConversation.jid, url: mediaUrl, mimetype: file.type };
      const res = type === 'image'
        ? await api.sendImageMessage({ ...common, caption: caption || undefined })
        : type === 'video'
          ? await api.sendVideoMessage({ ...common, caption: caption || undefined })
          : type === 'audio'
            ? await api.sendAudioMessage(common)
            : await api.sendDocumentMessage({ ...common, filename: file.name, caption: caption || undefined });
      if (!res.data) throw new Error(res.error || 'Send failed');

      setMessages(current => current.map(message => message.id === tempId ? {
        ...message,
        id: res.data.id || res.data.messageId || tempId,
        messageId: res.data.waMessageId || res.data.messageId,
        status: 'sent',
        content: { ...optimisticContent, url: mediaUrl },
      } : message));
      toast({ title: `${type.charAt(0).toUpperCase() + type.slice(1)} sent` });
      clearAttachmentPreview();
    } catch (error) {
      const description = error instanceof Error ? error.message : 'Upload failed';
      setMessages(current => current.map(message => message.id === tempId ? { ...message, status: 'failed' } : message));
      setAttachmentError(description);
      toast({ title: `Failed to send ${file.name}`, description, variant: 'destructive' });
    } finally {
      setAttachmentSending(false);
    }
  };

  // Clear chat messages (persistent — calls backend API)
  const handleClearChat = async () => {
    if (readOnly || !selectedConversation) return;
    if (!window.confirm('Are you sure you want to clear this chat? This action cannot be undone.')) return;
    try {
      await api.clearConversationMessages(selectedConversation.id);
      setMessages([]);
      toast({ title: 'Chat cleared' });
    } catch (error) {
      toast({ title: 'Failed to clear chat', variant: 'destructive' });
    }
  };

  // Toggle mute (persistent)
  const handleToggleMute = async () => {
    if (readOnly || !selectedConversation) return;
    try {
      const res = await api.muteConversation(selectedConversation.id);
      if (res.data) {
        const meta = (selectedConversation as any).metadata || {};
        const updated = { ...selectedConversation, metadata: { ...meta, isMuted: res.data.isMuted } };
        setSelectedConversation(updated as any);
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? updated as any : c));
        toast({ title: res.data.isMuted ? 'Notifications muted' : 'Notifications unmuted' });
      }
    } catch (error) {
      toast({ title: 'Failed to toggle mute', variant: 'destructive' });
    }
  };

  // Toggle pin (persistent)
  const handleTogglePin = async () => {
    if (readOnly || !selectedConversation) return;
    try {
      const res = await api.pinConversation(selectedConversation.id);
      if (res.data) {
        const meta = (selectedConversation as any).metadata || {};
        const updated = { ...selectedConversation, metadata: { ...meta, isPinned: res.data.isPinned } };
        setSelectedConversation(updated as any);
        setConversations(prev => prev.map(c => c.id === selectedConversation.id ? updated as any : c));
        toast({ title: res.data.isPinned ? 'Chat pinned' : 'Chat unpinned' });
      }
    } catch (error) {
      toast({ title: 'Failed to toggle pin', variant: 'destructive' });
    }
  };
  const insertEmoji = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
    inputRef.current?.focus();
  };

  const handleReaction = async (message: Message, emoji: string) => {
    if (readOnly) return;
    const previousReactions = message.reactions || [];
    setReactionPickerMessage(null);
    setActiveMessageMenu(null);
    setMessages(prev => prev.map(item =>
      item.id === message.id ? { ...item, reactions: [...previousReactions, emoji] } : item
    ));

    try {
      const res = await api.sendReaction({ profileId: selectedProfile, messageId: message.id, emoji });
      if (!res.data) throw new Error(res.error || 'Reaction failed');
    } catch {
      setMessages(prev => prev.map(item =>
        item.id === message.id ? { ...item, reactions: previousReactions } : item
      ));
      toast({ title: 'Failed to send reaction', variant: 'destructive' });
    }
  };

  const handleCopyMessage = async (message: Message) => {
    const text = message.content?.text || message.content?.caption;
    setActiveMessageMenu(null);
    if (!text) {
      toast({ title: 'This message has no text to copy', variant: 'destructive' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Message copied' });
    } catch {
      toast({ title: 'Could not copy message', variant: 'destructive' });
    }
  };

  const goToNextSearchResult = async () => {
    if (currentSearchIndex < messageSearchMatches.length - 1) {
      setCurrentSearchIndex(index => index + 1);
      return;
    }
    if (!messageSearchHasMore || !messageSearchNextCursor || !selectedConversation || !selectedProfile || messageSearchLoading) return;

    const requestId = ++messageSearchRequestRef.current;
    const conversationId = selectedConversation.id;
    const nextIndex = messageSearchMatches.length;
    setMessageSearchLoading(true);
    setMessageSearchError(null);
    try {
      const response = await api.searchConversationMessages(conversationId, selectedProfile, messageSearchQuery.trim(), { limit: 30, cursor: messageSearchNextCursor });
      if (requestId !== messageSearchRequestRef.current || selectedConversationRef.current?.id !== conversationId) return;
      if (!response.data) throw new Error(response.error || 'Could not load more search results');
      setRemoteMessageSearchMatches(current => [...current, ...(response.data?.messages || [])]);
      setMessageSearchHasMore(response.data.hasMore);
      setMessageSearchNextCursor(response.data.nextCursor);
      if (response.data.messages.length > 0) setCurrentSearchIndex(nextIndex);
    } catch (error) {
      if (requestId === messageSearchRequestRef.current) setMessageSearchError(error instanceof Error ? error.message : 'Could not load more search results');
    } finally {
      if (requestId === messageSearchRequestRef.current) setMessageSearchLoading(false);
    }
  };

  const closeMessageSearch = () => {
    messageSearchRequestRef.current += 1;
    messageContextRequestRef.current += 1;
    if (preSearchMessagesRef.current) {
      setMessages(preSearchMessagesRef.current);
      preSearchMessagesRef.current = null;
    }
    setShowMessageSearch(false);
    setMessageSearchQuery('');
    setRemoteMessageSearchMatches([]);
    setMessageSearchHasMore(false);
    setMessageSearchNextCursor(null);
    setMessageSearchError(null);
    setMessageSearchLoading(false);
    setCurrentSearchIndex(0);
  };

  const focusMessageAt = (index: number) => {
    const message = messages[index];
    if (!message) return;
    setFocusedMessageId(message.id);
    requestAnimationFrame(() => messageElementRefs.current.get(message.id)?.focus());
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const focusedMessage = messages.find(message => message.id === focusedMessageId);
      const action = resolveChatShortcut(event, Boolean(focusedMessage), inputRef.current);
      if (!action) return;
      if (readOnly && ['send-message', 'reply-focused', 'delete-focused'].includes(action)) return;
      event.preventDefault();

      if (action === 'open-message-search') {
        if (!selectedConversation || pendingAttachment) return;
        setShowMessageSearch(true);
        setTimeout(() => messageSearchInputRef.current?.focus(), 0);
      } else if (action === 'focus-conversation-search') {
        conversationSearchRef.current?.focus();
      } else if (action === 'send-message') {
        handleSend();
      } else if (action === 'previous-search-result' && showMessageSearch) {
        setCurrentSearchIndex(index => Math.max(0, index - 1));
      } else if (action === 'next-search-result' && showMessageSearch) {
        goToNextSearchResult();
      } else if (action === 'reply-focused' && focusedMessage) {
        setReplyTo(focusedMessage);
        inputRef.current?.focus();
      } else if (action === 'copy-focused' && focusedMessage) {
        handleCopyMessage(focusedMessage);
      } else if (action === 'delete-focused' && focusedMessage?.direction === 'outgoing') {
        setShowDeleteConfirm(focusedMessage.messageId || focusedMessage.id);
      } else if (action === 'escape') {
        if (actionSheetMessage) setActionSheetMessage(null);
        else if (pendingAttachment && !attachmentSending) clearAttachmentPreview();
        else if (reactionPickerMessage) setReactionPickerMessage(null);
        else if (activeMessageMenu) setActiveMessageMenu(null);
        else if (showDeleteConfirm) setShowDeleteConfirm(null);
        else if (showMessageSearch) closeMessageSearch();
        else if (showEmojiPicker) setShowEmojiPicker(false);
        else if (showAttachMenu) setShowAttachMenu(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeMessageMenu, actionSheetMessage, attachmentSending, currentSearchIndex, focusedMessageId, messageSearchHasMore, messageSearchLoading, messageSearchMatches.length, messageSearchNextCursor, messageSearchQuery, messages, pendingAttachment, reactionPickerMessage, readOnly, selectedConversation, selectedProfile, showAttachMenu, showDeleteConfirm, showEmojiPicker, showMessageSearch]);

  const openNewChatPanel = async () => {
    if (readOnly || !selectedProfile || newChatLoading) return;
    setShowNewChat(true);
    setNewChatQuery('');
    setNewChatError(null);
    setNewChatLoading(true);
    try {
      const res = await api.getContacts(selectedProfile);
      if (!res.data) throw new Error(res.error || 'Could not load contacts');
      setNewChatContacts(res.data);
    } catch (error) {
      setNewChatError(error instanceof Error ? error.message : 'Could not load contacts');
    } finally {
      setNewChatLoading(false);
    }
  };

  const startChatWithPhone = async (phoneInput: string, name?: string, contactId?: string) => {
    if (readOnly || !selectedProfile || startingNewChatRef.current) return;
    const phone = normalizeNewChatPhone(phoneInput);
    if (!isValidInternationalPhone(phone)) {
      setNewChatError('Enter a valid international phone number');
      return;
    }

    const existing = conversations.find(conversation =>
      conversation.profileId === selectedProfile && canonicalConversationPhone(conversation.jid) === phone
    );
    if (existing) {
      messageRequestRef.current += 1;
      setSelectedConversation(existing);
      setShowNewChat(false);
      return;
    }

    const activeProfile = profiles.find(profile => profile.id === selectedProfile);
    if (activeProfile?.status !== 'connected') {
      setNewChatError('Connect this WhatsApp profile before starting a new chat');
      return;
    }

    startingNewChatRef.current = true;
    setStartingNewChat(true);
    setNewChatError(null);
    try {
      const validation = await api.validateContactPhone(selectedProfile, phone);
      if (!validation.data?.validFormat) throw new Error(validation.error || 'Enter a valid international phone number');
      if (validation.data.onWhatsApp === false) throw new Error('This number is not available on WhatsApp');

      const jid = `${validation.data.phone || phone}@s.whatsapp.net`;
      const draft: Conversation = {
        id: `draft:${selectedProfile}:${phone}`,
        profileId: selectedProfile,
        jid,
        contactId: contactId || `phone:${phone}`,
        contactName: name || `+${phone}`,
        name: name || `+${phone}`,
        type: 'user',
        unreadCount: 0,
        lastMessageAt: '',
      };
      messageRequestRef.current += 1;
      setSelectedConversation(draft);
      setShowNewChat(false);
      setNewChatQuery('');
    } catch (error) {
      setNewChatError(error instanceof Error ? error.message : 'Could not start chat');
    } finally {
      startingNewChatRef.current = false;
      setStartingNewChat(false);
    }
  };

  const normalizedDirectPhone = normalizeNewChatPhone(newChatQuery);
  const queryLooksLikePhone = newChatQuery.trim().length > 0 && /^[+()\d\s-]+$/.test(newChatQuery.trim());
  const directPhoneIsValid = queryLooksLikePhone && isValidInternationalPhone(normalizedDirectPhone);
  const filteredNewChatContacts = newChatContacts.filter(contact => {
    const query = newChatQuery.trim().toLowerCase();
    if (!query) return true;
    const normalizedQuery = normalizeNewChatPhone(query);
    const email = String(contact.metadata?.email || '').toLowerCase();
    return contact.name?.toLowerCase().includes(query)
      || (normalizedQuery.length > 0 && contact.phone.includes(normalizedQuery))
      || email.includes(query);
  });

  // Filter and sort conversations (pinned first)
  const filteredConversations = conversations
    .filter(conv => {
      if (!searchQuery.trim()) return true;
      const query = searchQuery.toLowerCase();
      return (
        conv.name?.toLowerCase().includes(query) ||
        conv.contactName?.toLowerCase().includes(query) ||
        conv.jid?.toLowerCase().includes(query) ||
        conv.contactId?.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aPinned = (a as any).metadata?.isPinned ? 1 : 0;
      const bPinned = (b as any).metadata?.isPinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return 0; // keep original order for un-pinned
    });
  const { items: visibleConversations, hiddenCount: hiddenConversationCount } = getVisibleWindow(filteredConversations, 80);

  // Get initials for avatar
  const getInitials = (name: string) => {
    return name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?';
  };

  // Handle delete message
  const handleDeleteMessage = async (messageId: string) => {
    if (readOnly || !selectedProfile || !selectedConversation) return;
    setDeletingMessageId(messageId);
    try {
      const res = await api.deleteForEveryone(selectedProfile, selectedConversation.jid, messageId);
      if (res.data?.success) {
        setMessages(prev => prev.filter(m => (m.messageId || m.id) !== messageId));
        toast({ title: 'Message Deleted', description: 'Message has been deleted' });
      } else {
        toast({ title: 'Error', description: res.error || 'Failed to delete message', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to delete message', variant: 'destructive' });
    }
    setDeletingMessageId(null);
    setShowDeleteConfirm(null);
  };

  // Handle schedule message
  const handleScheduleMessage = async () => {
    if (readOnly || !messageInput.trim() || !scheduleDateTime || !selectedProfile || !selectedConversation) return;
    setScheduling(true);
    try {
      const scheduledAt = new Date(scheduleDateTime).toISOString();
      const res = await api.scheduleMessage(selectedProfile, selectedConversation.jid, 'text', messageInput.trim(), scheduledAt);
      if (res.data) {
        // Add scheduled message to chat display immediately
        const scheduledMsg: Message = {
          id: res.data.id || `scheduled-${Date.now()}`,
          conversationId: selectedConversation.id,
          content: messageInput.trim(),
          type: 'text',
          direction: 'outgoing',
          status: 'pending',
          timestamp: scheduledAt,
          senderName: 'You (Scheduled)',
        };
        setMessages(prev => [...prev, scheduledMsg]);
        
        toast({ title: '⏰ Message Scheduled', description: `Will be sent on ${new Date(scheduleDateTime).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}` });
        setMessageInput('');
        setScheduleDateTime('');
        setShowSchedulePicker(false);
      } else {
        toast({ title: 'Error', description: res.error || 'Failed to schedule message', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to schedule message', variant: 'destructive' });
    }
    setScheduling(false);
  };

  // Render loading skeleton
  if (loading) {
    return (
      <div className="h-[calc(100dvh-112px)] min-h-0 flex">
        <div className="w-full md:w-[360px] border-r border-border p-4 space-y-4">
          <Skeleton className="h-10 w-full" />
          {[1, 2, 3, 4, 5].map(i => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100dvh-112px)] min-h-0 flex bg-[#f7f8fa] dark:bg-[#111b21] border border-border overflow-hidden shadow-sm">
      {/* Conversation Sidebar */}
      <div className={`${selectedConversation ? 'hidden md:flex' : 'flex'} w-full md:w-[360px] lg:w-[400px] shrink-0 border-r border-[#e9edef] dark:border-[#2a3942] flex-col bg-white dark:bg-[#111b21]`}>
        {/* Sidebar Header */}
        <div className="px-3 py-2.5 border-b border-[#e9edef] dark:border-[#2a3942] bg-[#f0f2f5] dark:bg-[#202c33]">
          <Select
            value={selectedProfile}
            onValueChange={(profileId) => {
              conversationRequestRef.current += 1;
              messageRequestRef.current += 1;
              setConversationsLoading(true);
              setSelectedProfile(profileId);
            }}
          >
            <SelectTrigger className="w-full h-9 mb-2 border-0 bg-white/90 dark:bg-[#2a3942] shadow-none">
              <SelectValue placeholder="Select profile" />
            </SelectTrigger>
            <SelectContent>
              {profiles.map(profile => (
                <SelectItem key={profile.id} value={profile.id}>
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${profile.status === 'connected' ? 'bg-green-500' : 'bg-gray-400'}`} />
                    {profile.displayName || profile.name || 'Unnamed'}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Input
                ref={conversationSearchRef}
                placeholder="Search conversations"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-9 pl-10 border-0 rounded-lg bg-white dark:bg-[#202c33] shadow-none focus-visible:ring-1"
              />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={openNewChatPanel} disabled={readOnly} className="h-9 w-9 shrink-0 rounded-full bg-white p-0 text-[#008069] dark:bg-[#202c33] dark:text-[#00a884]" aria-label={readOnly ? 'New chat disabled in read-only mode' : 'New chat'}>
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h8m-4-4v8m8-2a8 8 0 11-3.5-6.6L20 4v5h-5l1.8-1.8" /></svg>
            </Button>
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {!readOnly && showNewChat ? (
            <div className="min-h-full bg-white dark:bg-[#111b21]">
              <div className="flex h-14 items-center gap-3 border-b border-[#e9edef] px-3 dark:border-[#202c33]">
                <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={() => { setShowNewChat(false); setNewChatError(null); }} aria-label="Back to conversations">
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </Button>
                <h2 className="text-base font-semibold">New chat</h2>
              </div>
              <div className="p-3">
                <div className="relative">
                  <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <Input autoFocus placeholder="Search contacts or enter phone number" value={newChatQuery} onChange={event => { setNewChatQuery(event.target.value); setNewChatError(null); }} onKeyDown={event => { if (event.key === 'Enter' && directPhoneIsValid) { event.preventDefault(); startChatWithPhone(normalizedDirectPhone); } }} className="h-10 rounded-lg border-0 bg-[#f0f2f5] pl-9 shadow-none focus-visible:ring-1 dark:bg-[#202c33]" />
                </div>
                {queryLooksLikePhone && !directPhoneIsValid && (
                  <p className="mt-2 text-xs text-red-500">Enter a valid international phone number</p>
                )}
                {newChatError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/30 dark:text-red-300" role="alert">{newChatError}</p>}
              </div>

              {directPhoneIsValid && (
                <button type="button" onClick={() => startChatWithPhone(normalizedDirectPhone)} disabled={startingNewChat} aria-label={`Start chat with +${normalizedDirectPhone}`} className="flex w-full items-center gap-3 border-y border-[#e9edef] px-4 py-3 text-left hover:bg-[#f5f6f6] disabled:opacity-60 dark:border-[#202c33] dark:hover:bg-[#202c33]">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#00a884] text-xl text-white">+</span>
                  <span><span className="block text-sm font-medium">Chat with +{normalizedDirectPhone}</span><span className="block text-xs text-muted-foreground">New WhatsApp number</span></span>
                </button>
              )}

              <p className="px-4 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-[#008069] dark:text-[#00a884]">Contacts</p>
              {newChatLoading ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground" role="status"><span className="h-4 w-4 animate-spin rounded-full border-2 border-[#00a884] border-t-transparent" />Loading contacts…</div>
              ) : filteredNewChatContacts.length === 0 ? (
                <p className="p-8 text-center text-sm text-muted-foreground">No matching contacts</p>
              ) : filteredNewChatContacts.map(contact => (
                <button key={contact.id} type="button" onClick={() => startChatWithPhone(contact.phone, contact.name, contact.id)} disabled={startingNewChat} className="flex w-full items-center gap-3 border-b border-[#f0f2f5] px-4 py-3 text-left hover:bg-[#f5f6f6] disabled:opacity-60 dark:border-[#202c33] dark:hover:bg-[#202c33]">
                  <Avatar className="h-11 w-11"><AvatarFallback className="bg-[#25D366] text-white">{getInitials(contact.name || contact.phone)}</AvatarFallback></Avatar>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{contact.name || `+${contact.phone}`}</span><span className="block truncate text-xs text-muted-foreground">+{contact.phone}</span></span>
                </button>
              ))}
            </div>
          ) : conversationsLoading ? (
            <div className="p-4 space-y-3" role="status" aria-live="polite">
              <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                <span className="h-4 w-4 rounded-full border-2 border-[#25D366] border-t-transparent animate-spin" />
                <span>Loading conversations…</span>
              </div>
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : conversationsError ? (
            <div className="p-8 text-center" role="alert">
              <div className="text-3xl mb-3">⚠️</div>
              <p className="text-sm text-muted-foreground mb-3">{conversationsError}</p>
              <Button variant="outline" size="sm" onClick={() => loadConversations(true)}>
                Try again
              </Button>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-8 text-center">
              <div className="text-4xl mb-3">💬</div>
              <p className="text-sm text-muted-foreground">No conversations yet</p>
            </div>
          ) : (
            <>
            {visibleConversations.map(conv => (
              <div
                key={conv.id}
                onClick={() => {
                  if (conv.id !== selectedConversation?.id) {
                    messageRequestRef.current += 1;
                    setSelectedConversation(conv);
                  }
                }}
                className={`flex items-center gap-3 px-3 py-3 cursor-pointer hover:bg-[#f5f6f6] dark:hover:bg-[#202c33] transition-colors border-b border-[#f0f2f5] dark:border-[#202c33] ${
                  selectedConversation?.id === conv.id ? 'bg-[#f0f2f5] dark:bg-[#2a3942]' : ''
                }`}
              >
                <Avatar className="w-12 h-12">
                  <AvatarImage src={conv.avatar} />
                  <AvatarFallback className="bg-[#25D366] text-white">
                    {getInitials(getDisplayName(conv))}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <h4 className="min-w-0 flex-1 truncate font-medium text-foreground flex items-center gap-1">
                      {(conv as any).metadata?.isPinned && <span className="text-xs">📌</span>}
                      {getDisplayName(conv)}
                      {(conv as any).metadata?.isMuted && <span className="text-xs opacity-60">🔇</span>}
                    </h4>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {conv.lastMessageAt ? formatTime(conv.lastMessageAt) : ''}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-sm text-muted-foreground truncate flex-1">
                      {getLastMessagePreview(conv.lastMessage)}
                    </p>
                    {conv.unreadCount > 0 && (
                      <Badge className="min-w-5 h-5 justify-center rounded-full bg-[#25D366] text-white text-[11px] px-1.5 ml-2">
                        {conv.unreadCount}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {hiddenConversationCount > 0 && (
              <div className="border-t border-[#e9edef] px-4 py-3 text-center text-xs text-muted-foreground dark:border-[#202c33]">
                {hiddenConversationCount.toLocaleString()} older conversations hidden. Search above to find them.
              </div>
            )}
            </>
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className={`${selectedConversation ? 'flex' : 'hidden md:flex'} relative min-w-0 flex-1 flex-col bg-[#efeae2] dark:bg-[#0b141a]`}>
        {selectedConversation ? (
          <>
            {/* Chat Header */}
            <div className="h-[60px] px-3 md:px-4 border-b border-[#d8dcdf] dark:border-[#2a3942] bg-[#f0f2f5] dark:bg-[#202c33] flex items-center gap-3">
              <Button variant="ghost" size="sm" className="md:hidden h-9 w-9 p-0 text-muted-foreground" onClick={() => { setSelectedConversation(null); setMessages([]); }} aria-label="Back to conversations">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </Button>
              <Avatar className="w-10 h-10">
                <AvatarImage src={selectedConversation.avatar} />
                <AvatarFallback className="bg-[#25D366] text-white">
                  {getInitials(getDisplayName(selectedConversation))}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h3 className="truncate font-semibold text-foreground">
                  {getDisplayName(selectedConversation)}
                </h3>
                {conversationSubtitle && (
                  <p className={`truncate text-xs ${presenceLabel ? 'text-[#008069] dark:text-[#06cf9c]' : 'text-muted-foreground'}`} aria-live="polite" data-presence-state={presenceLabel || undefined}>
                    {conversationSubtitle}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowMessageSearch(true)}
                aria-label="Search messages"
                className="h-9 w-9 p-0 text-muted-foreground"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              </Button>
              {!readOnly && (
                <div className="relative">
                  <Button variant="ghost" size="sm" onClick={() => setShowThreeDotMenu(!showThreeDotMenu)} aria-label="Conversation actions">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </Button>
                  {showThreeDotMenu && (
                    <div className="absolute right-0 top-10 bg-card border border-border rounded-xl shadow-lg py-1 z-20 w-48">
                      <button onClick={() => { setShowThreeDotMenu(false); setShowContactInfo(!showContactInfo); }} className="w-full px-4 py-2.5 text-sm text-left hover:bg-secondary flex items-center gap-3">
                        <span>👤</span> Contact Info
                      </button>
                      <button onClick={() => { setShowThreeDotMenu(false); handleToggleMute(); }} className="w-full px-4 py-2.5 text-sm text-left hover:bg-secondary flex items-center gap-3">
                        <span>{(selectedConversation as any)?.metadata?.isMuted ? '🔔' : '🔇'}</span>
                        {(selectedConversation as any)?.metadata?.isMuted ? 'Unmute Notifications' : 'Mute Notifications'}
                      </button>
                      <button onClick={() => { setShowThreeDotMenu(false); handleTogglePin(); }} className="w-full px-4 py-2.5 text-sm text-left hover:bg-secondary flex items-center gap-3">
                        <span>📌</span>
                        {(selectedConversation as any)?.metadata?.isPinned ? 'Unpin Chat' : 'Pin Chat'}
                      </button>
                      <hr className="my-1 border-border" />
                      <button onClick={() => { setShowThreeDotMenu(false); handleClearChat(); }} className="w-full px-4 py-2.5 text-sm text-left hover:bg-secondary text-red-500 flex items-center gap-3">
                        <span>🗑️</span> Clear Chat
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {readOnly && (
              <div className="flex items-center justify-center gap-2 border-b border-[#b7e4d8] bg-[#e7f8f3] px-3 py-1.5 text-xs font-medium text-[#047857] dark:border-[#245c50] dark:bg-[#12372f] dark:text-[#6ee7b7]" role="status" aria-live="polite">
                <span aria-hidden="true">🔒</span>
                Read-only mode — navigation and search are available; all mutations are disabled
              </div>
            )}

            {showMessageSearch && (
              <div className="flex h-12 items-center gap-2 border-b border-[#d8dcdf] bg-white px-3 dark:border-[#2a3942] dark:bg-[#202c33]">
                <div className="relative min-w-0 flex-1">
                  <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m1.35-5.65a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  <Input ref={messageSearchInputRef} autoFocus placeholder="Search messages" value={messageSearchQuery} onChange={event => setMessageSearchQuery(event.target.value)} className="h-9 border-0 bg-[#f0f2f5] pl-9 shadow-none focus-visible:ring-1 dark:bg-[#2a3942]" />
                </div>
                <span className="min-w-[52px] text-center text-xs text-muted-foreground">
                  {messageSearchLoading ? 'Searching…' : messageSearchError ? (
                    <button type="button" className="text-red-600 underline" title={messageSearchError} onClick={() => setMessageSearchRetryNonce(value => value + 1)}>Retry</button>
                  ) : messageSearchMatches.length > 0 ? `${currentSearchIndex + 1} of ${messageSearchMatches.length}` : '0 of 0'}
                </span>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={currentSearchIndex <= 0 || messageSearchMatches.length === 0} onClick={() => setCurrentSearchIndex(index => Math.max(0, index - 1))} aria-label="Previous search result">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={messageSearchMatches.length === 0 || (currentSearchIndex >= messageSearchMatches.length - 1 && !messageSearchHasMore) || messageSearchLoading} onClick={goToNextSearchResult} aria-label="Next search result">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={closeMessageSearch} aria-label="Close message search">
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </Button>
              </div>
            )}

            {connectionState !== 'connected' && (
              <div className={`flex items-center justify-center gap-2 px-3 py-1.5 text-xs ${connectionState === 'disconnected' ? 'bg-[#fff4e5] text-[#8a4b08] dark:bg-[#3b2a1d] dark:text-[#f0b56b]' : 'bg-[#e7f8f3] text-[#047857] dark:bg-[#12372f] dark:text-[#6ee7b7]'}`} role="status" aria-live="polite">
                <span className={`h-2 w-2 rounded-full ${connectionState === 'disconnected' ? 'bg-[#d97706]' : 'animate-pulse bg-[#00a884]'}`} />
                {connectionState === 'disconnected' ? 'Disconnected — messages can be retried when service returns' : connectionState === 'connecting' ? 'Connecting to realtime updates…' : 'Reconnecting to realtime updates…'}
              </div>
            )}

            {/* Messages Area */}
            <div
              ref={messagesContainerRef}
              className="flex-1 overflow-y-auto px-[5%] md:px-[7%] py-3 scrollbar-thin"
              onScroll={event => {
                longPressControllerRef.current?.cancel();
                const distanceFromBottom = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight;
                const atBottom = distanceFromBottom < 100;
                setIsAtBottom(atBottom);
                if (atBottom) setNewMessagesBelow(0);
                if (shouldLoadOlderMessages({
                  scrollTop: event.currentTarget.scrollTop,
                  initialScrollSettled: initialScrollSettledRef.current,
                  messagesLoading,
                  olderMessagesLoading,
                })) loadOlderMessages();
              }}
              style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%239C92AC\' fill-opacity=\'0.03\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")' }}
            >
              {olderMessagesLoading && (
                <div className="flex items-center justify-center gap-2 py-2 text-xs text-[#667781] dark:text-[#8696a0]" role="status">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#00a884] border-t-transparent" />
                  Loading older messages…
                </div>
              )}
              {messagesLoading ? (
                <div className="flex items-center justify-center h-full" role="status" aria-live="polite">
                  <div className="text-center space-y-4">
                    <span className="inline-block h-8 w-8 rounded-full border-2 border-[#25D366] border-t-transparent animate-spin" />
                    <p className="text-sm text-muted-foreground">Loading messages…</p>
                  </div>
                </div>
              ) : messagesError ? (
                <div className="flex items-center justify-center h-full" role="alert">
                  <div className="text-center">
                    <div className="text-4xl mb-3">⚠️</div>
                    <p className="text-sm text-muted-foreground mb-3">{messagesError}</p>
                    <Button variant="outline" size="sm" onClick={() => loadMessages(selectedConversation.id)}>
                      Try again
                    </Button>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="text-6xl mb-4">🔐</div>
                    <p className="text-muted-foreground">Messages are end-to-end encrypted</p>
                  </div>
                </div>
              ) : (
                groupedMessages.map(({ message: msg, position, showTail, showSenderName }, idx) => (
                  <div
                    key={`${msg.id}-${idx}`}
                    className={`${startsNewDay(messages, idx) || position === 'single' || position === 'first' ? 'mt-1.5' : 'mt-[2px]'} rounded-lg focus:outline-none`}
                    data-group-position={position}
                    data-message-id={msg.id}
                    tabIndex={readOnly ? -1 : 0}
                    aria-label={getAccessibleMessageLabel(
                      msg.direction === 'outgoing' ? 'You' : getMessageSenderLabel(msg),
                      getMessagePreview(msg),
                      formatTime(msg.timestamp),
                    )}
                    onFocus={() => setFocusedMessageId(msg.id)}
                    onKeyDown={event => {
                      if (readOnly) return;
                      if (event.key === 'ArrowUp') { event.preventDefault(); focusMessageAt(Math.max(0, idx - 1)); }
                      else if (event.key === 'ArrowDown') { event.preventDefault(); focusMessageAt(Math.min(messages.length - 1, idx + 1)); }
                      else if (event.key === 'Home') { event.preventDefault(); focusMessageAt(0); }
                      else if (event.key === 'End') { event.preventDefault(); focusMessageAt(messages.length - 1); }
                      else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); setActiveMessageMenu(msg.id); }
                    }}
                    onPointerDown={event => {
                      if (readOnly) return;
                      if (event.pointerType !== 'touch' || (event.target as HTMLElement).closest('a,button,input,textarea,audio,video')) return;
                      longPressControllerRef.current?.start(event.clientX, event.clientY, msg);
                    }}
                    onPointerMove={event => longPressControllerRef.current?.move(event.clientX, event.clientY)}
                    onPointerUp={() => longPressControllerRef.current?.end()}
                    onPointerCancel={() => longPressControllerRef.current?.cancel()}
                    onContextMenu={event => {
                      if (readOnly) return;
                      if ((event.target as HTMLElement).closest('a,button,input,textarea,audio,video')) return;
                      event.preventDefault();
                      if (window.matchMedia('(pointer: coarse)').matches) setActionSheetMessage(msg);
                      else setActiveMessageMenu(msg.id);
                    }}
                    ref={element => {
                      if (element) messageElementRefs.current.set(msg.id, element);
                      else messageElementRefs.current.delete(msg.id);
                    }}
                  >
                    {startsNewDay(messages, idx) && (
                      <div className="sticky top-1 z-10 flex justify-center py-1.5">
                        <span className="rounded-lg bg-white/95 dark:bg-[#182229] px-3 py-1.5 text-[11px] font-medium text-[#54656f] dark:text-[#8696a0] shadow-sm">{formatDateLabel(msg.timestamp)}</span>
                      </div>
                    )}
                    <div className={`flex group ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
                    <div className="relative self-center mx-1">
                      <button
                        type="button"
                        disabled={readOnly}
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={() => setActiveMessageMenu(activeMessageMenu === msg.id ? null : msg.id)}
                        className={`${readOnly ? 'hidden' : ''} rounded-full p-1.5 opacity-100 text-muted-foreground transition-opacity hover:bg-black/5 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-white/10`}
                        aria-expanded={readOnly ? undefined : activeMessageMenu === msg.id}
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                      {!readOnly && activeMessageMenu === msg.id && (
                        <div role="menu" className="absolute left-0 top-8 z-30 w-44 overflow-hidden rounded-lg border border-border bg-white py-1 shadow-xl dark:bg-[#233138]">
                          <button role="menuitem" onClick={() => { setReplyTo(msg); setActiveMessageMenu(null); inputRef.current?.focus(); }} className="w-full px-4 py-2 text-left text-sm hover:bg-secondary">Reply</button>
                          <button role="menuitem" onClick={() => { setReactionPickerMessage(msg); setActiveMessageMenu(null); }} className="w-full px-4 py-2 text-left text-sm hover:bg-secondary">React</button>
                          <button role="menuitem" onClick={() => handleCopyMessage(msg)} className="w-full px-4 py-2 text-left text-sm hover:bg-secondary">Copy</button>
                          {msg.direction === 'outgoing' && (
                            <button role="menuitem" onClick={() => { setShowDeleteConfirm(msg.messageId || msg.id); setActiveMessageMenu(null); }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">Delete for everyone</button>
                          )}
                        </div>
                      )}
                      {!readOnly && reactionPickerMessage?.id === msg.id && (
                        <div className="absolute left-0 top-8 z-30 flex gap-1 rounded-full border border-border bg-white p-1.5 shadow-xl dark:bg-[#233138]">
                          {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                            <button key={emoji} onClick={() => handleReaction(msg, emoji)} className="flex h-8 w-8 items-center justify-center rounded-full text-lg hover:bg-secondary" aria-label={`React with ${emoji}`}>{emoji}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    {!readOnly && showDeleteConfirm === (msg.messageId || msg.id) && (
                      <div className="self-center flex items-center gap-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-border p-1">
                        <button onClick={() => handleDeleteMessage(msg.messageId || msg.id)} disabled={deletingMessageId === (msg.messageId || msg.id)} className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors">{deletingMessageId === (msg.messageId || msg.id) ? '...' : 'Delete'}</button>
                        <button onClick={() => setShowDeleteConfirm(null)} className="text-xs px-2 py-1 text-muted-foreground hover:bg-secondary rounded transition-colors">Cancel</button>
                      </div>
                    )}
                    <div
                      data-message-bubble="true"
                      data-search-active={activeSearchMessageId === msg.id ? 'true' : undefined}
                      data-message-tail={showTail ? 'true' : undefined}
                      className={`relative max-w-[86%] md:max-w-[70%] rounded-lg px-2.5 pt-1.5 pb-1 overflow-visible text-[14.2px] leading-[19px] shadow-sm ${activeSearchMessageId === msg.id || focusedMessageId === msg.id ? 'ring-2 ring-[#00a884] ring-offset-2 ring-offset-transparent' : ''} ${
                        msg.direction === 'outgoing'
                          ? `bg-[#d9fdd3] dark:bg-[#005c4b] text-foreground ${position === 'middle' || position === 'last' ? 'rounded-tr-sm' : ''}`
                          : `bg-white dark:bg-[#202c33] text-foreground ${position === 'middle' || position === 'last' ? 'rounded-tl-sm' : ''}`
                      }`}
                    >
                      {showTail && (
                        <span aria-hidden="true" className={`absolute bottom-0 h-0 w-0 ${msg.direction === 'outgoing' ? '-right-[6px] border-b-0 border-l-[7px] border-t-[7px] border-b-transparent border-l-[#d9fdd3] border-t-transparent dark:border-l-[#005c4b]' : '-left-[6px] border-b-0 border-r-[7px] border-t-[7px] border-b-transparent border-r-white border-t-transparent dark:border-r-[#202c33]'}`} />
                      )}
                      {msg.quotedMessageId && (() => {
                        const quoted = messages.find(candidate => candidate.id === msg.quotedMessageId);
                        return (
                          <div className="mb-1.5 rounded-md border-l-[3px] border-[#06cf9c] bg-black/5 dark:bg-black/20 px-2.5 py-1.5 min-w-[160px]">
                            <p className="text-xs font-semibold text-[#008069] dark:text-[#06cf9c]">
                              {quoted ? getReplySenderLabel(quoted, selectedConversation) : 'Original message'}
                            </p>
                            <p className="text-xs text-[#667781] dark:text-[#aebac1] truncate max-w-[280px]">
                              {quoted ? getMessagePreview(quoted) : 'Message unavailable'}
                            </p>
                          </div>
                        );
                      })()}
                      {selectedConversation.type === 'group' && showSenderName && (
                        <p className="text-xs font-semibold text-[#128C7E] dark:text-[#25D366] mb-1">
                          {getMessageSenderLabel(msg)}
                        </p>
                      )}
                      {/* Message Content */}
                      {msg.type === 'text' && (
                        <p className="whitespace-pre-wrap break-words">{sanitizeChatText(msg.content?.text)}</p>
                      )}
                      {msg.type === 'image' && (
                        <div>
                          {msg.content?.url ? (
                            <>
                              <img 
                                src={fixMediaUrl(msg.content.url)} 
                                alt="Image" 
                                className="rounded-lg max-w-full max-h-64 object-cover cursor-pointer"
                                onClick={() => window.open(fixMediaUrl(msg.content?.url), '_blank')}
                              />
                              {msg.content?.caption && (
                                <p className="whitespace-pre-wrap break-words mt-2 text-sm">{sanitizeChatText(msg.content.caption)}</p>
                              )}
                            </>
                          ) : (
                            <div className="bg-secondary/30 rounded-lg p-4 flex items-center gap-3 min-w-[200px]">
                              <span className="text-3xl">📷</span>
                              <div>
                                <p className="text-sm font-medium">Photo</p>
                                <p className="text-xs text-muted-foreground">Image not available</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      {msg.type === 'video' && (
                        <div>
                          <video 
                            src={fixMediaUrl(msg.content?.url)} 
                            controls
                            className="rounded-lg max-w-full max-h-64"
                          />
                          {msg.content?.caption && (
                            <p className="whitespace-pre-wrap break-words mt-2 text-sm">{sanitizeChatText(msg.content.caption)}</p>
                          )}
                        </div>
                      )}
                      {msg.type === 'audio' && (
                        <div className="min-w-[200px]">
                          <audio src={fixMediaUrl(msg.content?.url)} controls className="w-full" />
                        </div>
                      )}
                      {msg.type === 'document' && (
                        <div>
                          <a 
                            href={fixMediaUrl(msg.content?.url)} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 bg-secondary/50 rounded-lg p-3 hover:bg-secondary/70 transition-colors cursor-pointer no-underline text-inherit max-w-[300px] overflow-hidden"
                          >
                            <div className="text-3xl">📄</div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{msg.content?.filename || 'Document'}</p>
                              <p className="text-xs text-muted-foreground">Document</p>
                            </div>
                            <div className="text-muted-foreground">⬇️</div>
                          </a>
                          {(msg.content?.caption || msg.content?.text) && (
                            <p className="whitespace-pre-wrap break-words mt-2 text-sm">{sanitizeChatText(msg.content.caption || msg.content.text)}</p>
                          )}
                        </div>
                      )}
                      {msg.type === 'location' && (
                        <a
                          href={`https://www.google.com/maps?q=${msg.content?.latitude || 0},${msg.content?.longitude || 0}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block"
                        >
                          <div className="bg-secondary/50 rounded-lg p-3 hover:bg-secondary/70 transition-colors">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-2xl">📍</span>
                              <span className="font-medium">{msg.content?.name || msg.content?.description || 'Location'}</span>
                            </div>
                            {msg.content?.address && (
                              <p className="text-xs text-muted-foreground ml-9">{msg.content.address}</p>
                            )}
                            {msg.content?.latitude && msg.content?.longitude && (
                              <p className="text-xs text-muted-foreground ml-9">{msg.content.latitude.toFixed(6)}, {msg.content.longitude.toFixed(6)}</p>
                            )}
                            <p className="text-xs text-blue-500 mt-1 ml-9">Open in Google Maps →</p>
                          </div>
                        </a>
                      )}
                      {(msg.type === 'vcard' || msg.type === 'contact' || msg.type === 'contacts') && (() => {
                        // Parse vCard for contact info (handles both pre-parsed and raw vCard)
                        let displayName = msg.content?.displayName || msg.content?.name || '';
                        let phone = msg.content?.phone || '';
                        const vcardStr = msg.content?.vcard || msg.content?.text || '';
                        if (!displayName && vcardStr) {
                          const fnMatch = vcardStr.match(/FN:(.*)/i);
                          if (fnMatch) displayName = fnMatch[1].trim();
                        }
                        if (!phone && vcardStr) {
                          const telMatch = vcardStr.match(/TEL[^:]*:([\d+\-\s]+)/i);
                          if (telMatch) phone = telMatch[1].trim();
                        }
                        return (
                          <div className="bg-secondary/50 rounded-lg p-3">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xl">👤</div>
                              <div>
                                <p className="font-medium">{displayName || 'Contact'}</p>
                                {phone && <p className="text-xs text-muted-foreground">{phone}</p>}
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                      {(msg.type === 'poll' || msg.type === 'poll_creation') && (
                        <div className="bg-secondary/50 rounded-lg p-3 min-w-[220px]">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-lg">📊</span>
                            <p className="font-medium">{msg.content?.pollName || msg.content?.question || msg.content?.text || 'Poll'}</p>
                          </div>
                          {msg.content?.allowMultipleAnswers === false && (
                            <p className="text-xs text-muted-foreground ml-7 mb-2">Select one</p>
                          )}
                          {msg.content?.allowMultipleAnswers === true && (
                            <p className="text-xs text-muted-foreground ml-7 mb-2">Select multiple</p>
                          )}
                          {(msg.content?.pollOptions || msg.content?.options || []).map((opt: any, i: number) => (
                            <div key={i} className="ml-7 py-1.5 text-sm flex items-center gap-2 border-b border-border/30 last:border-0">
                              <span className="w-5 h-5 rounded-full border-2 border-muted-foreground/40 flex items-center justify-center text-[10px] shrink-0"></span>
                              <span>{typeof opt === 'string' ? opt : opt?.name || opt?.optionName || JSON.stringify(opt)}</span>
                              <span className="ml-auto text-xs text-muted-foreground">0</span>
                            </div>
                          ))}
                          {(msg.content?.pollOptions || msg.content?.options || []).length === 0 && !msg.content?.pollName && !msg.content?.question && (
                            <p className="text-sm text-muted-foreground ml-7">{msg.content?.text || 'No poll data'}</p>
                          )}
                        </div>
                      )}
                      {(msg.type === 'event' || msg.type === 'event_creation') && (
                        <div className="bg-secondary/50 rounded-lg p-3 min-w-[220px]">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-lg">📅</span>
                            <p className="font-medium">{msg.content?.eventName || msg.content?.text || 'Event'}</p>
                          </div>
                          {msg.content?.eventStartTime && (
                            <div className="ml-7 flex items-center gap-2 text-sm text-muted-foreground mb-1">
                              <span>🕐</span>
                              <span>{new Date(msg.content.eventStartTime * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                              {msg.content?.eventEndTime && (
                                <span>– {new Date(msg.content.eventEndTime * 1000).toLocaleString('id-ID', { timeStyle: 'short' })}</span>
                              )}
                            </div>
                          )}
                          {msg.content?.eventLocation && (
                            <div className="ml-7 flex items-center gap-2 text-sm text-muted-foreground mb-1">
                              <span>📍</span>
                              <span>{msg.content.eventLocation}</span>
                            </div>
                          )}
                          {msg.content?.eventDescription && (
                            <p className="ml-7 text-sm text-muted-foreground mt-1">{msg.content.eventDescription}</p>
                          )}
                        </div>
                      )}
                      {msg.type === 'sticker' && (
                        <div className="w-32 h-32 flex items-center justify-center">
                          {msg.content?.url ? (
                            <img src={fixMediaUrl(msg.content.url)} alt="Sticker" className="max-w-full max-h-full object-contain" />
                          ) : (
                            <div className="text-6xl">🏷️</div>
                          )}
                        </div>
                      )}
                      {/* Fallback for unknown types */}
                      {!['text', 'image', 'video', 'audio', 'document', 'location', 'vcard', 'contact', 'contacts', 'poll', 'poll_creation', 'event', 'event_creation', 'sticker', 'chat'].includes(msg.type) && (
                        <div className="bg-secondary/50 rounded-lg p-3 text-sm">
                          <p className="text-muted-foreground italic">📎 {msg.type} message</p>
                          {msg.content?.text && <p className="whitespace-pre-wrap break-words mt-1">{sanitizeChatText(msg.content.text)}</p>}
                        </div>
                      )}

                      {/* Timestamp and Status */}
                      <div className={`flex items-center gap-0.5 mt-0.5 ${msg.direction === 'outgoing' ? 'justify-end' : ''}`}>
                        <span className="text-[10px] leading-3 text-[#667781] dark:text-[#8696a0]">
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {!readOnly && msg.direction === 'outgoing' && msg.type === 'text' && msg.status === 'failed' ? (
                          <button
                            type="button"
                            onClick={() => handleRetryMessage(msg)}
                            disabled={retryingMessageId === msg.id}
                            aria-label="Retry message"
                            className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[11px] font-bold text-white hover:bg-red-600 disabled:animate-pulse"
                            title="Message failed. Click to retry."
                          >
                            !
                          </button>
                        ) : msg.direction === 'outgoing' ? <MessageStatus status={msg.status} /> : null}
                      </div>
                      {msg.reactions && msg.reactions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1" aria-label="Message reactions">
                          {Array.from(new Set(msg.reactions)).map(emoji => {
                            const count = msg.reactions?.filter(reaction => reaction === emoji).length || 0;
                            return (
                              <span key={emoji} className="inline-flex h-6 items-center gap-1 rounded-full border border-[#d8dcdf] bg-white px-1.5 text-sm shadow-sm dark:border-[#3b4a54] dark:bg-[#233138]">
                                {emoji}{count > 1 && <span className="text-[10px] text-muted-foreground">{count}</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {!isAtBottom && (
              <Button
                type="button"
                onClick={() => scrollToBottom()}
                aria-label="Jump to latest message"
                className="absolute bottom-[76px] right-4 z-20 h-10 w-10 rounded-full bg-white p-0 text-[#54656f] shadow-lg hover:bg-[#f0f2f5] dark:bg-[#202c33] dark:text-[#d1d7db] dark:hover:bg-[#2a3942]"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                {newMessagesBelow > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#00a884] px-1 text-[10px] font-semibold text-white" aria-label={`${newMessagesBelow} new messages`}>
                    {newMessagesBelow > 99 ? '99+' : newMessagesBelow}
                  </span>
                )}
              </Button>
            )}

            {/* Message Input */}
            {readOnly ? (
              <div className="border-t border-[#d8dcdf] bg-[#f0f2f5] px-4 py-3 text-center text-sm text-[#54656f] dark:border-[#2a3942] dark:bg-[#202c33] dark:text-[#aebac1]">
                Message composer disabled in read-only mode
              </div>
            ) : (
            <div className="px-2.5 md:px-4 py-2 border-t border-[#d8dcdf] dark:border-[#2a3942] bg-[#f0f2f5] dark:bg-[#202c33]">
              {replyTo && (
                <div className="mb-2 ml-11 md:ml-20 flex items-center gap-2 rounded-lg bg-white dark:bg-[#2a3942] px-3 py-2 shadow-sm">
                  <div className="min-w-0 flex-1 border-l-[3px] border-[#06cf9c] pl-3">
                    <p className="text-xs font-semibold text-[#008069] dark:text-[#06cf9c]">
                      Replying to {getReplySenderLabel(replyTo, selectedConversation)}
                    </p>
                    <p className="truncate text-xs text-[#667781] dark:text-[#aebac1]">
                      {getMessagePreview(replyTo)}
                    </p>
                  </div>
                  <button
                    onClick={() => setReplyTo(null)}
                    className="rounded-full p-1.5 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10"
                    aria-label="Cancel reply"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              )}
              <div className="flex items-end gap-1.5 md:gap-2">
                {/* Emoji Button */}
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <span className="text-xl">😊</span>
                  </Button>
                  
                  {showEmojiPicker && (
                    <div className="absolute bottom-12 left-0 bg-card border border-border rounded-2xl shadow-xl z-20 w-[320px]">
                      {/* Category tabs */}
                      <div className="flex gap-1 p-2 border-b border-border">
                        {Object.entries(emojiCategories).map(([key, cat]) => (
                          <button
                            key={key}
                            onClick={() => setEmojiCategory(key)}
                            className={`p-1.5 rounded-lg text-lg transition-colors ${
                              emojiCategory === key ? 'bg-secondary' : 'hover:bg-secondary/50'
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                      {/* Emoji grid */}
                      <div className="p-2 max-h-[200px] overflow-y-auto">
                        <div className="grid grid-cols-8 gap-0.5">
                          {emojiCategories[emojiCategory].emojis.map(emoji => (
                            <button
                              key={emoji}
                              onClick={() => insertEmoji(emoji)}
                              className="text-xl w-9 h-9 flex items-center justify-center hover:bg-secondary rounded-lg transition-colors"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Attachment Button */}
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => { setShowAttachMenu(!showAttachMenu); setShowEmojiPicker(false); }}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </Button>
                  {showAttachMenu && (
                    <div className="absolute bottom-12 left-0 bg-card border border-border rounded-2xl shadow-xl z-20 p-3 w-56">
                      <p className="text-xs text-muted-foreground mb-2 font-medium">Attach file</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { icon: '📷', label: 'Camera', accept: 'image/*', capture: true },
                          { icon: '🖼️', label: 'Image', accept: 'image/*' },
                          { icon: '🎥', label: 'Video', accept: 'video/*' },
                          { icon: '📄', label: 'Document', accept: '.pdf,.doc,.docx,.xls,.xlsx' },
                          { icon: '🎵', label: 'Audio', accept: 'audio/*' },
                          { icon: '👤', label: 'Contact' },
                        ].map(item => (
                          <button
                            key={item.label}
                            onClick={() => {
                              setShowAttachMenu(false);
                              if (item.accept && attachRef.current) {
                                attachRef.current.accept = item.accept;
                                attachRef.current.click();
                              }
                            }}
                            className="flex flex-col items-center gap-1 p-2 rounded-xl hover:bg-secondary transition-colors"
                          >
                            <span className="text-xl">{item.icon}</span>
                            <span className="text-xs text-muted-foreground">{item.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <input ref={attachRef} type="file" className="hidden" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAttachmentSelected(file);
                    e.target.value = '';
                  }} />
                </div>

                {/* Input */}
                <Textarea
                  ref={inputRef}
                  value={messageInput}
                  onChange={e => {
                    setMessageInput(e.target.value);
                    if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
                    if (selectedConversation && selectedProfile && e.target.value) {
                      const now = Date.now();
                      if (now - lastTypingSentRef.current > 3000) {
                        lastTypingSentRef.current = now;
                        api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid }).catch(() => {});
                      }
                      typingStopTimeoutRef.current = setTimeout(() => {
                        api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid, state: 'available' }).catch(() => {});
                        lastTypingSentRef.current = 0;
                        typingStopTimeoutRef.current = null;
                      }, 3000);
                    } else if (selectedConversation && selectedProfile) {
                      api.sendTyping({ profileId: selectedProfile, to: selectedConversation.jid, state: 'available' }).catch(() => {});
                      lastTypingSentRef.current = 0;
                      typingStopTimeoutRef.current = null;
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSend();
                    } else if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Type a message"
                  rows={1}
                  className="min-h-10 max-h-32 flex-1 resize-none rounded-lg border-0 bg-white dark:bg-[#2a3942] px-3 py-2.5 leading-5 shadow-none focus-visible:ring-0"
                />

                {/* Schedule Button */}
                <div className="relative hidden sm:block">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!messageInput.trim()}
                    onClick={() => { setShowSchedulePicker(!showSchedulePicker); setShowEmojiPicker(false); setShowAttachMenu(false); }}
                    className="text-muted-foreground hover:text-foreground"
                    title="Schedule message"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                    </svg>
                  </Button>
                  {showSchedulePicker && (
                    <div className="absolute bottom-12 right-0 bg-card border border-border rounded-2xl shadow-xl z-20 p-4 w-72">
                      <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                        <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                        Schedule Message
                      </h4>
                      <input
                        type="datetime-local"
                        value={scheduleDateTime}
                        onChange={e => setScheduleDateTime(e.target.value)}
                        min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                        className="w-full px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm text-foreground mb-3 focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={!scheduleDateTime || scheduling}
                          onClick={handleScheduleMessage}
                          className="flex-1 bg-[#25D366] hover:bg-[#128C7E] text-white text-xs"
                        >
                          {scheduling ? 'Scheduling...' : '⏰ Schedule'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setShowSchedulePicker(false); setScheduleDateTime(''); }}
                          className="text-xs"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Send Button */}
                <Button
                  onClick={handleSend}
                  disabled={!messageInput.trim() || sending}
                  className="h-10 w-10 shrink-0 rounded-full bg-[#00a884] hover:bg-[#008f72] p-0 text-white"
                  size="sm"
                >
                  {sending ? (
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  )}
                </Button>
              </div>
            </div>
            )}
            {!readOnly && actionSheetMessage && (
              <div className="fixed inset-0 z-[120] flex items-end bg-black/40 md:hidden" role="dialog" aria-modal="true" aria-label="Message actions" onClick={() => setActionSheetMessage(null)}>
                <div
                  className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 shadow-2xl dark:bg-[#202c33]"
                  role="menu"
                  onClick={event => event.stopPropagation()}
                  onKeyDown={event => {
                    if (event.key !== 'Tab') return;
                    const actions = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
                    const first = actions[0];
                    const last = actions[actions.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                  }}
                >
                  <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#c7cdd1] dark:bg-[#53636c]" />
                  <div className="mb-4 rounded-xl bg-[#f0f2f5] px-3 py-2 dark:bg-[#2a3942]">
                    <p className="text-xs font-semibold text-[#008069] dark:text-[#06cf9c]">{actionSheetMessage.direction === 'outgoing' ? 'You' : getMessageSenderLabel(actionSheetMessage)}</p>
                    <p className="mt-1 truncate text-sm text-[#3b4a54] dark:text-[#d1d7db]">{getMessagePreview(actionSheetMessage)}</p>
                  </div>
                  <div className="mb-3 flex justify-around rounded-2xl bg-[#f0f2f5] p-2 dark:bg-[#2a3942]" aria-label="Reactions">
                    {['👍', '❤️', '😂', '😮', '😢', '🙏'].map((emoji, index) => (
                      <button key={emoji} autoFocus={index === 0} role="menuitem" onClick={() => { handleReaction(actionSheetMessage, emoji); setActionSheetMessage(null); }} className="flex h-11 w-11 items-center justify-center rounded-full text-2xl hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#00a884]" aria-label={`React with ${emoji}`}>{emoji}</button>
                    ))}
                  </div>
                  <button role="menuitem" onClick={() => { setReplyTo(actionSheetMessage); setActionSheetMessage(null); setTimeout(() => inputRef.current?.focus(), 0); }} className="flex min-h-12 w-full items-center rounded-xl px-4 text-left text-base hover:bg-secondary">Reply</button>
                  <button role="menuitem" onClick={() => { handleCopyMessage(actionSheetMessage); setActionSheetMessage(null); }} className="flex min-h-12 w-full items-center rounded-xl px-4 text-left text-base hover:bg-secondary">Copy</button>
                  {actionSheetMessage.direction === 'outgoing' && (
                    <button role="menuitem" onClick={() => { setShowDeleteConfirm(actionSheetMessage.messageId || actionSheetMessage.id); setActionSheetMessage(null); }} className="flex min-h-12 w-full items-center rounded-xl px-4 text-left text-base text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">Delete for everyone</button>
                  )}
                  <button role="menuitem" onClick={() => setActionSheetMessage(null)} className="mt-2 flex min-h-12 w-full items-center justify-center rounded-xl border border-border text-base font-medium hover:bg-secondary">Cancel</button>
                </div>
              </div>
            )}
            {!readOnly && pendingAttachment && (
              <div className="fixed inset-0 z-[100] flex flex-col bg-[#f0f2f5] dark:bg-[#111b21] md:absolute md:z-50" role="dialog" aria-modal="true" aria-label="Attachment preview">
                <div className="flex h-[60px] items-center gap-3 border-b border-[#d8dcdf] bg-white px-3 dark:border-[#2a3942] dark:bg-[#202c33]">
                  <Button variant="ghost" size="sm" className="h-9 w-9 p-0" onClick={clearAttachmentPreview} disabled={attachmentSending} aria-label="Cancel attachment">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{pendingAttachment.file.name}</p>
                    <p className="text-xs text-muted-foreground">{pendingAttachment.file.size < 1024 * 1024 ? `${(pendingAttachment.file.size / 1024).toFixed(1)} KB` : `${(pendingAttachment.file.size / (1024 * 1024)).toFixed(1)} MB`} · {pendingAttachment.type}</p>
                  </div>
                  <Button variant="ghost" size="sm" className="text-sm" disabled={attachmentSending} onClick={() => attachRef.current?.click()} aria-label="Replace attachment">Replace</Button>
                </div>

                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 md:p-8">
                  {pendingAttachment.type === 'image' ? (
                    <img src={pendingAttachment.objectUrl} alt="Attachment preview" className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />
                  ) : pendingAttachment.type === 'video' ? (
                    <video src={pendingAttachment.objectUrl} controls className="max-h-full max-w-full rounded-lg bg-black shadow-lg" aria-label="Attachment preview" />
                  ) : pendingAttachment.type === 'audio' ? (
                    <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lg dark:bg-[#202c33]">
                      <div className="mb-4 text-center text-5xl">🎵</div>
                      <p className="mb-4 truncate text-center font-medium">{pendingAttachment.file.name}</p>
                      <audio src={pendingAttachment.objectUrl} controls className="w-full" aria-label="Attachment preview" />
                    </div>
                  ) : (
                    <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-[#202c33]">
                      <div className="mb-4 text-6xl">📄</div>
                      <p className="break-words font-semibold">{pendingAttachment.file.name}</p>
                      <p className="mt-2 text-sm text-muted-foreground">{pendingAttachment.file.type || 'Document'}</p>
                    </div>
                  )}
                </div>

                <div className="border-t border-[#d8dcdf] bg-white px-3 py-3 dark:border-[#2a3942] dark:bg-[#202c33] md:px-6">
                  {attachmentError && (
                    <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300" role="alert">Upload failed: {attachmentError}. Your file is still selected.</div>
                  )}
                  <div className="mx-auto flex max-w-3xl items-end gap-2">
                    {pendingAttachment.type !== 'audio' && (
                      <Textarea
                        value={attachmentCaption}
                        onChange={event => setAttachmentCaption(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            handleAttachmentSend();
                          }
                        }}
                        placeholder="Add a caption"
                        rows={1}
                        disabled={attachmentSending}
                        className="min-h-10 max-h-28 flex-1 resize-none rounded-lg border-0 bg-[#f0f2f5] px-3 py-2.5 shadow-none focus-visible:ring-1 dark:bg-[#2a3942]"
                      />
                    )}
                    <Button onClick={handleAttachmentSend} disabled={attachmentSending} aria-label={attachmentError ? 'Retry attachment' : 'Send attachment'} className="h-11 w-11 shrink-0 rounded-full bg-[#00a884] p-0 text-white hover:bg-[#008f72]">
                      {attachmentSending ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          /* No Conversation Selected */
          <div className="flex-1 flex items-center justify-center bg-[#f0f2f5] dark:bg-[#222e35] border-b-[6px] border-[#25d366]">
            <div className="text-center">
              <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-secondary/50 flex items-center justify-center">
                <svg className="w-12 h-12 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">MultiWA Chat</h3>
              <p className="text-muted-foreground max-w-sm mx-auto">
                Select a conversation from the sidebar to view messages and start chatting
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Contact Info Sidebar */}
      {showContactInfo && selectedConversation && (
        <div className="w-80 border-l border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border bg-secondary/30 flex items-center justify-between">
            <h3 className="font-semibold text-foreground">Contact Info</h3>
            <Button variant="ghost" size="sm" onClick={() => setShowContactInfo(false)}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>

          {/* Profile Card */}
          <div className="p-6 text-center border-b border-border">
            <Avatar className="w-20 h-20 mx-auto mb-3">
              <AvatarImage src={(selectedConversation as any).avatar} />
              <AvatarFallback className="bg-[#25D366] text-white text-2xl">
                {getInitials(getDisplayName(selectedConversation))}
              </AvatarFallback>
            </Avatar>
            <h4 className="font-semibold text-lg text-foreground">
              {getDisplayName(selectedConversation)}
            </h4>
            {getConversationSubtitle(selectedConversation) && (
              <p className="text-sm text-muted-foreground mt-1">
                {getConversationSubtitle(selectedConversation)}
              </p>
            )}
            <Badge className="mt-2" variant="outline">
              {selectedConversation.type === 'group' ? '👥 Group' : '👤 Personal'}
            </Badge>
          </div>

          {/* Details */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Phone */}
            <div className="bg-secondary/30 rounded-xl p-3">
              <p className="text-xs text-muted-foreground mb-1">📱 Phone</p>
              <p className="text-sm font-medium text-foreground">
                {getConversationSubtitle(selectedConversation) || 'Hidden'}
              </p>
            </div>

            {/* JID */}
            <div className="bg-secondary/30 rounded-xl p-3">
              <p className="text-xs text-muted-foreground mb-1">🔗 WhatsApp ID</p>
              <p className="text-xs font-mono text-foreground break-all">
                {displayWhatsAppId(selectedConversation.jid)}
              </p>
            </div>

            {/* Messages Count */}
            <div className="bg-secondary/30 rounded-xl p-3">
              <p className="text-xs text-muted-foreground mb-1">💬 Messages</p>
              <p className="text-sm font-medium text-foreground">
                {messages.length} messages in this conversation
              </p>
            </div>

            {/* First & Last Message */}
            {messages.length > 0 && (
              <div className="bg-secondary/30 rounded-xl p-3">
                <p className="text-xs text-muted-foreground mb-1">📅 Activity</p>
                <div className="space-y-1">
                  <p className="text-xs text-foreground">
                    <span className="text-muted-foreground">First: </span>
                    {new Date(messages[0]?.timestamp || '').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                  <p className="text-xs text-foreground">
                    <span className="text-muted-foreground">Last: </span>
                    {new Date(messages[messages.length - 1]?.timestamp || '').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
              </div>
            )}

            {/* Tags */}
            {(selectedConversation as any).contact?.tags?.length > 0 && (
              <div className="bg-secondary/30 rounded-xl p-3">
                <p className="text-xs text-muted-foreground mb-2">🏷️ Tags</p>
                <div className="flex flex-wrap gap-1">
                  {(selectedConversation as any).contact.tags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Quick Actions */}
            <div className="pt-2 space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-2 text-sm"
                onClick={() => window.open(`/dashboard/contacts?phone=${encodeURIComponent(contactLookupPhone(selectedConversation))}`, '_self')}
              >
                👤 View in Contacts
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
