// MultiWA Gateway - Baileys Adapter (SECONDARY ENGINE)
// packages/engines/src/adapters/baileys.adapter.ts

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import type {
  IWhatsAppEngine,
  EngineConfig,
  EngineStatus,
  MessageResult,
  MediaOptions,
  LocationOptions,
  ContactOptions,
  PollOptions,
  SendMessageOptions,
} from '../types';
import { normalizeBaileysPresenceUpdate } from '../presence';
import { shouldHandleBaileysDisconnect } from './baileys-lifecycle';
import {
  isBaileysProtocolMessage,
  normalizeBaileysEditedMessage,
  normalizeBaileysInbound,
  normalizeBaileysProtocolEdit,
} from './baileys-inbound';
import { decryptBaileysSecretEdit } from './baileys-secret-edit';


export class BaileysAdapter implements IWhatsAppEngine {
  readonly engineType = 'baileys' as const;

  private socket: ReturnType<typeof makeWASocket> | null = null;
  private config: EngineConfig | null = null;
  private status: EngineStatus = {
    isConnected: false,
    isAuthenticated: false,
  };
  private currentQR: string | null = null;
  private qrCallbacks: ((qr: string) => void)[] = [];
  private authState: any = null;
  private connectionRetryCount: number = 0;
  private maxConnectionRetries: number = 3;
  private isDestroying = false;
  private phoneNumberShares = new Map<string, string>();
  private messageCache = new Map<string, proto.IWebMessageInfo>();

  private messageCacheKey(remoteJid: string | null | undefined, id: string | null | undefined): string {
    return `${remoteJid || ''}:${id || ''}`;
  }

  private rememberMessage(message: proto.IWebMessageInfo): void {
    if (!message.message || !message.key.id) return;
    this.messageCache.set(
      this.messageCacheKey(message.key.remoteJid, message.key.id),
      message,
    );
    if (this.messageCache.size > 2000) {
      const oldestKey = this.messageCache.keys().next().value;
      if (oldestKey) this.messageCache.delete(oldestKey);
    }
  }

  private eventDate(value: unknown): Date | undefined {
    if (value === null || value === undefined) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    const milliseconds = numeric > 10000000000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private canonicalJid(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    return this.phoneNumberShares.get(value) || value;
  }

  private async emitInboundMessage(message: proto.IWebMessageInfo, historical: boolean): Promise<void> {
    // A null payload is Baileys' CIPHERTEXT/unavailable placeholder. Baileys
    // requests a retry itself; it is not a customer message and must not be
    // persisted or trigger notifications/automations.
    if (!message.message || message.key.fromMe || isBaileysProtocolMessage(message.message)) return;
    this.rememberMessage(message);
    const inbound = normalizeBaileysInbound(message.message);
    const remoteJid = this.canonicalJid(message.key.remoteJid);
    const participant = this.canonicalJid(message.key.participant);
    await this.config?.onMessage?.({
      id: message.key.id,
      from: remoteJid,
      to: this.socket?.user?.id,
      body: inbound.body,
      type: inbound.type,
      timestamp: this.eventDate(message.messageTimestamp) || new Date(),
      isGroup: remoteJid?.endsWith('@g.us') || false,
      hasMedia: Boolean(inbound.media),
      fromMe: false,
      author: participant,
      participant,
      pushName: message.pushName,
      isHistorical: historical,
      downloadMedia: inbound.media ? async () => {
        const data = await downloadMediaMessage(message as any, 'buffer', {});
        return {
          data: data.toString('base64'),
          mimetype: inbound.media?.mimetype || 'application/octet-stream',
          filename: inbound.media?.filename,
        };
      } : undefined,
    });
  }

  async initialize(config: EngineConfig): Promise<void> {
    this.config = config;
    const sessionDir = config.sessionDir || `./sessions/${config.profileId}`;

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    this.authState = { state, saveCreds };
  }

  async connect(): Promise<void> {
    if (!this.authState) {
      throw new Error('Not initialized. Call initialize() first.');
    }

    const { version } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] Using WA version ${version.join('.')}`);

    this.socket = makeWASocket({
      version,
      auth: {
        creds: this.authState.state.creds,
        keys: makeCacheableSignalKeyStore(
          this.authState.state.keys,
          console as any
        ),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      getMessage: async key => this.messageCache.get(
        this.messageCacheKey(key.remoteJid, key.id),
      )?.message,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    if (!this.socket) return;

    // Connection update
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[Baileys] QR Code received for profile ${this.config?.profileId}`);
        this.currentQR = qr;
        qrcode.generate(qr, { small: true });
        this.qrCallbacks.forEach((cb) => cb(qr));
        this.config?.onQR?.(qr);
      }

      if (connection === 'close') {
        if (!shouldHandleBaileysDisconnect(this.isDestroying)) return;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isConnectionFailure = lastDisconnect?.error?.message?.includes('Connection Failure');

        console.log(
          `[Baileys] Connection closed for profile ${this.config?.profileId}. StatusCode: ${statusCode}, Retry count: ${this.connectionRetryCount}`
        );

        this.status = { isConnected: false, isAuthenticated: false };

        // Check if session might be stale (multiple connection failures)
        if (isConnectionFailure) {
          this.connectionRetryCount++;
          
          if (this.connectionRetryCount >= this.maxConnectionRetries) {
            console.log(`[Baileys] Max retries (${this.maxConnectionRetries}) reached for profile ${this.config?.profileId}. Clearing stale session...`);
            
            // Clear session folder to force fresh QR code
            const sessionDir = this.config?.sessionDir || `./sessions/${this.config?.profileId}`;
            try {
              const fs = require('fs');
              const path = require('path');
              const files = fs.readdirSync(sessionDir);
              for (const file of files) {
                fs.unlinkSync(path.join(sessionDir, file));
              }
              console.log(`[Baileys] Session cleared for profile ${this.config?.profileId}. Will generate new QR code.`);
            } catch (err: any) {
              console.error(`[Baileys] Failed to clear session: ${err.message}`);
            }
            
            this.connectionRetryCount = 0;
            // Notify disconnect - user needs to reconnect with fresh QR
            this.config?.onDisconnected?.('Session expired. Please reconnect.');
            return;
          }
        } else {
          // Reset retry count on different error types
          this.connectionRetryCount = 0;
        }

        this.config?.onDisconnected?.(
          lastDisconnect?.error?.message || 'Connection closed'
        );

        // EngineManager owns retry/backoff. Keeping a second reconnect loop in
        // the adapter creates overlapping sockets and rapidly invalidates QRs.
      }

      if (connection === 'open') {
        console.log(`[Baileys] Connected for profile ${this.config?.profileId}`);
        this.connectionRetryCount = 0; // Reset retry counter on successful connection
        this.status = {
          isConnected: true,
          isAuthenticated: true,
          phone: this.socket?.user?.id?.split(':')[0],
          pushName: this.socket?.user?.name,
          lastConnectedAt: new Date(),
        };
        this.currentQR = null;
        this.config?.onReady?.(
          this.socket?.user?.id?.split(':')[0] || '',
          this.socket?.user?.name || ''
        );
      }
    });

    // Credentials update
    this.socket.ev.on('creds.update', this.authState.saveCreds);

    this.socket.ev.on('presence.update', update => {
      for (const presence of normalizeBaileysPresenceUpdate(update)) {
        this.config?.onPresenceUpdate?.(presence);
      }
    });

    this.socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
      this.phoneNumberShares.set(lid, pn);
      this.config?.onPhoneNumberShare?.({ lid, jid: pn });
    });

    this.socket.ev.on('messaging-history.set', async ({ messages }) => {
      // Baileys supplies this array newest-first. Bound replay work so a fresh
      // connection cannot overwhelm persistence or media download quotas.
      const recentMessages = messages.slice(0, 500);
      for (let offset = 0; offset < recentMessages.length; offset += 5) {
        await Promise.all(
          recentMessages.slice(offset, offset + 5)
            .map(message => this.emitInboundMessage(message, true)),
        );
      }
    });

    // Messages
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const message of messages) {
        const secretEdit = message.message?.secretEncryptedMessage;
        if (secretEdit?.targetMessageKey?.id) {
          const original = this.messageCache.get(this.messageCacheKey(
            secretEdit.targetMessageKey.remoteJid || message.key.remoteJid,
            secretEdit.targetMessageKey.id,
          ));
          const decrypted = decryptBaileysSecretEdit(message, original);
          if (decrypted) {
            console.log(
              `[Baileys] Secret edit profile=${this.config?.profileId} target=${decrypted.messageId} type=${decrypted.type} bodyLength=${decrypted.body.length}`,
            );
            await this.config?.onMessageEdit?.({
              messageId: decrypted.messageId,
              body: decrypted.body,
              type: decrypted.type,
              editedAt: this.eventDate(message.messageTimestamp),
            });
            continue;
          }
          // This is an encrypted edit envelope, not a new chat message. If the
          // original is no longer in the bounded cache, leave the existing row
          // unchanged instead of creating a misleading `unknown` message.
          console.warn(
            `[Baileys] Secret edit unavailable profile=${this.config?.profileId} target=${secretEdit.targetMessageKey.id}`,
          );
          continue;
        }
        const protocolEdit = normalizeBaileysProtocolEdit(message.message);
        if (protocolEdit) {
          console.log(
            `[Baileys] Edit upsert profile=${this.config?.profileId} target=${protocolEdit.messageId} type=${protocolEdit.inbound.type} bodyLength=${protocolEdit.inbound.body.length}`,
          );
          await this.config?.onMessageEdit?.({
            messageId: protocolEdit.messageId,
            body: protocolEdit.inbound.body,
            type: protocolEdit.inbound.type,
            editedAt: this.eventDate(protocolEdit.timestampMs),
          });
          continue;
        }
        await this.emitInboundMessage(message, type === 'append');
      }
    });

    // Message status, edits, revokes, and poll changes
    this.socket.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (update.update.status) {
          const statusMap: Record<number, string> = {
            1: 'pending',
            2: 'sent',
            3: 'delivered',
            4: 'read',
          };
          this.config?.onMessageAck?.(
            update.key.id || '',
            statusMap[update.update.status] || 'unknown'
          );
        }
        const edited = normalizeBaileysEditedMessage(update.update.message);
        if (edited && update.key.id) {
          console.log(
            `[Baileys] Edit update profile=${this.config?.profileId} target=${update.key.id} type=${edited.type} bodyLength=${edited.body.length}`,
          );
          void this.config?.onMessageEdit?.({
            messageId: update.key.id,
            body: edited.body,
            type: edited.type,
            editedAt: this.eventDate(update.update.messageTimestamp),
          });
        }
        if (update.key.id && update.update.message === null) {
          this.config?.onMessageDelete?.({
            messageIds: [update.key.id],
            deletedAt: new Date(),
          });
        }
      }
    });

    this.socket.ev.on('messages.delete', event => {
      if ('all' in event) {
        this.config?.onMessageDelete?.({ jid: event.jid, all: true, deletedAt: new Date() });
        return;
      }
      this.config?.onMessageDelete?.({
        messageIds: event.keys.map(key => key.id || '').filter(Boolean),
        deletedAt: new Date(),
      });
    });

    this.socket.ev.on('messages.reaction', events => {
      events.forEach(({ key, reaction }) => {
        if (!key.id) return;
        const senderJid = this.canonicalJid(reaction.key?.participant || reaction.key?.remoteJid) || '';
        this.config?.onMessageReaction?.({
          messageId: key.id,
          reactionId: reaction.key?.id || `${key.id}:reaction:${senderJid}`,
          senderJid,
          emoji: reaction.text || '',
          timestamp: this.eventDate(reaction.senderTimestampMs),
          fromMe: Boolean(reaction.key?.fromMe),
        });
      });
    });

    this.socket.ev.on('message-receipt.update', events => {
      events.forEach(({ key, receipt }) => {
        if (!key.id || !receipt.userJid) return;
        this.config?.onMessageReceipt?.({
          messageId: key.id,
          participantJid: this.canonicalJid(receipt.userJid) || receipt.userJid,
          deliveredAt: this.eventDate(receipt.receiptTimestamp),
          readAt: this.eventDate(receipt.readTimestamp),
          playedAt: this.eventDate(receipt.playedTimestamp),
        });
      });
    });

    this.socket.ev.on('messages.media-update', events => {
      events.forEach(event => {
        if (!event.key.id) return;
        this.config?.onMediaUpdate?.({
          messageId: event.key.id,
          available: Boolean(event.media) && !event.error,
          error: event.error?.message,
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isDestroying = true;
    if (this.socket) {
      await this.socket.logout();
      this.status = { isConnected: false, isAuthenticated: false };
    }
  }

  async destroy(): Promise<void> {
    this.isDestroying = true;
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
      this.status = { isConnected: false, isAuthenticated: false };
    }
  }

  getStatus(): EngineStatus {
    return { ...this.status };
  }

  isReady(): boolean {
    return this.status.isConnected && this.status.isAuthenticated;
  }

  // ========== MESSAGING ==========

  async sendText(
    to: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      const jid = this.normalizeToJid(to);
      const result = await this.socket.sendMessage(jid, { text });

      return {
        success: true,
        messageId: result?.key.id,
        timestamp: new Date(),
      };
    } catch (error: any) {
      console.error('[Baileys] Send text error:', error);
      return { success: false, error: error.message };
    }
  }

  async sendImage(
    to: string,
    media: MediaOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    return this.sendMedia(to, media, 'image', options);
  }

  async sendVideo(
    to: string,
    media: MediaOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    return this.sendMedia(to, media, 'video', options);
  }

  async sendAudio(
    to: string,
    media: MediaOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    return this.sendMedia(to, media, 'audio', options);
  }

  async sendDocument(
    to: string,
    media: MediaOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    return this.sendMedia(to, media, 'document', options);
  }

  private async sendMedia(
    to: string,
    media: MediaOptions,
    type: 'image' | 'video' | 'audio' | 'document',
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      const jid = this.normalizeToJid(to);
      let messageContent: any = {};

      const mediaBuffer = media.url
        ? { url: media.url }
        : Buffer.from(media.base64 || '', 'base64');

      switch (type) {
        case 'image':
          messageContent = { image: mediaBuffer, caption: media.caption };
          break;
        case 'video':
          messageContent = { video: mediaBuffer, caption: media.caption };
          break;
        case 'audio':
          messageContent = { audio: mediaBuffer, ptt: true };
          break;
        case 'document':
          messageContent = {
            document: mediaBuffer,
            fileName: media.filename,
            mimetype: media.mimetype,
          };
          break;
      }

      const result = await this.socket.sendMessage(jid, messageContent);

      return {
        success: true,
        messageId: result?.key.id,
        timestamp: new Date(),
      };
    } catch (error: any) {
      console.error(`[Baileys] Send ${type} error:`, error);
      return { success: false, error: error.message };
    }
  }

  async sendLocation(
    to: string,
    location: LocationOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      const jid = this.normalizeToJid(to);
      const result = await this.socket.sendMessage(jid, {
        location: {
          degreesLatitude: location.latitude,
          degreesLongitude: location.longitude,
          name: location.name,
          address: location.address,
        },
      });

      return {
        success: true,
        messageId: result?.key.id,
        timestamp: new Date(),
      };
    } catch (error: any) {
      console.error('[Baileys] Send location error:', error);
      return { success: false, error: error.message };
    }
  }

  async sendContact(
    to: string,
    contact: ContactOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      const jid = this.normalizeToJid(to);
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL;type=CELL;type=VOICE;waid=${contact.phone}:+${contact.phone}\nEND:VCARD`;

      const result = await this.socket.sendMessage(jid, {
        contacts: {
          displayName: contact.name,
          contacts: [{ vcard }],
        },
      });

      return {
        success: true,
        messageId: result?.key.id,
        timestamp: new Date(),
      };
    } catch (error: any) {
      console.error('[Baileys] Send contact error:', error);
      return { success: false, error: error.message };
    }
  }

  async sendReaction(messageId: string, emoji: string): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      // Baileys reaction requires the message key
      // This is a simplified version
      return { success: true, messageId };
    } catch (error: any) {
      console.error('[Baileys] Send reaction error:', error);
      return { success: false, error: error.message };
    }
  }

  async sendPoll(
    to: string,
    poll: PollOptions,
    options?: SendMessageOptions
  ): Promise<MessageResult> {
    try {
      if (!this.isReady() || !this.socket) {
        return { success: false, error: 'Client not ready' };
      }

      const jid = this.normalizeToJid(to);
      const result = await this.socket.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.allowMultipleAnswers ? poll.options.length : 1,
        },
      });

      return {
        success: true,
        messageId: result?.key.id,
        timestamp: new Date(),
      };
    } catch (error: any) {
      console.error('[Baileys] Send poll error:', error);
      return { success: false, error: error.message };
    }
  }


  // ========== PRESENCE & CHAT STATE ==========

  async sendPresenceUpdate(to: string, state: 'composing' | 'available' | 'recording'): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) return;

      const jid = this.normalizeToJid(to);
      await this.socket.presenceSubscribe(jid);
      await this.socket.sendPresenceUpdate(state, jid);
      console.log(`[Baileys] Presence update: ${state} -> ${jid}`);
    } catch (error: any) {
      console.error('[Baileys] Send presence update error:', error);
      // Non-critical — don't throw
    }
  }

  async markAsRead(chatId: string, messageIds?: string[]): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) return;

      const jid = this.normalizeToJid(chatId);
      const keys = messageIds?.map(id => ({
        remoteJid: jid,
        id,
        fromMe: false,
      })) || [];

      if (keys.length > 0) {
        await this.socket.readMessages(keys);
      } else {
        // Mark entire chat as read by reading the latest message
        await this.socket.readMessages([{ remoteJid: jid, id: 'latest', fromMe: false }]);
      }
      console.log(`[Baileys] Marked as read: ${jid}, messages: ${messageIds?.length || 'all'}`);
    } catch (error: any) {
      console.error('[Baileys] Mark as read error:', error);
    }
  }

  async deleteForEveryone(chatId: string, messageId: string): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) return;

      const jid = this.normalizeToJid(chatId);
      const key = {
        remoteJid: jid,
        id: messageId,
        fromMe: true,
      };
      await this.socket.sendMessage(jid, { delete: key });
      console.log(`[Baileys] Deleted message ${messageId} for everyone in ${jid}`);
    } catch (error: any) {
      console.error('[Baileys] Delete for everyone error:', error);
      throw error;
    }
  }

  // ========== QR CODE ==========

  async getQRCode(): Promise<string | null> {
    return this.currentQR;
  }

  onQR(callback: (qr: string) => void): void {
    this.qrCallbacks.push(callback);
    if (this.currentQR) {
      callback(this.currentQR);
    }
  }

  // ========== SESSION ==========

  async getSessionData(): Promise<any> {
    return null; // Baileys uses file-based auth
  }

  async restoreSession(data: any): Promise<boolean> {
    return true;
  }

  // ========== HELPERS ==========

  private normalizeToJid(phone: string): string {
    // If already a valid JID (contains @), return as-is
    // This preserves @g.us for groups and @s.whatsapp.net for individuals
    if (phone.includes('@')) {
      return phone;
    }
    
    // For regular phone numbers, strip non-digits and normalize
    let normalized = phone.replace(/\D/g, '');
    if (normalized.startsWith('0')) {
      normalized = '62' + normalized.slice(1);
    }
    return `${normalized}@s.whatsapp.net`;
  }

  // ========== GROUPS ==========

  async getGroups(): Promise<import('../types').GroupInfo[]> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      // Baileys uses groupFetchAllParticipating
      const groups = await this.socket.groupFetchAllParticipating();
      return Object.values(groups).map((g: any) => ({
        id: g.id,
        name: g.subject || '',
        description: g.desc || '',
        participants: (g.participants || []).map((p: any) => ({
          id: p.id,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
        owner: g.owner,
        createdAt: g.creation ? new Date(g.creation * 1000) : undefined,
      }));
    } catch (error: any) {
      console.error('[Baileys] Get groups error:', error);
      throw error;
    }
  }

  async getGroupInfo(groupId: string): Promise<import('../types').GroupInfo> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      const metadata = await this.socket.groupMetadata(groupId);
      return {
        id: metadata.id,
        name: metadata.subject || '',
        description: metadata.desc || '',
        participants: (metadata.participants || []).map((p: any) => ({
          id: p.id,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin',
        })),
        owner: metadata.owner,
        createdAt: metadata.creation ? new Date(metadata.creation * 1000) : undefined,
      };
    } catch (error: any) {
      console.error('[Baileys] Get group info error:', error);
      throw error;
    }
  }

  // ========== CONTACTS ==========

  async getContacts(): Promise<import('../types').ContactInfo[]> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }

      // Baileys doesn't have a direct method to get all contacts
      // We use the store to get contacts from chat history
      const store = (this.socket as any).store;
      const contacts: import('../types').ContactInfo[] = [];

      if (store?.contacts) {
        // Get contacts from store
        for (const [jid, contact] of Object.entries(store.contacts)) {
          if (jid.endsWith('@s.whatsapp.net') && contact) {
            const c = contact as any;
            const phone = jid.replace('@s.whatsapp.net', '');
            contacts.push({
              id: jid,
              phone: phone,
              name: c.name || c.notify || phone,
              pushName: c.notify,
              isGroup: false,
              isMyContact: !!c.name, // Has name = is in contacts
            });
          }
        }
      }

      // If store is empty, try to get from chats
      if (contacts.length === 0) {
        const chats = await this.socket.profilePictureUrl(this.status.phone + '@s.whatsapp.net', 'preview').catch(() => null);
        console.log('[Baileys] GetContacts: Store empty, contacts from chats not available yet');
      }

      console.log(`[Baileys] GetContacts: Found ${contacts.length} contacts`);
      return contacts;
    } catch (error: any) {
      console.error('[Baileys] Get contacts error:', error);
      throw error;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<import('../types').GroupInfo> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      const group = await this.socket.groupCreate(name, participants);
      return {
        id: group.id,
        name: name,
        participants: participants.map(p => ({ id: p, isAdmin: false })),
      };
    } catch (error: any) {
      console.error('[Baileys] Create group error:', error);
      throw error;
    }
  }

  async setGroupName(groupId: string, name: string): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupUpdateSubject(groupId, name);
    } catch (error: any) {
      console.error('[Baileys] Set group name error:', error);
      throw error;
    }
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupUpdateDescription(groupId, description);
    } catch (error: any) {
      console.error('[Baileys] Set group description error:', error);
      throw error;
    }
  }

  async addGroupParticipants(groupId: string, participants: string[]): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupParticipantsUpdate(groupId, participants, 'add');
    } catch (error: any) {
      console.error('[Baileys] Add group participants error:', error);
      throw error;
    }
  }

  async removeGroupParticipants(groupId: string, participants: string[]): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupParticipantsUpdate(groupId, participants, 'remove');
    } catch (error: any) {
      console.error('[Baileys] Remove group participants error:', error);
      throw error;
    }
  }

  async promoteGroupParticipants(groupId: string, participants: string[]): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupParticipantsUpdate(groupId, participants, 'promote');
    } catch (error: any) {
      console.error('[Baileys] Promote participants error:', error);
      throw error;
    }
  }

  async demoteGroupParticipants(groupId: string, participants: string[]): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupParticipantsUpdate(groupId, participants, 'demote');
    } catch (error: any) {
      console.error('[Baileys] Demote participants error:', error);
      throw error;
    }
  }

  async leaveGroup(groupId: string): Promise<void> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      await this.socket.groupLeave(groupId);
    } catch (error: any) {
      console.error('[Baileys] Leave group error:', error);
      throw error;
    }
  }

  async getGroupInviteLink(groupId: string): Promise<string> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      const code = await this.socket.groupInviteCode(groupId);
      return `https://chat.whatsapp.com/${code}`;
    } catch (error: any) {
      console.error('[Baileys] Get invite link error:', error);
      throw error;
    }
  }

  async revokeGroupInviteLink(groupId: string): Promise<string> {
    try {
      if (!this.isReady() || !this.socket) {
        throw new Error('Client not ready');
      }
      const code = await this.socket.groupRevokeInvite(groupId);
      return `https://chat.whatsapp.com/${code}`;
    } catch (error: any) {
      console.error('[Baileys] Revoke invite link error:', error);
      throw error;
    }
  }
}
