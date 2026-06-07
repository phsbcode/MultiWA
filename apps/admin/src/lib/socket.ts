// MultiWA - Centralized Socket.IO URL Resolution
// apps/admin/src/lib/socket.ts

/**
 * Returns the correct Socket.IO base URL for the current environment.
 *
 * DERIVED FROM PAGE HOSTNAME (default):
 *   The admin (port 3001) and API (port 3333) always run on the same host,
 *   so the WebSocket URL is derived from window.location.hostname at runtime.
 *   This works universally:
 *     - http://127.0.0.1:3001     → ws://127.0.0.1:3333
 *     - http://localhost:3001      → ws://localhost:3333
 *     - http://cachy.banyan:3001   → ws://cachy.banyan:3333
 *     - https://admin.example.com  → wss://admin.example.com:3333
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
  // The default localhost/127.0.0.1 values baked in by Docker/CI builds
  // are skipped — we derive from the browser's page hostname instead.
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (configuredApiUrl) {
    try {
      const url = new URL(configuredApiUrl);
      const isLocalDefault =
        url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (!isLocalDefault) {
        return configuredApiUrl;
      }
    } catch {
      // Malformed URL — fall through to runtime derivation
    }
  }

  // Derive from the page's own hostname at runtime.
  // Admin and API are co-located on the same host, so the API is
  // always at the same hostname on port 3333.
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${window.location.hostname}:3333`;
  }

  // SSR fallback — should never actually be used for socket connections
  return 'http://127.0.0.1:3333';
}
