import { describe, expect, it } from 'vitest';
import { resolveProfileEngineType } from './profile-engine';

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
