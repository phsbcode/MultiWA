import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AppEvent, HooksService } from './hooks.service';

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
