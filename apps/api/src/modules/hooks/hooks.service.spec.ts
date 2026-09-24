import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppEvent, HooksService } from './hooks.service';

let suiteDirectory: string;
beforeEach(() => {
  suiteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-suite-'));
  vi.spyOn(process, 'cwd').mockReturnValue(suiteDirectory);
});
afterEach(() => {
  vi.restoreAllMocks();vi.unstubAllGlobals();
  fs.rmSync(suiteDirectory,{recursive:true,force:true});
});

describe('HooksService signed envelopes', () => {
  it('mirrors the HMAC proof into the body for receivers that cannot read headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const service = new HooksService(new EventEmitter2());
    (service as any).hooks = [{
      id: 'hook-payment-monitor',
      url: 'https://example.test/payment-trigger',
      events: [AppEvent.MESSAGE_RECEIVED],
      secret: 'test-secret-with-at-least-thirty-two-characters',
      signatureInBody: true,
      timeoutMs: 30000,
      active: true,
      createdAt: new Date('2026-08-27T00:00:00Z'),
    }];

    await (service as any).dispatchWebhooks(AppEvent.MESSAGE_RECEIVED, {
      profileId: 'profile-test',
      messageId: 'message-test',
      isGroup: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request.body));
    const unsigned = JSON.stringify({ event: body.event, timestamp: body.timestamp, data: body.data });
    const expected = `sha256=${createHmac('sha256', 'test-secret-with-at-least-thirty-two-characters')
      .update(unsigned).digest('hex')}`;
    expect(body.signature).toBe(expected);
    expect(request.headers['X-Webhook-Signature']).toBe(expected);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves the original raw body contract for existing webhook consumers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const service = new HooksService(new EventEmitter2());
    (service as any).hooks = [{
      id: 'hook-existing-consumer', url: 'https://example.test/existing',
      events: [AppEvent.MESSAGE_RECEIVED], secret: 'another-test-secret-with-thirty-two-characters',
      active: true, createdAt: new Date('2026-08-27T00:00:00Z'),
    }];

    await (service as any).dispatchWebhooks(AppEvent.MESSAGE_RECEIVED, { messageId: 'message-test' });

    const [, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(body.signature).toBeUndefined();
    const expected = `sha256=${createHmac('sha256', 'another-test-secret-with-thirty-two-characters')
      .update(String(request.body)).digest('hex')}`;
    expect(request.headers['X-Webhook-Signature']).toBe(expected);
  });
});


describe('Payment Review delivery trace', () => {
  const hook = {
    id: 'hook-payment-test',
    url: 'https://script.google.com/macros/s/TEST_RECEIVER/exec',
    events: [AppEvent.MESSAGE_RECEIVED],
    secret: 'test-secret-with-at-least-thirty-two-characters',
    signatureInBody: true, timeoutMs: 30000, active: true,
    createdAt: new Date('2026-09-23T00:00:00Z'),
  };
  it('sends only routing metadata for signed Apps Script hooks and records receipt rejection', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ok:false,code:'BODY'}) });
    vi.stubGlobal('fetch',fetchMock);
    const service = new HooksService(new EventEmitter2());
    (service as any).hooks=[hook];
    const recorded=vi.spyOn(service as any,'recordPaymentDelivery').mockResolvedValue(undefined);
    await (service as any).dispatchWebhooks(AppEvent.MESSAGE_RECEIVED, {
      profileId:'profile-test',messageId:'message-test',type:'image',
      timestamp:'2026-09-23T00:00:00Z',isGroup:true,
      conversationId:'conversation-test',chatJid:'120363000000000000@g.us',
      content:{url:'data:image/jpeg;base64,'+'A'.repeat(130000)},
    });
    const [,request]=fetchMock.mock.calls[0],body=String(request.body);
    expect(body.length).toBeLessThan(2000);
    expect(body).not.toContain('data:image/jpeg');
    expect(JSON.parse(body).data.messageId).toBe('message-test');
    expect(recorded).toHaveBeenCalledWith(hook,AppEvent.MESSAGE_RECEIVED,
      expect.objectContaining({messageId:'message-test'}),200,JSON.stringify({ok:false,code:'BODY'}),false,expect.objectContaining({finalStatus:200}));
  });

  it('stores only bounded delivery fields on the existing hook volume', async () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'multiwa-hook-trace-'));
    const cwd=vi.spyOn(process,'cwd').mockReturnValue(directory);
    try {
      const service=new HooksService(new EventEmitter2());
      await (service as any).recordPaymentDelivery(hook,AppEvent.MESSAGE_RECEIVED,
        {messageId:'message-test',content:{url:'secret-media'}},200,
        JSON.stringify({ok:false,code:'BODY',secret:'secret-value'}));
      const value=fs.readFileSync(path.join(directory,'data','payment-hook-deliveries.jsonl'),'utf8');
      const row=JSON.parse(value.trim());
      expect(row).toMatchObject({messageId:'message-test',httpStatus:200,
        outcome:'receiver_rejected',receiverCode:'BODY'});
      expect(value).not.toContain('secret-media');
      expect(value).not.toContain('secret-value');
    } finally {cwd.mockRestore();fs.rmSync(directory,{recursive:true,force:true});}
  });
});

describe('Payment Review delivery error reporting', () => {
  const hook = { id: 'hook-payment-test',
    url: 'https://script.google.com/macros/s/TEST_RECEIVER/exec',
    events: [AppEvent.MESSAGE_RECEIVED], secret: 'test-secret-with-at-least-thirty-two-characters',
    signatureInBody: true, timeoutMs: 30000, active: true,
    createdAt: new Date('2026-09-23T00:00:00Z') };
  const payload = { profileId:'profile-test',messageId:'message-test',type:'image',
    timestamp:'2026-09-23T00:00:00Z',isGroup:true,
    conversationId:'conversation-test',chatJid:'120363000000000000@g.us',
    content:{url:'data:image/jpeg;base64,PRIVATE_MEDIA'} };

  it('reports an HTTP 200 receiver rejection through a separate signed compact event', async () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'multiwa-payment-alert-'));
    const cwd=vi.spyOn(process,'cwd').mockReturnValue(directory);
    const fetchMock=vi.fn()
      .mockResolvedValueOnce({ok:true,status:200,text:async()=>JSON.stringify({ok:false,code:'BODY',reported:false})})
      .mockResolvedValueOnce({ok:true,status:200,text:async()=>JSON.stringify({ok:true,reported:true})});
    vi.stubGlobal('fetch',fetchMock);
    try {
      const service=new HooksService(new EventEmitter2());(service as any).hooks=[hook];
      await (service as any).dispatchWebhooks(AppEvent.MESSAGE_RECEIVED,payload);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const report=JSON.parse(String(fetchMock.mock.calls[1][1].body));
      expect(report.event).toBe('delivery.failed');
      expect(report.data).toMatchObject({messageId:'message-test',failureCode:'BODY'});
      expect(JSON.stringify(report)).not.toContain('PRIVATE_MEDIA');
      const unsigned=JSON.stringify({event:report.event,timestamp:report.timestamp,data:report.data});
      expect(report.signature).toBe(`sha256=${createHmac('sha256',hook.secret).update(unsigned).digest('hex')}`);
      const pending=JSON.parse(fs.readFileSync(path.join(directory,'data','payment-hook-alerts.json'),'utf8'));
      expect(pending).toEqual([]);
    } finally {cwd.mockRestore();fs.rmSync(directory,{recursive:true,force:true});}
  });

  it('retains transport failures when the receiver cannot accept the alert', async () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'multiwa-payment-alert-'));
    const cwd=vi.spyOn(process,'cwd').mockReturnValue(directory);
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network unavailable')));
    try {
      const service=new HooksService(new EventEmitter2());(service as any).hooks=[hook];
      await (service as any).dispatchWebhooks(AppEvent.MESSAGE_RECEIVED,payload);
      const pending=JSON.parse(fs.readFileSync(path.join(directory,'data','payment-hook-alerts.json'),'utf8'));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({messageId:'message-test',failureCode:'TRANSPORT'});
      expect(JSON.stringify(pending)).not.toContain('PRIVATE_MEDIA');
    } finally {cwd.mockRestore();fs.rmSync(directory,{recursive:true,force:true});}
  });
});
