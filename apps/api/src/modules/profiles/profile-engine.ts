import type { EngineType } from '@multiwa/engines';

export const DEFAULT_PROFILE_ENGINE: EngineType = 'whatsapp-web-js';

export function resolveProfileEngineType(settings: unknown): EngineType {
  if (settings && typeof settings === 'object') {
    const engine = (settings as Record<string, unknown>).engine;
    if (engine === 'baileys' || engine === 'whatsapp-web-js') {
      return engine;
    }
  }

  return DEFAULT_PROFILE_ENGINE;
}

export function profileSettingsWithEngine(settings: unknown, requestedEngine?: unknown): Record<string, any> {
  const existing = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, any>
    : {};
  const engine = requestedEngine === 'baileys' || requestedEngine === 'whatsapp-web-js'
    ? requestedEngine
    : resolveProfileEngineType(existing);

  return { ...existing, engine };
}

export function profileAllowsDntOperations(settings: unknown): boolean {
  return Boolean(
    settings
      && typeof settings === 'object'
      && !Array.isArray(settings)
      && (settings as Record<string, unknown>).dntOperationsAccess === true,
  );
}

export function profileSettingsWithDntOperationsAccess(settings: unknown, allowed: boolean): Record<string, any> {
  const existing = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, any>
    : {};

  return { ...existing, dntOperationsAccess: allowed === true };
}
