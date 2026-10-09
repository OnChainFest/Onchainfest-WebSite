/**
 * Safe post-authentication continuation (`next=`), adapted from PMFreak's
 * validate-continuation-route (ADR-0052). Only same-origin paths inside the authenticated
 * application surface (`/app`) are accepted; auth and API routes are never continuation targets.
 * Anything else ⇒ null, and the caller falls back to the onboarding/app default.
 */
const ORIGIN = 'https://continuation.invalid';
const MAX_LENGTH = 2048;
const BLOCKED_PREFIXES = ['/signin', '/signup', '/signout', '/auth', '/api'] as const;
const ALLOWED_PREFIXES = ['/app'] as const;

const hasPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function validateContinuationRoute(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN) return null;
  // Reject paths that only become an allowed route after normalization (`/app/../api`, `%2e%2e`).
  const raw = value.split(/[?#]/, 1)[0] ?? '';
  if (raw !== url.pathname) return null;
  if (BLOCKED_PREFIXES.some((p) => hasPrefix(url.pathname, p))) return null;
  if (!ALLOWED_PREFIXES.some((p) => hasPrefix(url.pathname, p))) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
