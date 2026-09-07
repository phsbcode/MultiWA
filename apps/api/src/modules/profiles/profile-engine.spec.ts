import { describe, expect, it } from 'vitest';
import {
  profileAllowsDntOperations,
  profileSettingsWithDntOperationsAccess,
  resolveProfileEngineType,
} from './profile-engine';

describe('resolveProfileEngineType', () => {
  it('selects Baileys when persisted in profile settings', () => {
    expect(resolveProfileEngineType({ engine: 'baileys' })).toBe('baileys');
  });

  it('keeps existing profiles on whatsapp-web-js when no engine was persisted', () => {
    expect(resolveProfileEngineType({})).toBe('whatsapp-web-js');
    expect(resolveProfileEngineType(null)).toBe('whatsapp-web-js');
  });

  it('rejects unsupported persisted engine values by falling back safely', () => {
    expect(resolveProfileEngineType({ engine: 'unknown-engine' })).toBe('whatsapp-web-js');
  });

  it('allows the inert mock adapter only in the test runtime', () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      expect(resolveProfileEngineType({ engine: 'mock' })).toBe('mock');
      process.env.NODE_ENV = 'production';
      expect(resolveProfileEngineType({ engine: 'mock' })).toBe('whatsapp-web-js');
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});

describe('DNT Operations profile access', () => {
  it('defaults closed and accepts only the exact boolean flag', () => {
    expect(profileAllowsDntOperations(null)).toBe(false);
    expect(profileAllowsDntOperations({ dntOperationsAccess: 'true' })).toBe(false);
    expect(profileAllowsDntOperations({ dntOperationsAccess: true })).toBe(true);
  });

  it('updates the access flag without discarding engine or integration settings', () => {
    expect(profileSettingsWithDntOperationsAccess({ engine: 'baileys', fastbots: { enabled: false } }, true)).toEqual({
      engine: 'baileys',
      fastbots: { enabled: false },
      dntOperationsAccess: true,
    });
  });
});
