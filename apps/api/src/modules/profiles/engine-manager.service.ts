// MultiWA Gateway API - Engine Manager Service
// apps/api/src/modules/profiles/engine-manager.service.ts
//
// This service manages WhatsApp engine instances and wires them to EventsGateway

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EventsGateway } from '../events/events.gateway';
import { prisma } from '@multiwa/database';
import { EngineFactory } from '@multiwa/engines';
import type { IWhatsAppEngine, EngineConfig } from '@multiwa/engines';
import * as path from 'path';
import * as QRCode from 'qrcode';
import { RuleEngineService, IncomingMessage } from '../automation/rule-engine.service';
import { NotificationsService, NotificationType } from '../notifications/notifications.service';
import { AppEvent, HooksService } from '../hooks/hooks.service';
import { FastBotsService } from '../integrations/fastbots.service';
import {
  isProtocolStatusMessageType,
  isStatusBroadcastJid,
  shouldRouteTextToFastBots,
} from './message-type-filter';
import { resolveSenderIdentity } from './sender-identity';
import { resolveProfileEngineType } from './profile-engine';


interface EngineInstance {
  engine: IWhatsAppEngine;
  profileId: string;
  status: 'connecting' | 'connected' | 'disconnected';
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

@Injectable()
export class EngineManagerService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(EngineManagerService.name);
  private engines = new Map<string, EngineInstance>();
  private processingInboundMessageKeys = new Set<string>();

  constructor(
    private readonly eventsGateway: EventsGateway,
    @Inject(forwardRef(() => RuleEngineService))
    private readonly ruleEngineService: RuleEngineService,
    private readonly notificationsService: NotificationsService,
    private readonly hooksService: HooksService,
    private readonly fastBotsService: FastBotsService,
  ) {
    this.logger.log('EngineManagerService initialized');
  }

  /**
   * On module init:
   * 1. Reset stale 'connected' profiles to 'disconnected'
   * 2. Auto-reconnect profiles that have valid session data
   */
  async onModuleInit() {
    this.logger.log('EngineManagerService initializing...');
    
    try {
      // Step 1: Reset all profiles that show as 'connected' in the database
      // (since we just started, no engines are actually running)
      const staleProfiles = await prisma.profile.findMany({
        where: { status: 'connected' },
        select: { id: true, displayName: true },
      });

      if (staleProfiles.length > 0) {
        this.logger.warn(`Found ${staleProfiles.length} stale 'connected' profiles, resetting to 'disconnected'`);
        
        await prisma.profile.updateMany({
          where: { status: 'connected' },
          data: { status: 'disconnected' },
        });

        staleProfiles.forEach(p => {
          this.logger.log(`Reset profile to disconnected: ${p.displayName || p.id}`);
        });
      }

      // Step 2: Reconnect only profiles that were connected before this API
      // process started. A session directory can remain after an intentional
      // disconnect and must not override the operator's selected state.
      await this.autoReconnectProfiles(staleProfiles.map(profile => profile.id));
      
    } catch (error) {
      this.logger.error('Error in onModuleInit:', error);
    }
  }

  /**
   * Auto-reconnect profiles that have existing session credentials
   * This allows profiles to resume connection after API restart without QR scan
   */
  private async autoReconnectProfiles(profileIds: string[]) {
    this.logger.log('Checking for profiles with valid sessions to auto-reconnect...');

    if (profileIds.length === 0) {
      this.logger.log('No previously connected profiles to auto-reconnect');
      return;
    }
    
    const fs = await import('fs/promises');
    const sessionsDir = process.env.SESSIONS_DIR || '/data/sessions';
    
    try {
      // Get only profiles that were connected before startup reset their
      // persisted status. Deliberately disconnected profiles are excluded.
      const profiles = await prisma.profile.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, displayName: true, lastConnectedAt: true },
      });

      let reconnectedCount = 0;
      
      for (const profile of profiles) {
        const sessionDir = path.join(sessionsDir, profile.id);
        
        // Check if the session directory exists at all.
        // We no longer check .wwebjs_auth/session-{profileId}/ specifically, because
        // cleanupStaleLockFiles() deletes the entire .wwebjs_auth dir.  The MultiDevice
        // auth state is re-established transparently by whatsapp-web-js when the engine
        // connects, so a simple directory existence check is sufficient.
        let hasSession = false;
        try {
          await fs.access(sessionDir);
          hasSession = true;
          this.logger.log(`Found session directory for: ${profile.displayName || profile.id}, will attempt reconnect`);
        } catch {
          // No session directory at all — profile was never connected
        }

        if (!hasSession) {
          this.logger.debug(`No session found for profile: ${profile.displayName || profile.id}`);
          continue;
        }

        try {
          
          // Session exists, auto-reconnect
          this.logger.log(`Auto-reconnecting profile: ${profile.displayName || profile.id}`);
          
          // Connect in background (don't await to avoid blocking startup)
          this.connectProfile(profile.id)
            .then(result => {
              this.logger.log(`Auto-reconnect result for ${profile.displayName || profile.id}: ${result.message}`);
            })
            .catch(async (err) => {
              this.logger.error(`Auto-reconnect failed for ${profile.displayName || profile.id}:`, err);
              
              // Clear corrupted session data so user gets fresh QR on next connect
              try {
                const sessionDir2 = path.join(sessionsDir, profile.id);
                await fs.rm(sessionDir2, { recursive: true, force: true });
                this.logger.warn(`Cleared corrupted session for ${profile.displayName || profile.id} after auto-reconnect failure`);
              } catch (clearErr) {
                this.logger.warn(`Could not clear session: ${(clearErr as Error).message}`);
              }
              
              // Ensure DB status is reset
              try {
                await prisma.profile.update({
                  where: { id: profile.id },
                  data: { status: 'disconnected' },
                });
              } catch (dbErr) {
                this.logger.error(`Failed to reset profile status:`, dbErr);
              }
            });
          
          reconnectedCount++;
          
          // Small delay between reconnects to avoid overwhelming WhatsApp
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (reconnectErr: any) {
          this.logger.error(`Failed to reconnect profile ${profile.displayName || profile.id}: ${reconnectErr.message}`);
        }
      }

      if (reconnectedCount > 0) {
        this.logger.log(`Initiated auto-reconnect for ${reconnectedCount} profile(s)`);
      } else {
        this.logger.log('No profiles with valid sessions found for auto-reconnect');
      }
      
    } catch (error: any) {
      this.logger.warn(`Could not check sessions directory: ${error.message}`);
    }
  }

  /**
   * Clean up stale Chromium lock files that persist after a container
   * restart or unclean disconnect.
   *
   * Without this, Puppeteer refuses to launch:
   *   "The profile appears to be in use by another Chromium process"
   *
   * We use `find -delete` (reliable for deeply nested dirs) to remove
   * only the lock files, preserving the existing Chrome user-data
   * profile so that the page/frame state is stable and send operations
   * don't hit "detached Frame" errors.
   */
  private async cleanupStaleLockFiles(sessionDir: string): Promise<void> {
    const { execSync } = await import('child_process');

    const wwebjsAuthDir = path.join(sessionDir, '.wwebjs_auth');

    // Only act if the directory exists
    try {
      const fs = await import('fs/promises');
      await fs.access(wwebjsAuthDir);
    } catch {
      return;
    }

    // Use find to delete lock files reliably in all nested directories.
    // This is more robust than the earlier recursive readdir approach
    // because find handles deeply nested paths correctly.
    execSync(
      `find "${wwebjsAuthDir}" \\( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' -o -name 'LOCK' \\) -delete 2>/dev/null || true`,
    );

    this.logger.debug(`Cleaned stale lock files under ${wwebjsAuthDir}`);
  }

  async onModuleDestroy() {
    // Cleanup all engines on shutdown
    for (const [profileId, instance] of this.engines) {
      try {
        await instance.engine.destroy?.();
        this.logger.log(`Engine destroyed for profile ${profileId}`);
      } catch (error) {
        this.logger.error(`Error destroying engine for ${profileId}:`, error);
      }
    }
    this.engines.clear();
  }

  /**
   * Initialize and connect a WhatsApp engine for a profile
   */
  async connectProfile(profileId: string): Promise<{ status: string; message: string }> {
    this.logger.log(`Connecting profile: ${profileId}`);

    // Check if already connected
    const existing = this.engines.get(profileId);
    if (existing && existing.status === 'connected') {
      return { status: 'already_connected', message: 'Profile already connected' };
    }

    // Destroy any existing engine instance (e.g. from a failed previous attempt)
    if (existing) {
      this.logger.log(`Destroying stale engine instance for ${profileId}`);
      try {
        await existing.engine.destroy?.();
      } catch (e) {
        this.logger.warn(`Error destroying stale engine: ${(e as Error).message}`);
      }
      this.engines.delete(profileId);
    }

    // Get profile from database
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
    });

    if (!profile) {
      throw new Error('Profile not found');
    }

    // Update status to connecting
    await prisma.profile.update({
      where: { id: profileId },
      data: { status: 'connecting' },
    });

    // Create engine config with callbacks
    const sessionsBase = process.env.SESSIONS_DIR || './sessions';
    const sessionDir = path.join(sessionsBase, profileId);

    const engineType = resolveProfileEngineType(profile.settings);

    // Chromium locks apply only to whatsapp-web.js. Baileys stores its
    // multi-file credentials directly in the profile session directory.
    if (engineType === 'whatsapp-web-js') {
      await this.cleanupStaleLockFiles(sessionDir);
    }
    
    const engineConfig: EngineConfig = {
      profileId,
      sessionDir,
      onQR: async (qr: string) => {
        this.logger.log(`QR code received for profile ${profileId}`);
        
        try {
          // Convert QR string to data URL for frontend <img> display
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
          });
          
          // Emit QR data URL to WebSocket clients
          this.eventsGateway.emitQrUpdate(profileId, qrDataUrl);
          this.logger.log(`QR code emitted via WebSocket for profile ${profileId}`);
        } catch (error) {
          this.logger.error(`Error generating QR data URL:`, error);
          // Fallback: send raw QR string
          this.eventsGateway.emitQrUpdate(profileId, qr);
        }
      },
      onReady: async (phone: string, pushName: string) => {
        this.logger.log(`Profile ${profileId} connected: ${phone} (${pushName})`);
        
        // Update engine instance status
        const instance = this.engines.get(profileId);
        if (instance) {
          instance.status = 'connected';
        }

        // Update database
        await prisma.profile.update({
          where: { id: profileId },
          data: {
            status: 'connected',
            phoneNumber: phone,
            lastConnectedAt: new Date(),
          },
        });

        // Emit connection status via WebSocket
        this.eventsGateway.emitConnectionStatus(profileId, 'connected', phone);

        // === Notification: profile connected ===
        this.notifyOrgUsers(profileId, NotificationType.CONNECTION,
          '✅ Profile Connected',
          `${profile.displayName || phone} is now connected`,
          { profileId, phone },
        ).catch(err => this.logger.warn(`Notification error (connection): ${err.message}`));
      },
      onDisconnected: async (reason: string) => {
        this.logger.log(`Profile ${profileId} disconnected: ${reason}`);
        
        // Update engine instance status
        const instance = this.engines.get(profileId);
        if (instance) {
          instance.status = 'disconnected';
        }

        // Only clear session folder for actual session invalidation (logged out, expired)
        // Do NOT clear for temporary errors like 'Stream Errored' or 'Connection Failure'
        // as these may recover on reconnect
        const sessionInvalidReasons = ['Session Expired', 'Logged Out', 'loggedOut'];
        const isSessionInvalid = sessionInvalidReasons.some(r => reason.includes(r));
        
        if (isSessionInvalid) {
          this.logger.warn(`Session invalidated for ${profileId}, clearing session folder for fresh QR`);
          try {
            const fs = await import('fs/promises');
            await fs.rm(sessionDir, { recursive: true, force: true });
            this.logger.log(`Session folder cleared for ${profileId}`);
          } catch (err) {
            this.logger.error(`Failed to clear session folder:`, err);
          }
          
          // Update database
          await prisma.profile.update({
            where: { id: profileId },
            data: { status: 'disconnected' },
          });
          this.eventsGateway.emitConnectionStatus(profileId, 'disconnected');

          // === Notification: session invalidated ===
          this.notifyOrgUsers(profileId, NotificationType.DISCONNECTION,
            '⚠️ Profile Disconnected',
            `${profile.displayName || profileId} was disconnected: ${reason}`,
            { profileId, reason },
          ).catch(err => this.logger.warn(`Notification error (disconnection): ${err.message}`));
        } else {

          // Temporary disconnect — attempt auto-retry with exponential backoff
          const maxRetries = 3;
          const baseDelay = 5000; // 5 seconds
          
          // Clean up the failed engine instance first
          try {
            await instance?.engine?.destroy?.();
          } catch (e) {
            this.logger.warn(`Error destroying engine before retry: ${(e as Error).message}`);
          }
          this.engines.delete(profileId);

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const delay = baseDelay * Math.pow(3, attempt - 1); // 5s, 15s, 45s
            this.logger.log(`Auto-retry ${attempt}/${maxRetries} for ${profileId} in ${delay / 1000}s (reason: ${reason})`);
            
            // Emit reconnecting status so frontend shows progress
            await prisma.profile.update({
              where: { id: profileId },
              data: { status: 'connecting' },
            });
            this.eventsGateway.emitConnectionStatus(profileId, `reconnecting (${attempt}/${maxRetries})`);
            
            await new Promise(resolve => setTimeout(resolve, delay));
            
            try {
              const result = await this.connectProfile(profileId);
              if (result.status === 'connecting' || result.status === 'already_connected') {
                this.logger.log(`Auto-retry successful for ${profileId} on attempt ${attempt}`);
                return; // Success, exit the retry loop
              }
            } catch (retryErr: any) {
              this.logger.warn(`Auto-retry attempt ${attempt}/${maxRetries} failed for ${profileId}: ${retryErr.message}`);
            }
          }
          
          // All retries exhausted
          this.logger.error(`All ${maxRetries} auto-retry attempts failed for ${profileId}`);
          await prisma.profile.update({
            where: { id: profileId },
            data: { status: 'disconnected' },
          });
          this.eventsGateway.emitConnectionStatus(profileId, 'disconnected');
        }
      },
      onMessage: async (message: any) => {
        // Skip bot's own messages to prevent reply loops
        if (message.fromMe) {
          this.logger.debug(`Skipping own message for profile ${profileId}`);
          return;
        }
        // WhatsApp protocol/status events can contain a body but are not
        // customer messages. Drop them before creating conversations,
        // persisting messages, running automations, firing hooks, or calling AI.
        if (
          isProtocolStatusMessageType(message.type)
          || isStatusBroadcastJid(message.from)
        ) {
          this.logger.debug(
            `Skipping non-customer status event type=${message.type} from=${message.from} for profile ${profileId}`,
          );
          return;
        }
        this.logger.debug(
          `Incoming message metadata profile=${profileId} from=${message.from} type=${message.type} hasBody=${Boolean(message.body)} hasMedia=${Boolean(message.hasMedia)}`,
        );
        const providerMessageId = message.id?._serialized || message.id || '';
        const processingKey = providerMessageId ? `${profileId}:${providerMessageId}` : '';
        if (processingKey && this.processingInboundMessageKeys.has(processingKey)) {
          this.logger.debug(`Skipping concurrent duplicate WhatsApp message ${providerMessageId}`);
          return;
        }
        if (processingKey) this.processingInboundMessageKeys.add(processingKey);
        try {
          if (providerMessageId) {
            const existingMessage = await prisma.message.findFirst({
              where: { profileId, messageId: providerMessageId },
              select: { id: true },
            });
            if (existingMessage) {
              this.logger.debug(`Skipping duplicate WhatsApp message ${providerMessageId}`);
              return;
            }
          }
          // Determine message type and content
          const msgType = message.type || 'chat';
          const senderIdentity = resolveSenderIdentity(message);
          const { senderJid, senderPhone, originalSenderJid, isGroup } = senderIdentity;
          const senderName = message._data?.notifyName || message.pushName || senderPhone || senderJid.split('@')[0];
          const groupName = isGroup ? (message.groupName || message._data?.chatName || message._data?.name) : undefined;
          
          // Get or create conversation. Groups stay keyed by chat JID; 1:1
          // chats use a real phone-number JID when available so @lid provider
          // aliases do not appear as separate fake-number chats.
          const rawJid = (isGroup ? (message.chatJid || message.from) : message.from) || '';
          const jid = isGroup
            ? rawJid
            : (senderPhone ? `${senderPhone}@s.whatsapp.net` : rawJid.replace('@c.us', '@s.whatsapp.net'));
          let conversation = await prisma.conversation.findFirst({
            where: { profileId, jid },
          });
          if (!conversation) {
            conversation = await prisma.conversation.create({
              data: {
                profileId,
                jid,
                name: (isGroup ? groupName : senderName) || jid,
                type: isGroup ? 'group' : 'user',
              },
            });
          } else if (isGroup && ((groupName && conversation.name !== groupName) || conversation.type !== 'group')) {
            conversation = await prisma.conversation.update({
              where: { id: conversation.id },
              data: {
                ...(groupName ? { name: groupName } : {}),
                type: 'group',
              },
            });
          }

          // Build content object
          const content: any = {};
          if (message.body) content.text = message.body;

          // Debug logging for special message types
          if (['location', 'poll', 'poll_creation', 'event', 'event_creation'].includes(msgType)) {
            this.logger.debug(
              `Special message metadata type=${msgType} keys=${Object.keys(message).join(',')} dataKeys=${message._data ? Object.keys(message._data).join(',') : 'none'}`,
            );
          }

          if (message.hasMedia) {
            try {
              const media = await message.downloadMedia?.();
              if (media) {
                content.mimetype = media.mimetype;
                content.filename = media.filename;
                content.hasMedia = true;
                // Store base64 data as data URL for frontend rendering
                if (media.data) {
                  content.url = `data:${media.mimetype};base64,${media.data}`;
                }
              }
            } catch (e) {
              this.logger.warn(`Failed to download media: ${(e as Error).message}`);
              content.hasMedia = true;
            }
            // For media messages, also store body as caption for frontend display
            if (message.body) {
              content.caption = message.body;
            }
          }

          // Extract location data - try multiple property paths
          if (message.location && message.location.latitude) {
            content.latitude = message.location.latitude;
            content.longitude = message.location.longitude;
            content.description = message.location.description || '';
            content.name = message.location.description || 'Location';
          } else if (message._data) {
            // Fallback: try _data.lat/_data.lng
            const lat = message._data.lat || message._data.latitude;
            const lng = message._data.lng || message._data.longitude;
            if (lat && lng) {
              content.latitude = lat;
              content.longitude = lng;
              content.description = message._data.loc || message._data.description || '';
              content.name = message._data.loc || message._data.description || 'Location';
              this.logger.debug('Location metadata extracted from provider data');
            }
          }

          // Extract poll data - try multiple property paths
          if (msgType === 'poll_creation' || msgType === 'poll') {
            const pollName = message.pollName || message._data?.pollName || message.body;
            const pollOptions = message.pollOptions || message._data?.pollOptions;
            const allowMultipleAnswers = message.allowMultipleAnswers ?? message._data?.allowMultipleAnswers;
            if (pollName) content.question = pollName;
            if (pollName) content.pollName = pollName;
            if (pollOptions) {
              content.options = pollOptions.map?.((o: any) => typeof o === 'string' ? o : o?.name || o?.optionName || JSON.stringify(o)) || pollOptions;
              content.pollOptions = content.options;
            }
            if (allowMultipleAnswers !== undefined) content.allowMultipleAnswers = allowMultipleAnswers;
            this.logger.debug(
              `Poll metadata extracted hasName=${Boolean(pollName)} optionCount=${Array.isArray(content.options) ? content.options.length : 0}`,
            );
          }

          // Extract event data
          if (msgType === 'event_creation' || msgType === 'event') {
            const eventName = message.eventName || message._data?.eventName || message.body;
            const eventDesc = message.eventDescription || message._data?.eventDescription || message._data?.description;
            const eventStart = message.eventStartTime || message._data?.eventStartTime;
            const eventEnd = message.eventEndTime || message._data?.eventEndTime;
            const eventLoc = message.eventLocation || message._data?.eventLocation;
            if (eventName) content.eventName = eventName;
            if (eventDesc) content.eventDescription = eventDesc;
            if (eventStart) content.eventStartTime = eventStart;
            if (eventEnd) content.eventEndTime = eventEnd;
            if (eventLoc) content.eventLocation = eventLoc;
            this.logger.debug(
              `Event metadata extracted hasName=${Boolean(eventName)} hasStart=${Boolean(eventStart)} hasLocation=${Boolean(eventLoc)}`,
            );
          }

          // Extract vCard/contact data
          if (message.vCards && message.vCards.length > 0) {
            content.vcard = message.vCards[0];
            // Parse vCard to extract displayName and phone
            try {
              const vcard = message.vCards[0];
              const fnMatch = vcard.match(/FN:(.*)/i);
              const telMatch = vcard.match(/TEL[^:]*:([\d+\-\s]+)/i);
              if (fnMatch) content.displayName = fnMatch[1].trim();
              if (telMatch) content.phone = telMatch[1].trim();
              // Store all vCards if multiple contacts
              if (message.vCards.length > 1) {
                content.vcards = message.vCards;
              }
            } catch (e) {
              this.logger.warn(`Failed to parse vCard: ${(e as Error).message}`);
            }
          }

          const messageTimestamp = (() => {
            if (!message.timestamp) return new Date();
            // whatsapp-web.js timestamp can be in seconds or milliseconds
            const ts = Number(message.timestamp);
            const msTs = ts > 10000000000 ? ts : ts * 1000;
            const date = new Date(msTs);
            if (isNaN(date.getTime()) || date.getFullYear() > 2100 || date.getFullYear() < 2000) {
              return new Date();
            }
            return date;
          })();

          // Save message to database
          const savedMessage = await prisma.message.create({
            data: {
              profileId,
              conversationId: conversation.id,
              messageId: providerMessageId || `in_${Date.now()}`,
              direction: 'incoming',
              senderJid,
              type: msgType === 'chat' ? 'text' : msgType,
              content,
              status: 'received',
              metadata: {
                senderName,
                senderPhone,
                originalSenderJid,
                historical: Boolean(message.isHistorical),
              },
              timestamp: messageTimestamp,
            },
          });

          // Update conversation
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              ...(conversation.lastMessageAt && conversation.lastMessageAt > messageTimestamp
                ? {}
                : { lastMessageAt: messageTimestamp }),
              ...(message.isHistorical ? {} : { unreadCount: { increment: 1 } }),
            },
          });

          // History and append replays are persistence-only. Never emit hooks,
          // notifications, automations, AI replies, or unread increments.
          if (message.isHistorical) return;

          // Emit via WebSocket for real-time chat
          this.eventsGateway.emitMessage(profileId, {
            type: 'message:received',
            message: savedMessage,
            conversation,
          });

          // Emit external webhook hook for CRM integrations such as wacrm.
          // HooksService signs the exact JSON body with the registered hook
          // secret and delivers only to subscribers of message.received.
          this.hooksService.emit(AppEvent.MESSAGE_RECEIVED, {
            profileId,
            messageId: savedMessage.messageId,
            senderJid,
            senderPhone,
            originalSenderJid,
            senderName,
            type: savedMessage.type,
            content,
            timestamp: savedMessage.timestamp,
            isGroup,
            conversationId: conversation.id,
            // Preserve chat/thread identity separately from the sender identity.
            // For groups this is the @g.us JID; CRM consumers must key the
            // conversation by this value, not by the latest participant.
            chatJid: jid,
            groupName,
          });

          // === Notification: new message ===
          const msgPreview = (content.text || content.caption || msgType).substring(0, 80);
          this.notifyOrgUsers(profileId, NotificationType.MESSAGE,
            `📨 New message from ${senderName}`,
            msgPreview,
            { profileId, conversationId: conversation.id, messageId: savedMessage.id, senderJid },
          ).catch(err => this.logger.warn(`Notification error (message): ${err.message}`));

          // Check if this is a new contact. Only persist real phone-number
          // identities; never derive a contact phone from @lid provider IDs.
          const phone = senderPhone;
          const existingContact = phone
            ? await prisma.contact.findFirst({
                where: { profileId, phone },
              })
            : null;
          const isNewContact = !existingContact;
          
          // Auto-create contact if new
          if (isNewContact && phone && !isGroup) {
            await prisma.contact.create({
              data: {
                profileId,
                phone,
                name: senderName || phone,
                tags: [],
              },
            }).catch(() => {}); // Ignore duplicate errors
          }

          // === AUTOMATION: Process through Rule Engine ===
          const incomingMsg: IncomingMessage = {
            profileId,
            conversationId: conversation.id,
            senderJid,
            senderName,
            messageType: msgType === 'chat' ? 'text' : msgType,
            content,
            timestamp: new Date(),
            isGroup,
            isNewContact,
          };

          // Check daily message limit before processing automations
          const currentProfile = await prisma.profile.findUnique({ where: { id: profileId } });
          if (currentProfile && currentProfile.dailyMessageLimit > 0 && currentProfile.dailyMessageCount >= currentProfile.dailyMessageLimit) {
            this.logger.warn(`Daily message limit reached for profile ${profileId}: ${currentProfile.dailyMessageCount}/${currentProfile.dailyMessageLimit}, skipping automation`);
          } else {
            const results = await this.ruleEngineService.processMessage(incomingMsg);
          
            // Log and handle automation action results
            for (const result of results) {
              if (result.success) {
                this.logger.debug(
                  `Automation action succeeded action=${result.action} sender=${senderJid} hasResponse=${Boolean(result.data?.message)}`,
                );
                
                // Increment daily message count for actions that send messages
                const sendingActions = ['reply', 'send_image', 'send_document', 'send_poll', 'send_audio', 'send_video', 'send_location', 'send_contact'];
                if (sendingActions.includes(result.action)) {
                  try {
                    await prisma.profile.update({
                      where: { id: profileId },
                      data: { 
                        dailyMessageCount: { increment: 1 },
                        ...(currentProfile && currentProfile.dailyResetAt && new Date() > currentProfile.dailyResetAt ? {
                          dailyResetAt: new Date(new Date().setHours(24, 0, 0, 0)),
                          dailyMessageCount: 1,
                        } : {}),
                      },
                    });
                  } catch (e) {
                    this.logger.warn(`Failed to update daily message count: ${(e as Error).message}`);
                  }
                }
              } else {
                this.logger.error(`❌ Action "${result.action}" failed for ${senderJid}: ${result.error || 'Unknown error'}`);
              }
            }
            
            if (results.length > 0) {
              this.logger.log(`Automation processed ${results.length} action(s) for message from ${senderJid}`);
            }
          }

          // === FASTBOTS AI INTEGRATION ===
          // If FastBots is enabled for this profile, process the message
          // through the AI chatbot and send the reply.
          if (!isGroup && shouldRouteTextToFastBots(msgType, content?.text)) {
            this.fastBotsService.handleIncomingMessage(
              profileId,
              jid,
              content.text,
            ).catch(err => {
              this.logger.warn(`FastBots integration error: ${err.message}`);
            });
          } else if (!isGroup && content?.text) {
            this.logger.debug(
              `Skipping empty text for FastBots on profile ${profileId}`,
            );
          }
        } catch (error) {
          this.logger.error(`Error processing incoming message:`, error);
        } finally {
          if (processingKey) this.processingInboundMessageKeys.delete(processingKey);
        }
      },
      onMessageEdit: async event => {
        if (!event.messageId || (event.type === 'unknown' && !event.body)) return;
        try {
          const messages = await prisma.message.findMany({
            where: { profileId, messageId: event.messageId },
          });
          this.logger.debug(
            `Applying message edit profile=${profileId} target=${event.messageId} matches=${messages.length} type=${event.type} bodyLength=${event.body.length}`,
          );
          for (const message of messages) {
            const content = jsonObject(message.content);
            if (['image', 'video', 'document'].includes(message.type)) content.caption = event.body;
            content.text = event.body;
            const metadata = jsonObject(message.metadata);
            metadata.isEdited = true;
            metadata.editedAt = (event.editedAt || new Date()).toISOString();
            const updated = await prisma.message.update({
              where: { id: message.id },
              data: {
                type: event.type === 'unknown' ? message.type : event.type,
                content,
                metadata,
              },
            });
            this.eventsGateway.emitMessageUpdate(profileId, updated);
          }
        } catch (error) {
          this.logger.warn(`Failed to apply message edit: ${(error as Error).message}`);
        }
      },
      onMessageDelete: async event => {
        try {
          let messages = [] as Awaited<ReturnType<typeof prisma.message.findMany>>;
          if ('messageIds' in event) {
            if (!event.messageIds.length) return;
            messages = await prisma.message.findMany({
              where: { profileId, messageId: { in: event.messageIds } },
            });
          } else {
            const conversation = await prisma.conversation.findFirst({
              where: { profileId, jid: event.jid },
              select: { id: true },
            });
            if (!conversation) return;
            messages = await prisma.message.findMany({
              where: { profileId, conversationId: conversation.id },
              take: 5000,
            });
          }
          for (const message of messages) {
            const metadata = jsonObject(message.metadata);
            metadata.isDeleted = true;
            metadata.deletedAt = event.deletedAt.toISOString();
            const updated = await prisma.message.update({
              where: { id: message.id },
              data: {
                type: 'text',
                content: { text: 'This message was deleted', deleted: true },
                metadata,
              },
            });
            this.eventsGateway.emitMessageUpdate(profileId, updated);
          }
        } catch (error) {
          this.logger.warn(`Failed to apply message deletion: ${(error as Error).message}`);
        }
      },
      onMessageReaction: async event => {
        if (!event.messageId || !event.reactionId) return;
        try {
          const target = await prisma.message.findFirst({
            where: { profileId, messageId: event.messageId },
          });
          if (!target) return;
          const existing = await prisma.message.findFirst({
            where: { profileId, messageId: event.reactionId },
          });
          if (!event.emoji) {
            if (existing) await prisma.message.delete({ where: { id: existing.id } });
            return;
          }
          const data = {
            profileId,
            conversationId: target.conversationId,
            messageId: event.reactionId,
            direction: event.fromMe ? 'outgoing' : 'incoming',
            senderJid: event.senderJid,
            type: 'reaction',
            content: { messageId: event.messageId, emoji: event.emoji },
            status: 'received',
            timestamp: event.timestamp || new Date(),
            metadata: { reaction: true },
          };
          const saved = existing
            ? await prisma.message.update({ where: { id: existing.id }, data })
            : await prisma.message.create({ data });
          this.eventsGateway.emitMessage(profileId, { type: 'message:received', message: saved });
        } catch (error) {
          this.logger.warn(`Failed to apply message reaction: ${(error as Error).message}`);
        }
      },
      onPhoneNumberShare: async event => {
        try {
          await prisma.message.updateMany({
            where: { profileId, senderJid: event.lid },
            data: { senderJid: event.jid },
          });
          const conversations = await prisma.conversation.findMany({
            where: { profileId, jid: event.lid },
          });
          let phoneConversation = await prisma.conversation.findFirst({
            where: { profileId, jid: event.jid },
          });
          for (const conversation of conversations) {
            if (phoneConversation && phoneConversation.id !== conversation.id) {
              await prisma.message.updateMany({
                where: { profileId, conversationId: conversation.id },
                data: { conversationId: phoneConversation.id },
              });
              phoneConversation = await prisma.conversation.update({
                where: { id: phoneConversation.id },
                data: {
                  unreadCount: { increment: conversation.unreadCount },
                  lastMessageAt: !phoneConversation.lastMessageAt
                    || (conversation.lastMessageAt && conversation.lastMessageAt > phoneConversation.lastMessageAt)
                    ? conversation.lastMessageAt
                    : phoneConversation.lastMessageAt,
                  metadata: { ...jsonObject(phoneConversation.metadata), phoneNumberJid: event.jid },
                },
              });
              await prisma.conversation.delete({ where: { id: conversation.id } });
            } else {
              phoneConversation = await prisma.conversation.update({
                where: { id: conversation.id },
                data: {
                  jid: event.jid,
                  metadata: { ...jsonObject(conversation.metadata), phoneNumberJid: event.jid },
                },
              });
            }
          }
        } catch (error) {
          this.logger.warn(`Failed to apply phone-number share: ${(error as Error).message}`);
        }
      },
      onMessageReceipt: async event => {
        try {
          const messages = await prisma.message.findMany({
            where: { profileId, messageId: event.messageId },
          });
          for (const message of messages) {
            const metadata = jsonObject(message.metadata);
            const receipts = jsonObject(metadata.receipts);
            receipts[event.participantJid] = {
              deliveredAt: event.deliveredAt?.toISOString(),
              readAt: event.readAt?.toISOString(),
              playedAt: event.playedAt?.toISOString(),
            };
            metadata.receipts = receipts;
            await prisma.message.update({ where: { id: message.id }, data: { metadata } });
          }
        } catch (error) {
          this.logger.warn(`Failed to apply message receipt: ${(error as Error).message}`);
        }
      },
      onMediaUpdate: async event => {
        try {
          const messages = await prisma.message.findMany({
            where: { profileId, messageId: event.messageId },
          });
          for (const message of messages) {
            const metadata = jsonObject(message.metadata);
            metadata.mediaUpdate = {
              available: event.available,
              updatedAt: new Date().toISOString(),
              ...(event.error ? { error: event.error.slice(0, 200) } : {}),
            };
            await prisma.message.update({ where: { id: message.id }, data: { metadata } });
          }
        } catch (error) {
          this.logger.warn(`Failed to apply media update: ${(error as Error).message}`);
        }
      },
      onMessageAck: async (messageId: string, status: string) => {
        this.logger.log(`[ACK] Message ${messageId} → status: ${status}`);
        try {
          // The engine adapter already maps numeric ack to string status
          // (pending, sent, delivered, read, played)
          // No need for double-mapping
          
          const updated = await prisma.message.updateMany({
            where: { messageId },
            data: { status },
          });

          this.logger.log(`[ACK] Updated ${updated.count} message(s) for ${messageId} → ${status}`);

          // Emit WebSocket event for real-time UI updates
          this.eventsGateway.emitMessageAck(profileId, messageId, status);
        } catch (error) {
          this.logger.warn(`Failed to update message ack: ${(error as Error).message}`);
        }
      },
      onPresenceUpdate: async presence => {
        try {
          const alternateJid = presence.chatJid.endsWith('@s.whatsapp.net')
            ? presence.chatJid.replace('@s.whatsapp.net', '@c.us')
            : presence.chatJid.endsWith('@c.us')
              ? presence.chatJid.replace('@c.us', '@s.whatsapp.net')
              : presence.chatJid;
          const conversation = await prisma.conversation.findFirst({
            where: {
              profileId,
              jid: { in: Array.from(new Set([presence.chatJid, alternateJid])) },
            },
            select: { id: true },
          });
          if (!conversation) return;
          this.eventsGateway.emitPresence(profileId, {
            ...presence,
            profileId,
            conversationId: conversation.id,
          });
        } catch (error) {
          this.logger.warn(`Failed to route presence for profile ${profileId}: ${(error as Error).message}`);
        }
      },
    };

    const engine = EngineFactory.create(engineType);
    this.logger.log(`Using ${engineType} engine for profile ${profileId}`);
    
    try {
      await engine.initialize(engineConfig);
      
      // Store engine instance
      this.engines.set(profileId, {
        engine,
        profileId,
        status: 'connecting',
      });

      // Start connection (async, QR will come via callback)
      // Wrap in a timeout so the frontend spinner doesn't hang indefinitely.
      // Unlike Promise.race — which orphans the engine when the timeout wins —
      // we let connect() finish in the background so onReady/disconnected
      // callbacks fire normally. If it times out, the caller gets a fast
      // response but the engine stays alive for the full connect attempt.
      const connectTimeout = 60000; // 60 seconds max for connection

      const connectWithTimeout = engine.connect().then(
        () => this.logger.log(`Engine connect completed for ${profileId}`),
        async (error) => {
          this.logger.error(`Engine connect failed for ${profileId}:`, error);

          try {
            await engine.destroy?.();
          } catch (e) {
            this.logger.warn(`Error destroying failed engine: ${(e as Error).message}`);
          }
          this.engines.delete(profileId);

          try {
            const { execSync } = await import('child_process');
            execSync('pkill -f chromium 2>/dev/null || true');
            execSync('pkill -f chrome_crashpad 2>/dev/null || true');
          } catch {}

          try {
            await prisma.profile.update({
              where: { id: profileId },
              data: { status: 'disconnected' },
            });
          } catch (dbErr) {
            this.logger.error(`Failed to reset profile status:`, dbErr);
          }

          this.eventsGateway.emitConnectionStatus(profileId, 'error');
        },
      );

      const timeoutId = setTimeout(() => {
        this.logger.warn(`Engine connect timed out after 60s for ${profileId}, but engine is still connecting in background`);
        this.eventsGateway.emitConnectionStatus(profileId, 'connecting');
      }, connectTimeout);

      connectWithTimeout.finally(() => clearTimeout(timeoutId));

      return { status: 'connecting', message: 'Scan QR code to connect' };
    } catch (error: any) {
      this.logger.error(`Failed to initialize engine for ${profileId}:`, error);
      
      await prisma.profile.update({
        where: { id: profileId },
        data: { status: 'disconnected' },
      });

      throw error;
    }
  }

  /**
   * Disconnect a profile's WhatsApp engine
   */
  async disconnectProfile(profileId: string): Promise<{ status: string }> {
    this.logger.log(`Disconnecting profile: ${profileId}`);

    const instance = this.engines.get(profileId);
    
    if (instance) {
      try {
        await instance.engine.destroy?.();
      } catch (error) {
        this.logger.error(`Error destroying engine:`, error);
      }
      this.engines.delete(profileId);
    }

    // Update database
    await prisma.profile.update({
      where: { id: profileId },
      data: { 
        status: 'disconnected',
        sessionData: null,
      },
    });

    // Emit disconnection via WebSocket
    this.eventsGateway.emitConnectionStatus(profileId, 'disconnected');

    return { status: 'disconnected' };
  }

  /**
   * Get engine instance for a profile
   */
  getEngine(profileId: string): IWhatsAppEngine | null {
    return this.engines.get(profileId)?.engine || null;
  }

  /**
   * Get status of a profile's engine
   */
  getEngineStatus(profileId: string): { isConnected: boolean; status: string } {
    const instance = this.engines.get(profileId);
    
    if (!instance) {
      return { isConnected: false, status: 'no_engine' };
    }

    const engineStatus = instance.engine.getStatus();
    return {
      isConnected: engineStatus.isConnected,
      status: instance.status,
    };
  }

  /**
   * Check if a profile has an active engine
   */
  hasEngine(profileId: string): boolean {
    return this.engines.has(profileId);
  }

  /**
   * Helper: find profile's org and create notifications for all org users
   */
  private async notifyOrgUsers(
    profileId: string,
    type: NotificationType,
    title: string,
    body: string,
    metadata?: Record<string, any>,
  ) {
    const profile = await prisma.profile.findUnique({
      where: { id: profileId },
      select: { workspace: { select: { organizationId: true } } },
    });

    const orgId = profile?.workspace?.organizationId;
    if (!orgId) {
      this.logger.warn(`Cannot send notification: profile ${profileId} has no organization`);
      return;
    }

    return this.notificationsService.createForOrg(orgId, type, title, body, metadata);
  }
}
