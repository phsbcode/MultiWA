import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { PaymentHookDelivery } from './payment-hook-delivery';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const payload = { profileId: 'profile-test', messageId: 'message-test', type: 'image',
  timestamp: '2026-09-23T07:12:42.000Z', isGroup: true,
  conversationId: 'conversation-test', chatJid: '120363000000000000@g.us', groupName: 'DNT Sales RECORD',
  content: { url: 'PRIVATE_MEDIA', text: 'PRIVATE_CAPTION' }, senderPhone: 'PRIVATE_PHONE' };
const accepted = { ok: true, accepted: true, queued: true };
function reply(status: number, body: unknown) {
  return { status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) } as Response;
}
function fixture(respond: (index: number, body: any) => Promise<Response> | Response) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-original-retry-'));
  directories.push(directory);
  const hook = { id: 'hook-test', url: 'https://script.google.com/macros/s/TEST/exec',
    secret: 'PRIVATE_SIGNING_SECRET', active: true, timeoutMs: 10000 };
  let now = Date.parse('2026-09-23T07:12:43Z');
  const requests: Array<{url: string; body: any; raw: string; method: string; headers: any}> = [], failures: string[] = [], receipts: number[] = [], diagnostics: any[] = [];
  const dependencies = { directory, hook: () => hook, now: () => now,
    sleep: async (ms: number) => { now += ms; },
    receipt: async (_hook: any, _event: any, _data: any, status: number, _body: string, _failed: boolean, diagnostic: any) => { receipts.push(status);diagnostics.push(diagnostic); },
    failure: async (_hook: any, _data: any, code: string) => { failures.push(code); },
    storageError: vi.fn(),
    request: (async (url: any, options: any) => {
      const raw = options.body ? String(options.body) : '', body = raw ? JSON.parse(raw) : null;
      requests.push({url: String(url), body, raw, method: options.method, headers: options.headers});
      return respond(requests.length, body);
    }) as typeof fetch };
  return { directory, hook, requests, failures, receipts, diagnostics, dependencies,
    service: new PaymentHookDelivery(dependencies), setTime: (value: number) => { now = value; },
    read: () => JSON.parse(fs.readFileSync(path.join(directory, 'payment-hook-outbox.json'), 'utf8')) };
}

describe('Original payment webhook recovery', () => {
  it('recovers the original post after 404 without needing a later WhatsApp message', async () => {
    const app = fixture(index => index === 1 ? reply(404, 'Google temporarily unavailable') : reply(200, accepted));
    await app.service.enqueue(app.hook, 'message.received', payload);
    expect(app.requests).toHaveLength(2);
    expect(app.requests.map(r => r.body.event)).toEqual(['message.received', 'message.received']);
    expect(app.requests[1].body.data.messageId).toBe(payload.messageId);
    expect(app.requests[1].body.data.timestamp).toBe(payload.timestamp);
    expect(app.requests[1].raw).toBe(app.requests[0].raw);
    expect(app.requests[1].url).not.toBe(app.requests[0].url);
    const { signature, ...unsigned } = app.requests[1].body;
    expect(signature).toBe('sha256=' + createHmac('sha256', app.hook.secret).update(JSON.stringify(unsigned)).digest('hex'));
    expect(app.failures).toEqual(['HTTP_404']);
    expect(app.receipts).toEqual([404, 200]);
    expect(app.read()).toEqual([]);
  });

  it('keeps a longer outage across restart and refreshes the signature time only', async () => {
    const app = fixture(index => index <= 3 ? reply(503, '') : reply(200, accepted));
    await app.service.enqueue(app.hook, 'message.edited', payload);
    expect(app.requests).toHaveLength(3);
    const [saved] = app.read();
    expect(saved.attempts).toBe(3);
    expect(saved.nextAttemptAt).toBeGreaterThan(saved.createdAt);
    const disk = JSON.stringify(app.read());
    for (const value of ['PRIVATE_MEDIA', 'PRIVATE_CAPTION', 'PRIVATE_PHONE', 'PRIVATE_SIGNING_SECRET']) expect(disk).not.toContain(value);
    const restarted = new PaymentHookDelivery(app.dependencies);
    await restarted.retryDue();
    expect(app.requests).toHaveLength(3); // Backoff survives restart too.
    app.setTime(saved.createdAt + 3600000);
    await restarted.retryDue();
    expect(app.requests).toHaveLength(4);
    expect(app.requests[3].body.timestamp).not.toBe(app.requests[0].body.timestamp);
    expect(app.requests[3].body.data.timestamp).toBe(payload.timestamp);
    expect(app.requests[3].body.data.deliveryId).toBe(app.requests[0].body.data.deliveryId);
    expect(app.requests[3].body.event).toBe('message.edited');
    expect(app.read()).toEqual([]);
    expect(app.failures).toEqual(['HTTP_503']);
  });

  it('a lost acknowledgement safely replays the same signed event', async () => {
    const persisted = new Set<string>();
    const app = fixture((index, body) => {
      const duplicate = persisted.has(body.signature);
      persisted.add(body.signature);
      if (index === 1) throw new Error('Response lost after receiver queued event');
      return reply(200, {ok:true,accepted:true,duplicate,queued:!duplicate});
    });
    await app.service.enqueue(app.hook, 'message.received', payload);
    expect(app.requests).toHaveLength(2);
    expect(persisted.size).toBe(1);
    expect(app.read()).toEqual([]);
  });

  it.each([[401, {}, 'HTTP_401'], [403, {}, 'HTTP_403'], [200, {ok:false,code:'SIGNATURE'}, 'SIGNATURE']])(
    'retains a blocked event for operator review on nonretryable response %s', async (status, body, code) => {
      const app = fixture(() => reply(Number(status), body));
      await app.service.enqueue(app.hook, 'message.received', payload);
      expect(app.requests).toHaveLength(1);
      expect(app.read()[0].blockedCode).toBe(code);
      app.setTime(Date.parse('2026-09-23T10:00:00Z'));
      await new PaymentHookDelivery(app.dependencies).retryDue();
      expect(app.requests).toHaveLength(1);
      expect(app.failures).toEqual([code]);
    });

  it('retries a queue failure even when its error report was already saved', async () => {
    const app = fixture(index => index === 1 ? reply(200, {ok:false,code:'QUEUE',reported:true}) : reply(200, accepted));
    await app.service.enqueue(app.hook, 'message.received', payload);
    expect(app.requests).toHaveLength(2);
    expect(app.failures).toEqual([]);
    expect(app.read()).toEqual([]);
  });

  it('requires an explicit queue acknowledgement and honors deliberate hook disabling', async () => {
    const app = fixture(index => index <= 3 ? reply(200, {ok:true}) : reply(200, accepted));
    await app.service.enqueue(app.hook, 'message.received', payload);
    expect(app.read()).toHaveLength(1);
    expect(app.failures).toEqual(['UNREADABLE']);
    app.hook.active = false;
    app.setTime(Date.parse('2026-09-23T09:00:00Z'));
    await app.service.retryDue();
    expect(app.requests).toHaveLength(3);
    app.hook.active = true;
    await app.service.retryDue();
    expect(app.requests).toHaveLength(4);
    expect(app.read()).toEqual([]);
  });

  it('persists before sending and serializes simultaneous payment events', async () => {
    let active = 0, maximum = 0;
    const app = fixture(async () => {
      expect(app.read().length).toBeGreaterThan(0);
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;return reply(200, accepted);
    });
    await Promise.all([app.service.enqueue(app.hook,'message.received',payload),
      app.service.enqueue(app.hook,'message.received',{...payload,messageId:'another-message'})]);
    expect(maximum).toBe(1);
    expect(app.requests.map(r=>r.body.data.messageId)).toEqual(['message-test','another-message']);
    expect(app.read()).toEqual([]);
  });
});


describe('ContentService redirect diagnostics',()=>{
 it('records both response hops and the durable receipt without storing one-time URLs',async()=>{
  const secretUrl='https://script.googleusercontent.com/macros/echo?user_content_key=PRIVATE_ONETIME_TOKEN';
  const app=fixture(index=>{
   if(index===1||index===3)return {status:302,headers:new Headers({location:secretUrl}),text:async()=>''} as Response;
   if(index===2)return reply(404,'Temporary redirect failure');
   return reply(200,{...accepted,receiptId:'a'.repeat(32),state:'pending'});
  });
  await app.service.enqueue(app.hook,'message.received',payload);
  expect(app.requests.map(r=>r.method)).toEqual(['POST','GET','POST','GET']);
  expect(app.requests[1].raw).toBe('');expect(app.requests[1].headers).toBeUndefined();
  expect(app.diagnostics[0]).toMatchObject({initialStatus:302,finalStatus:404,finalHost:'script.googleusercontent.com',redirects:1});
  expect(app.diagnostics[1]).toMatchObject({initialStatus:302,finalStatus:200,receiptId:'a'.repeat(32),receiptState:'pending'});
  expect(JSON.stringify(app.diagnostics)).not.toContain('PRIVATE_ONETIME_TOKEN');
  expect(app.read()).toEqual([]);
 });
 it('does not forward a signed request to an unapproved redirect host',async()=>{
  const app=fixture(()=>({status:307,headers:new Headers({location:'https://unexpected.example/secret'}),text:async()=>''}) as Response);
  await app.service.enqueue(app.hook,'message.received',payload);
  expect(app.requests).toHaveLength(3);expect(app.requests.every(r=>new URL(r.url).hostname==='script.google.com')).toBe(true);
  expect(app.read()).toHaveLength(1);
 });
});
