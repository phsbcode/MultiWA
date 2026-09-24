import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

export interface PaymentDeliveryHook {
  id: string;
  url: string;
  secret?: string;
  active: boolean;
  timeoutMs?: number;
}
export interface PaymentDeliveryDiagnostic {
  initialStatus: number; finalStatus: number; finalHost: string; redirects: number; elapsedMs: number;
  contentType?: string; receiptId?: string; receiptState?: string;
}
export interface PaymentRouteData {
  deliveryId?: string;
  profileId: string;
  messageId: string;
  type: string;
  timestamp: string;
  isGroup: true;
  conversationId: string;
  chatJid: string;
  groupName: string;
}
interface PendingDelivery {
  id: string;
  hookId: string;
  event: 'message.received' | 'message.edited';
  data: PaymentRouteData;
  createdAt: number;
  envelopeAt: number;
  attempts: number;
  cycles: number;
  nextAttemptAt: number;
  blockedCode?: string;
  alertedCode?: string;
}
interface Dependencies {
  directory: string;
  hook: (id: string) => PaymentDeliveryHook | undefined;
  receipt: (hook: PaymentDeliveryHook, event: string, data: PaymentRouteData,
    status: number, body: string, transportFailure: boolean, diagnostic?: PaymentDeliveryDiagnostic) => Promise<void>;
  failure: (hook: PaymentDeliveryHook, data: PaymentRouteData, code: string) => Promise<void>;
  storageError: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  request?: typeof fetch;
}

// This outbox retries Google intake deliveries. It never invokes WhatsApp or payment submission.
export class PaymentHookDelivery {
  private readonly file: string;
  private readonly entries = new Map<string, PendingDelivery>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly request: typeof fetch;
  private chain: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly retryDelays = [0, 500, 1500];
  private readonly laterDelays = [60000, 300000, 900000, 1800000];

  constructor(private readonly deps: Dependencies) {
    this.file = path.join(deps.directory, 'payment-hook-outbox.json');
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.request = deps.request || ((input, init) => fetch(input, init));
  }

  private load(): void {
    if (this.loaded) return;
    if (fs.existsSync(this.file)) {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('Invalid payment delivery outbox');
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || typeof row.hookId !== 'string' ||
            !['message.received', 'message.edited'].includes(row.event) ||
            !this.route(row.data) || !Number.isFinite(row.createdAt) ||
            !Number.isFinite(row.envelopeAt) || !Number.isFinite(row.nextAttemptAt)) {
          throw new Error('Invalid payment delivery outbox entry');
        }
        // Reapply the allowlist: an on-disk retry never adds unexpected payload fields.
        this.entries.set(row.id, { ...row, data: { ...this.route(row.data)!, deliveryId: row.id } });
      }
    }
    this.loaded = true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify([...this.entries.values()]));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }

  private route(payload: any): PaymentRouteData | null {
    if (payload?.isGroup !== true ||
        !/^[A-Za-z0-9_-]{5,220}$/.test(String(payload.messageId || '')) ||
        !String(payload.profileId || '') || !Number.isFinite(new Date(payload.timestamp).getTime()) ||
        !/@g\.us$/.test(String(payload.chatJid || ''))) return null;
    return { profileId: String(payload.profileId).slice(0, 220),
      messageId: String(payload.messageId), type: String(payload.type || '').slice(0, 30),
      timestamp: new Date(payload.timestamp).toISOString(), isGroup: true,
      conversationId: String(payload.conversationId || '').slice(0, 220),
      chatJid: String(payload.chatJid).slice(0, 180),
      groupName: String(payload.groupName || '').slice(0, 160) };
  }

  async enqueue(hook: PaymentDeliveryHook, event: string, payload: any): Promise<void> {
    const data = this.route(payload);
    if (!data || !['message.received', 'message.edited'].includes(event)) {
      await this.deps.failure(hook, payload, 'MESSAGE');
      return;
    }
    try {
      this.load();
      // Refuse overflow visibly rather than evicting an undelivered post.
      if (this.entries.size >= 10000) throw new Error('Payment delivery outbox full');
      const id = randomUUID(), now = this.now();
      data.deliveryId = id;
      this.entries.set(id, { id, hookId: hook.id, event: event as PendingDelivery['event'],
        data, createdAt: now, envelopeAt: now, attempts: 0, cycles: 0, nextAttemptAt: now });
      this.save(); // Durable before the first HTTP request, including a process crash mid-request.
      await this.schedule(id);
    } catch {
      this.deps.storageError();
      await this.deps.failure(hook, data, 'QUEUE');
    }
  }

  async retryDue(): Promise<void> {
    try {
      this.load();
      const due = [...this.entries.values()].filter(row => !row.blockedCode &&
        row.nextAttemptAt <= this.now()).slice(0, 5);
      await Promise.all(due.map(row => this.schedule(row.id)));
    } catch { this.deps.storageError(); }
  }

  private schedule(id: string): Promise<void> {
    const run = this.chain.then(() => this.attempt(id));
    // Failed disk writes cannot poison the chain or produce an unhandled promise rejection.
    this.chain = run.catch(() => { this.deps.storageError(); });
    return run;
  }

  private classify(status: number, text: string): { accepted: boolean; retry: boolean;
    code: string; alreadyReported: boolean } {
    let receipt: any = null;
    try { receipt = JSON.parse(text.slice(0, 2048)); } catch {}
    const httpOk = status >= 200 && status < 300;
    const acknowledged = receipt?.ok === true &&
      (receipt.accepted === true && (receipt.queued === true || receipt.duplicate === true) ||
        receipt.ignored === 'group_not_selected');
    if (httpOk && acknowledged) return { accepted: true, retry: false, code: '', alreadyReported: false };
    if (!httpOk) return { accepted: false,
      retry: status === 0 || [404, 408, 429].includes(status) || status >= 500,
      code: status === 0 ? 'TRANSPORT' : `HTTP_${status}`, alreadyReported: false };
    const code = receipt?.ok === false && /^[A-Z_]{3,30}$/.test(String(receipt.code || ''))
      ? String(receipt.code) : 'UNREADABLE';
    return { accepted: false, retry: ['UNREADABLE', 'LOCK', 'QUEUE', 'TRIGGER'].includes(code),
      code, alreadyReported: receipt?.reported === true };
  }

  private async send(url: string, options: RequestInit, diagnostic: PaymentDeliveryDiagnostic): Promise<Response> {
    const origin = new URL(url).origin;
    let current = url, init = options;
    for (let hop = 0; hop <= 3; hop++) {
      const response = await this.request(current, { ...init, redirect: 'manual' });
      if (hop === 0) diagnostic.initialStatus = response.status;
      diagnostic.finalStatus = response.status;
      diagnostic.finalHost = new URL(current).hostname;
      diagnostic.contentType = String(response.headers?.get('content-type') || '').slice(0, 80);
      const location = response.headers?.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      if (hop === 3) throw new Error('Receiver redirect limit exceeded');
      const next = new URL(location, current);
      const approved = next.origin === origin || next.protocol === 'https:' && next.hostname === 'script.googleusercontent.com';
      if (!approved || new URL(current).protocol === 'https:' && next.protocol !== 'https:') {
        throw new Error('Unapproved receiver redirect');
      }
      const useGet = response.status === 303 || [301, 302].includes(response.status) && init.method === 'POST';
      if (!useGet && next.origin !== origin) throw new Error('Signed body cannot be redirected to a different origin');
      init = useGet ? { method: 'GET', signal: options.signal } : init;
      diagnostic.redirects++;
      current = next.toString();
    }
    throw new Error('Receiver redirect limit exceeded');
  }

  private async attempt(id: string): Promise<void> {
    const item = this.entries.get(id);
    if (!item || item.blockedCode || item.nextAttemptAt > this.now()) return;
    const hook = this.deps.hook(item.hookId);
    // Honor hook disable/removal and never reroute the original event to another destination.
    if (!hook?.active || !hook.secret) return;
    if (this.now() - item.createdAt > 7 * 86400000) {
      item.blockedCode = 'STALE'; this.save();
      await this.deps.failure(hook, item.data, 'STALE');
      return;
    }
    for (const delay of this.retryDelays) {
      if (delay) await this.sleep(delay);
      if (!this.deps.hook(item.hookId)?.active) return;
      if (this.now() - item.envelopeAt > 120000) item.envelopeAt = this.now();
      item.attempts++;
      item.nextAttemptAt = this.now() + 60000;
      this.save();
      const envelope = { event: item.event, timestamp: new Date(item.envelopeAt).toISOString(), data: item.data };
      const signature = 'sha256=' + createHmac('sha256', hook.secret).update(JSON.stringify(envelope)).digest('hex');
      const url = new URL(hook.url);
      url.searchParams.set('dpm_delivery', `${item.id}_${item.attempts}`);
      let status = 0, text = '', transportFailure = false;
      const started = this.now();
      const diagnostic: PaymentDeliveryDiagnostic = {initialStatus:0,finalStatus:0,finalHost:new URL(hook.url).hostname,redirects:0,elapsedMs:0};
      try {
        const response = await this.send(url.toString(), { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Event': item.event,
            'X-Webhook-Signature': signature },
          body: JSON.stringify({ ...envelope, signature }),
          signal: AbortSignal.timeout(Math.max(1000, Math.min(60000, Number(hook.timeoutMs) || 10000))) }, diagnostic);
        status = response.status;
        text = await response.text();
      } catch { transportFailure = true; status = 0; }
      diagnostic.elapsedMs = Math.max(0, this.now() - started);
      try {
        const receipt = JSON.parse(text.slice(0, 2048));
        if (/^[a-f0-9]{32}$/.test(String(receipt.receiptId || ''))) diagnostic.receiptId = receipt.receiptId;
        if (['pending','processing','completed','blocked'].includes(receipt.state)) diagnostic.receiptState = receipt.state;
      } catch {}
      await this.deps.receipt(hook, item.event, item.data, status, text, transportFailure, diagnostic);
      const outcome = this.classify(status, text);
      if (outcome.accepted) {
        this.entries.delete(id); this.save();
        return;
      }
      if (!item.alertedCode) {
        if (!outcome.alreadyReported) await this.deps.failure(hook, item.data, outcome.code);
        item.alertedCode = outcome.code;
      }
      if (!outcome.retry) {
        item.blockedCode = outcome.code; this.save();
        return;
      }
    }
    item.cycles++;
    item.nextAttemptAt = this.now() + this.laterDelays[Math.min(item.cycles - 1, this.laterDelays.length - 1)];
    this.save();
  }
}
