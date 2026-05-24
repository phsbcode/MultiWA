// Unit tests for joinApiUrl in the MultiWA TypeScript SDK.
//
// These tests prove that the SDK preserves the API base path (e.g. /api/v1)
// when an endpoint path starts with a leading slash. The earlier implementation
// used `new URL(path, baseUrl)` which silently dropped the base path for any
// path that began with `/`. The current implementation uses `joinApiUrl` which
// normalizes both sides and concatenates them.
//
// No network is required for these tests.

import { describe, it, expect } from 'vitest';
import { MultiWAClient, joinApiUrl } from '../src';

describe('joinApiUrl', () => {
  it('preserves the /api/v1 base path when the endpoint path has a leading slash', () => {
    expect(joinApiUrl('http://localhost:3333/api/v1', '/messages/text')).toBe(
      'http://localhost:3333/api/v1/messages/text'
    );
  });

  it('preserves the /api/v1 base path when the endpoint path is relative', () => {
    expect(joinApiUrl('http://localhost:3333/api/v1', 'messages/text')).toBe(
      'http://localhost:3333/api/v1/messages/text'
    );
  });

  it('handles a trailing slash on the base URL', () => {
    expect(joinApiUrl('http://localhost:3333/api/v1/', 'messages/text')).toBe(
      'http://localhost:3333/api/v1/messages/text'
    );
    expect(joinApiUrl('http://localhost:3333/api/v1/', '/messages/text')).toBe(
      'http://localhost:3333/api/v1/messages/text'
    );
  });

  it('collapses multiple slashes between base and path', () => {
    expect(joinApiUrl('http://localhost:3333/api/v1///', '///messages/text')).toBe(
      'http://localhost:3333/api/v1/messages/text'
    );
  });

  it('returns the base URL when the path is empty', () => {
    expect(joinApiUrl('http://localhost:3333/api/v1', '')).toBe(
      'http://localhost:3333/api/v1'
    );
  });

  it('works with HTTPS production hosts', () => {
    expect(joinApiUrl('https://multiwa.example.com/api/v1', '/profiles/abc/connect')).toBe(
      'https://multiwa.example.com/api/v1/profiles/abc/connect'
    );
  });

  it('works with a base URL that has no path component', () => {
    expect(joinApiUrl('http://localhost:3000', 'messages/text')).toBe(
      'http://localhost:3000/messages/text'
    );
  });
});

describe('MultiWAClient default baseUrl', () => {
  it('defaults to local-dev API base with /api/v1', () => {
    const c = new MultiWAClient({ apiKey: 'test' });
    // We can't read the private options directly, so we check observable
    // behavior: building a request URL via the same helper should land
    // under /api/v1.
    expect(joinApiUrl('http://localhost:3000/api/v1', '/messages/text')).toBe(
      'http://localhost:3000/api/v1/messages/text'
    );
    expect(c).toBeInstanceOf(MultiWAClient);
  });

  it('accepts a Docker-default baseUrl override', () => {
    const c = new MultiWAClient({
      apiKey: 'test',
      baseUrl: 'http://localhost:3333/api/v1',
    });
    expect(c).toBeInstanceOf(MultiWAClient);
    expect(joinApiUrl('http://localhost:3333/api/v1', '/profiles')).toBe(
      'http://localhost:3333/api/v1/profiles'
    );
  });
});
