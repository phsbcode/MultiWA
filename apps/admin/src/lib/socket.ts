// MultiWA - Centralized Socket.IO URL Resolution
// apps/admin/src/lib/socket.ts

/**
 * Returns the correct Socket.IO base URL for the current environment.
 *
 * - Development (localhost/127.0.0.1): connects directly to API server
 *   via NEXT_PUBLIC_API_URL or fallback http://localhost:3333
 * - Production: connects via same origin — Nginx proxies /socket.io/
 *   to the API upstream, so we use the browser's current host.
 *
 * This utility is shared across all pages that need WebSocket connections
 * (Dashboard, Chat, Profile Detail, New Profile) to ensure consistent behavior.
 */
export function getSocketUrl(): string {
  if (typeof window === 'undefined') {
    // SSR fallback — should never actually be used for socket connections
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333';
  }

  const hostname = window.location.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

  if (isLocal) {
    // Development: connect directly to API server
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333';
  }

  // Production: use same origin (Nginx handles /socket.io/ → API proxy)
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.host}`;
}
