// MultiWA Gateway API - Engine Manager Service
// apps/api/src/modules/profiles/engine-manager.service.ts
//
// This service manages WhatsApp engine instances and wires them to EventsGateway

import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { EventsGateway } from '../events/events.gateway';
import { prisma } from '@multiwa/database';
import { EngineFactory, hasRetainedBaileysIdentity } from '@multiwa/engines';
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
import { connectionAlertCode, recordConnectionAlert, ConnectionAlertCode } from './connection-alert';
import { applyMessageAck } from '../messages/ack-status';
import { boundedRecoveryProfileIds, requiresManualReconnect, usesBoundedRecovery } from './reconnect-policy';
import { FileRecoveryJournal, RecoveryPause } from './transport-recovery-journal';
import { RecoveryAttempt, TransportRecovery } from './transport-recovery';


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
export class EngineManagerService implements OnModuleDestroy, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EngineManagerService.name);
  private connectionCycles = new Map<string, { generation: number; retries: number; paused: boolean;
    qrIssued?: boolean; pairingRestartUsed?: boolean; pairingRestartPending?: boolean }>();
  private engines = new Map<string, EngineInstance>();
  private recoveryControllers = new Map<string, TransportRecovery>();
  private shuttingDown = false;
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

  private recoveryAlert(reason: RecoveryPause | null): ConnectionAlertCode | null {
    if (!reason) return null;
    const known = ['MANUAL_PAUSE', 'RETRIES_EXHAUSTED', 'FORBIDDEN', 'LOGGED_OUT',
      'CONNECTION_REPLACED', 'BAD_SESSION', 'AUTH_STORAGE_UNAVAILABLE',
      'MULTIDEVICE_MISMATCH', 'REACHOUT_TIMELOCK', 'FREQUENT_DISCONNECTS'];
    return known.includes(reason) ? reason as ConnectionAlertCode : 'RECOVERY_BLOCKED';
  }

  private recoveryFor(profileId: string): TransportRecovery {
    let recovery = this.recoveryControllers.get(profileId);
    if (recovery) return recovery;
    recovery = new TransportRecovery(new FileRecoveryJournal(
      process.env.SESSIONS_DIR || './sessions', profileId), {
      hasRetainedIdentity: async () => {
        const profile = await prisma.profile.findUnique({ where: { id: profileId },
          select: { sessionData: true, settings: true } });
        if (!profile || resolveProfileEngineType(profile.settings) !== 'baileys') return false;
        return hasRetainedBaileysIdentity(profile.sessionData);
      },
      connect: async attempt => { await this.connectProfile(profileId, undefined, attempt); },
      stop: async () => {
        const cycle = this.connectionCycles.get(profileId);
        if (cycle) cycle.paused = true;
        const instance = this.engines.get(profileId);
        this.engines.delete(profileId);
        try { await instance?.engine.destroy?.(); }
        finally { this.eventsGateway.emitConnectionStatus(profileId, 'disconnected'); }
      },
      disconnected: async reason => {
        this.logger.log(JSON.stringify({ event: 'transport_recovery_state', profileId, pauseReason: reason }));
        await recordConnectionAlert(profileId, this.recoveryAlert(reason));
        await prisma.profile.update({ where: { id: profileId }, data: { status: reason ? 'disconnected' : 'connecting' } });
        this.eventsGateway.emitConnectionStatus(profileId, reason ? 'disconnected' : 'connecting');
        if (reason === 'RETRIES_EXHAUSTED' || reason === 'FREQUENT_DISCONNECTS') {
          await this.notifyOrgUsers(profileId, NotificationType.DISCONNECTION,
            'WhatsApp automatic recovery paused',
            reason === 'RETRIES_EXHAUSTED' ? 'Three transport recovery attempts were exhausted. Operator review is required.'
              : 'Four transport disconnects occurred within one hour. Operator review is required.',
            { profileId, reason }).catch(() => this.logger.warn('Recovery notification unavailable'));
        }
      },
      isReady: () => this.engines.get(profileId)?.engine.isReady() === true,
    });
    this.recoveryControllers.set(profileId, recovery);
    return recovery;
  }

  async getTransportRecovery(profileId: string) {
    if (!usesBoundedRecovery(profileId)) return null;
    const recovery = this.recoveryFor(profileId);
    const markers = await recovery.publicStatus();
    const policy = await recovery.policyStatus();
    return { markers, phase: policy.phase,
      alert: policy.phase === 'paused' && policy.lastDisconnectedAt ? {
        code: this.recoveryAlert(policy.pauseReason), occurredAt: policy.lastDisconnectedAt,
        active: policy.pauseReason !== 'MANUAL_PAUSE',
      } : null };
  }

  /**
   * On module init:
   * 1. Reset stale 'connected' or 'connecting' profiles to 'disconnected'
   * 2. Auto-reconnect profiles that have valid session data
   */
  async onModuleInit() {
    this.logger.log('EngineManagerService initializing...');
    
    try {
      // Step 1: Reset profiles whose persisted state says an engine was active.
      // At process start no engines exist, including profiles left in 'connecting'
      // by an unclean shutdown or a connection attempt that never completed.
      const staleProfiles = await prisma.profile.findMany({
        where: { status: { in: ['connected', 'connecting'] } },
        select: { id: true, displayName: true },
      });

      if (staleProfiles.length > 0) {
        this.logger.warn(`Found ${staleProfiles.length} stale active profiles, resetting to 'disconnected'`);
        
        await prisma.profile.updateMany({
          where: { status: { in: ['connected', 'connecting'] } },
          data: { status: 'disconnected' },
        });

        staleProfiles.forEach(p => {
          this.logger.log(`Reset profile to disconnected: ${p.displayName || p.id}`);
        });
      }

      // Step 2: Reconnect only profiles that were connected before this API
      // process started. A session directory can remain after an intentional
      // disconnect and must not override the operator's selected state.
      await this.autoReconnectProfiles(staleProfiles.map(profile => profile.id)
        .filter(id => !requiresManualReconnect(id) && !usesBoundedRecovery(id)));
      for (const profileId of boundedRecoveryProfileIds()) {
        try { await this.recoveryFor(profileId).startup(); }
        catch { await this.recoveryFor(profileId).storageStop(); }
      }
      
    } catch (error) {
      this.logger.error('Error in onModuleInit:', error);
      for (const profileId of boundedRecoveryProfileIds()) {
        await this.recoveryFor(profileId).storageStop();
      }
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
        select: { id: true, displayName: true, lastConnectedAt: true, sessionData: true },
      });

      let reconnectedCount = 0;
      
      for (const profile of profiles) {
        const sessionDir = path.join(sessionsDir, profile.id);
        
        // Check if the session directory exists at all.
        // We no longer check .wwebjs_auth/session-{profileId}/ specifically, because
        // cleanupStaleLockFiles() deletes the entire .wwebjs_auth dir.  The MultiDevice
        // auth state is re-established transparently by whatsapp-web-js when the engine
        // connects, so a simple directory existence check is sufficient.
        let hasSession = Boolean(profile.sessionData);
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
    this.shuttingDown = true;
    for (const recovery of this.recoveryControllers.values()) {
      try { await recovery.shutdown(); }
      catch { this.logger.warn('Recovery shutdown checkpoint unavailable; restart remains blocked'); }
    }
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

  async onApplicationShutdown() {
    for (const recovery of this.recoveryControllers.values()) {
      try { await recovery.completeShutdown(); }
      catch { this.logger.warn('Final recovery checkpoint unavailable'); }
    }
  }

  getCachedQrCode(profileId: string): string | undefined {
    return this.eventsGateway.getCachedQr(profileId);
  }

  /**
   * Initialize and connect a WhatsApp engine for a profile
   */
  async connectProfile(profileId: string, retryGeneration?: number,
    managedAttempt?: RecoveryAttempt): Promise<{ status: string; message: string }> {
    if (this.shuttingDown) return { status: 'disconnected', message: 'API is shutting down' };
    const recovery = usesBoundedRecovery(profileId) ? this.recoveryFor(profileId) : null;
    if (recovery && !managedAttempt) {
      if (retryGeneration !== undefined) return { status: 'disconnected', message: 'Use durable recovery scheduler' };
      try {
        const saved = await prisma.profile.findUnique({ where: { id: profileId }, select: { sessionData: true } });
        // Only an explicit connect after intentionally absent auth may initiate pairing.
        // Existing retained credentials never fall back to a QR, even on operator resume.
        await recovery.explicitConnect(Boolean(saved && !saved.sessionData));
      }
      catch { await recovery.storageStop(); throw new Error('Recovery storage unavailable'); }
      const policy = await recovery.policyStatus();
      return { status: policy.phase === 'paused' ? 'disconnected' : 'connecting',
        message: policy.phase === 'paused' ? 'Connection stopped for operator review' : 'Connection initiated' };
    }
    if (recovery && !recovery.isCurrent(managedAttempt!.token)) {
      return { status: 'disconnected', message: 'Recovery attempt cancelled' };
    }
    let cycle = this.connectionCycles.get(profileId);
    if (retryGeneration !== undefined && requiresManualReconnect(profileId) && !cycle?.pairingRestartPending) {
      return { status: 'disconnected', message: 'Automatic reconnect disabled for investigation' };
    }
    this.logger.log(`Connecting profile: ${profileId}`);

    if (retryGeneration !== undefined) {
      if (!cycle || cycle.paused || cycle.generation !== retryGeneration) {
        return { status: 'disconnected', message: 'Connection attempt cancelled' };
      }
      cycle = { ...cycle, pairingRestartPending: false };
      this.connectionCycles.set(profileId, cycle);
    } else {
      const active = this.engines.get(profileId);
      if (active?.status === 'connected') return { status: 'already_connected', message: 'Profile already connected' };
      if (active?.status === 'connecting') return { status: 'connecting', message: 'Connection already in progress' };
      cycle = { generation: (cycle?.generation || 0) + 1, retries: 0, paused: false };
      this.connectionCycles.set(profileId, cycle);
    }
    let disconnectHandled = false;
    const generation = cycle.generation;
    const current = () => this.connectionCycles.get(profileId) === cycle && !cycle.paused &&
      (!recovery || recovery.isCurrent(managedAttempt!.token));

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

    if (!current()) return { status: 'disconnected', message: 'Connection attempt cancelled' };

    // Update status to connecting
    await prisma.profile.update({
      where: { id: profileId },
      data: { status: 'connecting' },
    });

    if (!current()) {
      await prisma.profile.update({ where: { id: profileId }, data: { status: 'disconnected' } });
      return { status: 'disconnected', message: 'Connection attempt cancelled' };
    }

    // Create engine config with callbacks
    const sessionsBase = process.env.SESSIONS_DIR || './sessions';
    const sessionDir = path.join(sessionsBase, profileId);

    const engineType = resolveProfileEngineType(profile.settings);
    if (recovery && engineType !== 'baileys') {
      await recovery.pause('BAD_SESSION');
      return { status: 'disconnected', message: 'Bounded recovery requires the Baileys engine' };
    }

    // Chromium locks apply only to whatsapp-web.js. Baileys stores its
    // multi-file credentials directly in the profile session directory.
    if (engineType === 'whatsapp-web-js') {
      await this.cleanupStaleLockFiles(sessionDir);
    }
    
    const engineConfig: EngineConfig = {
      profileId,
      investigationMode: requiresManualReconnect(profileId) || Boolean(recovery),
      allowPairing: managedAttempt?.allowPairing,
      sessionDir,
      authStore: engineType === 'baileys' ? {
        read: async () => (await prisma.profile.findUnique({ where: { id: profileId }, select: { sessionData: true } }))?.sessionData || null,
        write: async value => {
          await prisma.profile.update({ where: { id: profileId }, data: { sessionData: value } });
        },
      } : undefined,
      onQR: async (qr: string) => {
        if (!current()) return;
        if (recovery) {
          try { if (!await recovery.qr(managedAttempt!)) return; }
          catch { await recovery.storageStop(); return; }
        }
        cycle.qrIssued = true;
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
        if (!current()) return;
        cycle.qrIssued = false;
        if (recovery) {
          try {
            const accepted = await recovery.ready(managedAttempt!.token, async at => {
              await recordConnectionAlert(profileId, null);
              await prisma.profile.update({ where: { id: profileId }, data: {
                status: 'connected', phoneNumber: phone, lastConnectedAt: new Date(at),
              } });
            });
            if (!accepted || !current()) return;
          } catch { await recovery.storageStop(); return; }
        } else {
          cycle.retries = 0;
          try { await recordConnectionAlert(profileId, null); } catch { this.logger.warn('Connection alert storage unavailable'); }
        }
        this.logger.log(`Profile ${profileId} connected: ${phone} (${pushName})`);
        
        // Update engine instance status
        const instance = this.engines.get(profileId);
        if (instance) {
          instance.status = 'connected';
        }

        // Update database
        if (!recovery) await prisma.profile.update({
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
        if (!current() || disconnectHandled) return;
        disconnectHandled = true;
        this.logger.log(`Profile ${profileId} disconnected: ${reason}`);
        if (recovery) {
          try { await recovery.disconnected(managedAttempt!.token, reason); }
          catch { await recovery.storageStop(); }
          return;
        }
        
        // Update engine instance status
        const instance = this.engines.get(profileId);
        if (instance) {
          instance.status = 'disconnected';
        }

        const terminal = /Forbidden|Connection Replaced|Multidevice Mismatch|Bad Session|Auth Storage Unavailable|Session Expired|Session expired|Logged Out|loggedOut/i.test(reason);
        if (requiresManualReconnect(profileId) && reason === 'Restart Required' &&
            cycle.qrIssued && !cycle.pairingRestartUsed) {
          cycle.pairingRestartUsed = true;
          cycle.pairingRestartPending = true;
          cycle.qrIssued = false;
          this.logger.log(JSON.stringify({ event: 'investigation_pairing_restart', profileId, limit: 1 }));
          await instance?.engine.destroy?.();
          this.engines.delete(profileId);
          if (!current()) return;
          await this.connectProfile(profileId, generation);
          return;
        }
        if (terminal || cycle.retries >= 3 || requiresManualReconnect(profileId)) {
          if (requiresManualReconnect(profileId)) {
            this.logger.warn(JSON.stringify({ event: 'investigation_connection_stopped', profileId,
              automaticReconnect: false, retries: cycle.retries }));
          }
          cycle.paused = true;
          // Stop the provider before persisting status: the database may be the
          // reason for this disconnect. A failed write must not retain a socket.
          try {
            await instance?.engine.destroy?.();
          } catch {
            this.logger.warn('Terminal engine cleanup failed');
          } finally {
            if (this.engines.get(profileId) === instance) this.engines.delete(profileId);
            this.eventsGateway.emitConnectionStatus(profileId, 'disconnected');
          }
          try { await recordConnectionAlert(profileId, connectionAlertCode(reason, cycle.retries >= 3)); } catch { this.logger.warn('Connection alert storage unavailable'); }
          try {
            await prisma.profile.update({ where: { id: profileId }, data: { status: 'disconnected' } });
          } catch {
            this.logger.warn('Disconnected status storage unavailable');
          }
          // Preserve credentials on restrictions and transport failures. A logged-out
          // session must be explicitly paired again; do not repeatedly reconnect it.
          if (/Logged Out|loggedOut/.test(reason) && !requiresManualReconnect(profileId)) {
            const fs = await import('fs/promises');
            await fs.rm(sessionDir, { recursive: true, force: true });
            await prisma.profile.update({ where: { id: profileId }, data: { sessionData: null } });
          }
          return;
        }

        cycle.retries++;
        const delay = 5000 * Math.pow(3, cycle.retries - 1);
        await instance?.engine.destroy?.();
        this.engines.delete(profileId);
        if (!current()) return;
        await prisma.profile.update({ where: { id: profileId }, data: { status: 'connecting' } });
        this.eventsGateway.emitConnectionStatus(profileId, `reconnecting (${cycle.retries}/3)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (!current()) return;
        // A newly created socket is not a successful connection. Only onReady
        // resets the profile-wide attempt budget.
        await this.connectProfile(profileId, generation);

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
              select: { id: true, quotedMessageId: true },
            });
            if (existingMessage) {
              if (!existingMessage.quotedMessageId && message.quotedMessageId) {
                await prisma.message.update({
                  where: { id: existingMessage.id },
                  data: { quotedMessageId: String(message.quotedMessageId) },
                });
              }
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
              quotedMessageId: message.quotedMessageId ? String(message.quotedMessageId) : null,
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
            const conversation = await prisma.conversation.findUnique({
              where: { id: message.conversationId },
              select: { id: true, jid: true, name: true, type: true },
            });
            this.hooksService.emit(AppEvent.MESSAGE_EDITED, {
              profileId,
              messageId: message.messageId || event.messageId,
              senderJid: message.senderJid || '',
              type: updated.type,
              content: updated.content,
              timestamp: event.editedAt || new Date(),
              isGroup: conversation?.type === 'group',
              conversationId: message.conversationId,
              chatJid: conversation?.jid || '',
              groupName: conversation?.name || '',
            });
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
        try {
          const result = await applyMessageAck(profileId, messageId, status);
          if (result.applied === false) {
            this.logger.warn(`[ACK] Ignored acknowledgement: ${result.reason}`);
            return;
          }
          this.logger.log(`[ACK] Updated ${result.count} message(s) to ${result.status}`);

          // Emit WebSocket event for real-time UI updates
          this.eventsGateway.emitMessageAck(profileId, messageId, status);
        } catch (error) {
          this.logger.warn('Failed to update message acknowledgement after bounded retries');
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
      if (!current()) {
        await engine.destroy?.();
        return { status: 'disconnected', message: 'Connection attempt cancelled' };
      }
      
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
          if (!current()) return;
          if (recovery) {
            await recovery.pause('UNKNOWN_FAILURE').catch(() => recovery.storageStop());
            return;
          }
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
        if (!current() || this.engines.get(profileId)?.engine !== engine) return;
        this.logger.warn(`Engine connect timed out after 60s for ${profileId}, but engine is still connecting in background`);
        this.eventsGateway.emitConnectionStatus(profileId, 'connecting');
      }, connectTimeout);

      connectWithTimeout.finally(() => clearTimeout(timeoutId));

      return { status: 'connecting', message: 'Scan QR code to connect' };
    } catch (error: any) {
      if (recovery) {
        const reason = /Retained credentials required|authentication|auth state/i.test(String(error?.message || ''))
          ? 'BAD_SESSION' : 'AUTH_STORAGE_UNAVAILABLE';
        await recovery.pause(reason).catch(() => recovery.storageStop());
        return { status: 'disconnected', message: 'Connection stopped for operator review' };
      }
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
    if (usesBoundedRecovery(profileId)) {
      await this.recoveryFor(profileId).pause('MANUAL_PAUSE');
      return { status: 'disconnected' };
    }
    const cycle = this.connectionCycles.get(profileId);
    if (cycle) cycle.paused = true;
    this.connectionCycles.set(profileId, { generation: (cycle?.generation || 0) + 1, retries: 0, paused: true });
    try { await recordConnectionAlert(profileId, 'MANUAL_PAUSE'); } catch { this.logger.warn('Connection alert storage unavailable'); }
    await prisma.profile.update({ where: { id: profileId }, data: { status: 'disconnected' } });

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
