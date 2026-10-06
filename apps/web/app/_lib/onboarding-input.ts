import { randomBytes } from 'node:crypto';

/** Input shaping for onboarding forms. The platform API re-validates everything. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

export const ORGANIZATION_TYPES = [
  ['CLUB', 'Club'],
  ['ACADEMY', 'Academy'],
  ['LEAGUE', 'League'],
  ['EVENT_ORGANIZER', 'Event organizer'],
  ['FEDERATION', 'Federation'],
  ['VENUE', 'Venue'],
] as const;
export type OrganizationTypeCode = (typeof ORGANIZATION_TYPES)[number][0];

export function isOrganizationType(value: string): value is OrganizationTypeCode {
  return ORGANIZATION_TYPES.some(([code]) => code === value);
}

/** A readable profile address from a display name, with a random suffix to avoid collisions. */
export function slugFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const suffix = randomBytes(3).toString('hex').slice(0, 4);
  return `${base.length >= 2 ? base : 'oc'}-${suffix}`;
}

/** User-entered address → normalized slug, '' when blank, null when invalid. */
export function normalizeSlugInput(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === '') return '';
  return SLUG_RE.test(v) && !v.includes('--') ? v : null;
}

export function countryInput(value: string): string | null | undefined {
  const v = value.trim().toUpperCase();
  if (v === '') return undefined;
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** Idempotency keys come from the rendered form (stable across retries) or are generated. */
export function idempotencyKey(value: string): string {
  return KEY_RE.test(value) ? value : `oc-${randomBytes(16).toString('hex')}`;
}
