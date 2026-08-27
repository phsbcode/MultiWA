import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSocketUrl } from './socket';

describe('getSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the current page origin so Socket.IO traverses the admin proxy', () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://example.test:3002' },
    });

    expect(getSocketUrl()).toBe('http://example.test:3002');
  });

  it('keeps direct API access for a local browser', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://127.0.0.1:3333');
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:3001', hostname: '127.0.0.1' },
    });

    expect(getSocketUrl()).toBe('http://127.0.0.1:3333');
  });

  it('ignores a baked localhost URL for a public page', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://127.0.0.1:3333');
    vi.stubGlobal('window', {
      location: { origin: 'https://admin.example.test', hostname: 'admin.example.test' },
    });

    expect(getSocketUrl()).toBe('https://admin.example.test');
  });
});
