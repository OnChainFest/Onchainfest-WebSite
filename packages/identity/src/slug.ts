/**
 * Public slugs (athletes, organizations): human-friendly, never canonical identity.
 *
 * Normalization: NFKC → lowercase → trim → spaces/underscores to "-" → collapse repeated "-".
 * Valid: 3–50 chars of [a-z0-9-], starting and ending alphanumeric, no "--".
 * Uniqueness is case-insensitive by construction (only the normalized form is stored).
 * Reserved words (routes, system paths, impersonation-prone terms) are refused.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'admin',
  'administrator',
  'login',
  'logout',
  'signin',
  'signup',
  'register',
  'settings',
  'account',
  'accounts',
  'me',
  'profile',
  'organizations',
  'organization',
  'athletes',
  'athlete',
  'passport',
  'health',
  'ready',
  'internal',
  'dev',
  'static',
  'assets',
  '_next',
  'new',
  'edit',
  'support',
  'help',
  'about',
  'official',
  'verified',
  'bragging-rights',
  'braggingrights',
  'brt',
  'root',
  'system',
  'null',
  'undefined',
]);

export type SlugResult = { ok: true; slug: string } | { ok: false; reason: 'INVALID' | 'RESERVED' };

/** ONCF-03A: the one slug length bound (domain, database `identity.normalized_slug_ok`, API, web). */
export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 50;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;

export function normalizeSlug(input: string): SlugResult {
  const slug = input
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-');
  if (!SLUG.test(slug) || slug.includes('--')) return { ok: false, reason: 'INVALID' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: 'RESERVED' };
  return { ok: true, slug };
}

/** Lookup form of an incoming path segment (no reservation check: lookups of reserved words just miss). */
export function slugLookupKey(input: string): string | undefined {
  const r = normalizeSlug(input);
  return r.ok ? r.slug : undefined;
}
