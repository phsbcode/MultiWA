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
