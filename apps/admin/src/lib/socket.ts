// MultiWA - Centralized Socket.IO URL Resolution
// apps/admin/src/lib/socket.ts

/**
 * Returns the correct Socket.IO base URL for the current environment.
 *
 * PAGE ORIGIN (default):
 *   Production Socket.IO traffic uses the page origin so the public HTTPS
 *   reverse proxy can route /socket.io without exposing the API host port.
 *
 * EXPLICIT OVERRIDE (production):
 *   When NEXT_PUBLIC_API_URL is set to a non-local address at build time
 *   (e.g., https://api.example.com for a separate API subdomain), it is
 *   used directly. The default Docker/CI value of 127.0.0.1 is ignored
 *   in favor of runtime hostname derivation.
 *
 * This utility is shared across all pages that need WebSocket connections
 * (Dashboard, Chat, Profile Detail, New Profile) to ensure consistent behavior.
 */
export function getSocketUrl(): string {
  // NEXT_PUBLIC_API_URL — used as an explicit override for production
  // deployments where the API is on a different domain.
  // A localhost/127.0.0.1 value remains valid for a local browser. When that
  // default is baked into a production build, use the public page origin.
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (configuredApiUrl) {
    try {
      const url = new URL(configuredApiUrl);
      const isLocalDefault =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (!isLocalDefault) {
        return configuredApiUrl;
      }
      if (
        typeof window !== 'undefined'
        && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
      ) {
        return configuredApiUrl;
      }
    } catch {
      // Malformed URL — fall through to same-origin routing.
    }
  }

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // SSR fallback — should never actually be used for socket connections
  return 'http://127.0.0.1:3333';
}
