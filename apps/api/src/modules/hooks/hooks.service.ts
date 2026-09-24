// MultiWA Gateway - Hooks Service (Event Emitter + Webhook Dispatcher)
// apps/api/src/modules/hooks/hooks.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentHookDelivery, PaymentDeliveryDiagnostic } from './payment-hook-delivery';
import * as path from 'node:path';

/**
 * Standard event names used across the application.
 */
export enum AppEvent {
  // Message events
  MESSAGE_RECEIVED = 'message.received',
  MESSAGE_EDITED = 'message.edited',
  MESSAGE_SENT = 'message.sent',
  MESSAGE_FAILED = 'message.failed',

  // Profile events
  PROFILE_CONNECTED = 'profile.connected',
  PROFILE_DISCONNECTED = 'profile.disconnected',
  PROFILE_QR_UPDATED = 'profile.qr_updated',

  // Broadcast events
  BROADCAST_STARTED = 'broadcast.started',
  BROADCAST_COMPLETED = 'broadcast.completed',
  BROADCAST_FAILED = 'broadcast.failed',

  // Contact events
  CONTACT_CREATED = 'contact.created',
  CONTACT_UPDATED = 'contact.updated',

  // Automation events
  AUTOMATION_TRIGGERED = 'automation.triggered',
  AUTOMATION_ERROR = 'automation.error',
}

export interface HookRegistration {
  id: string;
  url: string;
  events: string[]; // List of AppEvent values to subscribe to, or ['*'] for all
  secret?: string;  // Optional HMAC signing secret
  signatureInBody?: boolean; // Mirror HMAC into JSON for receivers without header access
  timeoutMs?: number; // Per-hook delivery timeout; defaults to 10 seconds
  active: boolean;
  createdAt: Date;
}

@Injectable()
export class HooksService implements OnModuleInit {
  private readonly logger = new Logger(HooksService.name);
  private hooks: HookRegistration[] = [];
  private pendingPaymentFailures: Array<{hookId: string; profileId: string;
    messageId: string; conversationId: string; chatJid: string;
    failureCode: string; at: string}> = [];
  private paymentFailureFlushRunning = false;
  private originalDelivery: PaymentHookDelivery;

  constructor(private readonly eventEmitter: EventEmitter2) {}

  async onModuleInit() {
    await this.loadHooks();
    this.logger.log(`Hooks service initialized with ${this.hooks.length} registered webhook(s)`);
    await this.loadPaymentFailures();
    const retryTimer = setInterval(() => { void this.flushPaymentFailures(); }, 300000);
    retryTimer.unref();
    void this.flushPaymentFailures();
    const deliveryTimer = setInterval(() => { void this.paymentDelivery().retryDue(); }, 60000);
    deliveryTimer.unref();
    void this.paymentDelivery().retryDue();
  }

  /**
   * Emit an event to all internal listeners and dispatch to webhooks.
   */
  emit(event: string, payload: any): void {
    this.eventEmitter.emit(event, payload);
    this.dispatchWebhooks(event, payload).catch((err) =>
      this.logger.error(`Webhook dispatch error: ${err.message}`),
    );
  }

  /**
   * Register an internal event listener.
   */
  on(event: string, handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  /**
   * Register a new webhook hook.
   */
  async registerHook(url: string, events: string[], secret?: string,
    signatureInBody = false, timeoutMs = 10000): Promise<HookRegistration> {
    const hook: HookRegistration = {
      id: `hook_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      url,
      events,
      secret,
      signatureInBody,
      timeoutMs: Math.max(1000, Math.min(60000, Number(timeoutMs) || 10000)),
      active: true,
      createdAt: new Date(),
    };

    this.hooks.push(hook);
    await this.saveHooks();
    this.logger.log(`Webhook registered: ${url} → events: ${events.join(', ')}`);
    return hook;
  }

  /**
   * Remove a webhook hook.
   */
  async removeHook(id: string): Promise<boolean> {
    const idx = this.hooks.findIndex((h) => h.id === id);
    if (idx === -1) return false;

    this.hooks.splice(idx, 1);
    await this.saveHooks();
    this.logger.log(`Webhook removed: ${id}`);
    return true;
  }

  /**
   * List all registered hooks.
   */
  getHooks(): HookRegistration[] {
    return [...this.hooks];
  }

  private paymentDelivery(): PaymentHookDelivery {
    if (!this.originalDelivery) this.originalDelivery = new PaymentHookDelivery({
      directory: path.resolve(process.cwd(), 'data'),
      hook: id => this.hooks.find(hook => hook.id === id && this.paymentTraceHook(hook)),
      receipt: (hook, event, data, status, body, transport, diagnostic) => this.recordPaymentDelivery(
        hook as HookRegistration, event, data, status, body, transport, diagnostic),
      failure: (hook, data, code) => this.queuePaymentFailure(hook as HookRegistration, data, code),
      storageError: () => this.logger.error('Payment intake retry storage needs attention'),
    });
    return this.originalDelivery;
  }

  private paymentTraceHook(hook: HookRegistration): boolean {
    return hook.signatureInBody === true &&
      /^https:\/\/script\.google\.com\//.test(hook.url);
  }

  private async failureFile(): Promise<string> {
    const path = await import('node:path');
    return path.resolve(process.cwd(), 'data', 'payment-hook-alerts.json');
  }
  private async loadPaymentFailures(): Promise<void> {
    try {
      const fs = await import('node:fs');
      const value = JSON.parse(fs.readFileSync(await this.failureFile(), 'utf8'));
      this.pendingPaymentFailures = Array.isArray(value) ? value.slice(-500) : [];
    } catch { this.pendingPaymentFailures = []; }
  }
  private async savePaymentFailures(): Promise<void> {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const file = await this.failureFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(this.pendingPaymentFailures), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch { this.logger.warn('Payment delivery alert backlog could not be stored'); }
  }
  private async queuePaymentFailure(hook: HookRegistration, payload: any,
    failureCode: string): Promise<void> {
    if (!this.paymentTraceHook(hook) || payload?.isGroup !== true ||
        !/^[A-Za-z0-9_-]{5,220}$/.test(String(payload?.messageId || ''))) return;
    const item = { hookId: hook.id, profileId: String(payload.profileId || ''),
      messageId: String(payload.messageId), conversationId: String(payload.conversationId || ''),
      chatJid: String(payload.chatJid || ''), failureCode, at: new Date().toISOString() };
    if (!this.pendingPaymentFailures.some(row => row.hookId === item.hookId &&
        row.messageId === item.messageId && row.failureCode === item.failureCode)) {
      this.pendingPaymentFailures.push(item);
      if (this.pendingPaymentFailures.length > 500) {
        this.pendingPaymentFailures.shift();
        this.logger.error('Payment delivery alert backlog exceeded 500 entries');
      }
      await this.savePaymentFailures();
    }
    await this.flushPaymentFailures();
  }
  private async flushPaymentFailures(): Promise<void> {
    if (this.paymentFailureFlushRunning || !this.pendingPaymentFailures.length) return;
    this.paymentFailureFlushRunning = true;
    try {
      for (const item of this.pendingPaymentFailures.slice(0, 5)) {
        const hook = this.hooks.find(row => row.id === item.hookId &&
          row.active && this.paymentTraceHook(row)) || this.hooks.find(row =>
          row.active && this.paymentTraceHook(row));
        if (!hook?.secret) break;
        const timestamp = new Date().toISOString();
        const envelope = { event: 'delivery.failed', timestamp, data: {
          profileId: item.profileId, messageId: item.messageId, isGroup: true,
          conversationId: item.conversationId, chatJid: item.chatJid,
          failureCode: item.failureCode, timestamp,
        } };
        const crypto = await import('node:crypto');
        const signature = crypto.createHmac('sha256', hook.secret)
          .update(JSON.stringify(envelope)).digest('hex');
        try {
          const response = await fetch(hook.url, { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...envelope, signature: `sha256=${signature}` }),
            signal: AbortSignal.timeout(10000) });
          const receipt = JSON.parse((await response.text()).slice(0, 2048));
          if (!response.ok || receipt.ok !== true || receipt.reported !== true) break;
          this.pendingPaymentFailures = this.pendingPaymentFailures.filter(row => row !== item);
          await this.savePaymentFailures();
        } catch { break; }
      }
    } finally { this.paymentFailureFlushRunning = false; }
  }

  private async recordPaymentDelivery(hook: HookRegistration, event: string, payload: any,
    status: number, responseBody: string, transportFailure = false, diagnostic?: PaymentDeliveryDiagnostic): Promise<void> {
    // Only the signed Apps Script receiver is traced. Raw payloads and signatures stay out.
    if (!this.paymentTraceHook(hook)) return;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const messageId = String(payload?.messageId || '').trim();
      if (!/^[A-Za-z0-9_-]{5,220}$/.test(messageId)) return;
      let receipt: Record<string, unknown> = {};
      try { receipt = JSON.parse(responseBody.slice(0, 2048)); } catch {}
      const code = String(receipt.code || '');
      const knownCode = ['DISABLED', 'BODY', 'EVENT', 'SIGNATURE', 'STALE', 'PROFILE',
        'MESSAGE', 'TRIGGER', 'LOCK', 'QUEUE'].includes(code) ? code : '';
      const outcome = transportFailure ? 'transport_error' : status < 200 || status >= 300
        ? 'http_error' : receipt.ok === false ? 'receiver_rejected'
          : receipt.ok === true && receipt.accepted === true ? 'accepted' : 'unreadable_receipt';
      const row = { at: new Date().toISOString(), messageId, hookId: hook.id, event,
        httpStatus: status, outcome, receiverCode: knownCode,
        deliveryId: /^[A-Za-z0-9_-]{5,120}$/.test(String(payload?.deliveryId || '')) ? payload.deliveryId : undefined,
        transport: diagnostic,
        queued: receipt.queued === true, duplicate: receipt.duplicate === true,
        ignoredGroup: receipt.ignored === 'group_not_selected' };
      const directory = path.resolve(process.cwd(), 'data');
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'payment-hook-deliveries.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).size >= 5 * 1024 * 1024) {
        fs.renameSync(file, file + '.previous');
      }
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (error) {
      this.logger.warn('Payment hook delivery trace could not be stored');
    }
  }

  /**
   * Dispatch event to all matching webhook URLs.
   */
  private async dispatchWebhooks(event: string, payload: any): Promise<void> {
    const matchingHooks = this.hooks.filter(
      (h) => h.active && (h.events.includes('*') || h.events.includes(event)),
    );

    if (matchingHooks.length === 0) return;

    const timestamp = new Date().toISOString();
    const promises = matchingHooks.map(async (hook) => {
      if (this.paymentTraceHook(hook) && payload?.isGroup === true &&
          [AppEvent.MESSAGE_RECEIVED, AppEvent.MESSAGE_EDITED].includes(event as AppEvent)) {
        return this.paymentDelivery().enqueue(hook, event, payload);
      }
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Webhook-Event': event,
        };

        // The payment receiver needs routing metadata, not the media data URL.
        const paymentHook = hook.signatureInBody &&
          /^https:\/\/script\.google\.com\//.test(hook.url);
        const data = paymentHook ? {
          profileId: payload?.profileId, messageId: payload?.messageId,
          type: payload?.type, timestamp: payload?.timestamp, isGroup: payload?.isGroup,
          conversationId: payload?.conversationId, chatJid: payload?.chatJid,
          groupName: payload?.groupName,
        } : payload;
        const envelope = { event, timestamp, data };
        const unsignedBody = JSON.stringify(envelope);
        // HMAC signing if secret is configured
        let signature = '';
        if (hook.secret) {
          const crypto = await import('crypto');
          signature = crypto
            .createHmac('sha256', hook.secret)
            .update(unsignedBody)
            .digest('hex');
          headers['X-Webhook-Signature'] = `sha256=${signature}`;
        }

        // Apps Script web apps cannot read arbitrary request headers. Keep the
        // header for normal consumers and mirror its proof into the JSON body
        // so constrained receivers can verify the exact unsigned envelope.
        const body = hook.signatureInBody && signature ? JSON.stringify({
          ...envelope, signature: `sha256=${signature}`,
        }) : unsignedBody;

        const response = await fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(Math.max(1000,
            Math.min(60000, Number(hook.timeoutMs) || 10000))),
        });

        if (this.paymentTraceHook(hook)) {
          const receipt = await response.text();
          await this.recordPaymentDelivery(hook, event, payload, response.status, receipt);
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(receipt.slice(0, 2048)); } catch {}
          if (!response.ok || parsed.ok === false && parsed.reported !== true ||
              parsed.ok !== true && parsed.ok !== false) {
            const code = !response.ok ? `HTTP_${response.status}` :
              typeof parsed.code === 'string' && /^[A-Z_]{3,30}$/.test(parsed.code)
                ? parsed.code : 'UNREADABLE';
            await this.queuePaymentFailure(hook, payload, code);
          }
        }
        if (!response.ok) {
          this.logger.warn(`Webhook ${hook.url} returned ${response.status}`);
        }
      } catch (error: any) {
        await this.recordPaymentDelivery(hook, event, payload, 0, '', true);
        await this.queuePaymentFailure(hook, payload, 'TRANSPORT');
        this.logger.error(`Webhook ${hook.url} failed: ${error.message}`);
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Load hooks from JSON file.
   */
  private async loadHooks(): Promise<void> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(process.cwd(), 'data', 'hooks.json');
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        this.hooks = JSON.parse(data);
      }
    } catch {
      this.logger.warn('Could not load hooks from file, starting with empty list');
      this.hooks = [];
    }
  }

  /**
   * Save hooks to JSON file.
   */
  private async saveHooks(): Promise<void> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const dataDir = path.resolve(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(dataDir, 'hooks.json'),
        JSON.stringify(this.hooks, null, 2),
      );
    } catch (error: any) {
      this.logger.error(`Failed to save hooks: ${error.message}`);
    }
  }
}
