'use server';

import { redirect } from 'next/navigation';
import { validateContinuationRoute } from '../../_lib/auth/continuation';
import type { AuthErrorCode } from '../../_lib/auth/messages';
import { verifiedSession } from '../../_lib/auth/session';
import {
  countryInput,
  idempotencyKey,
  isOrganizationType,
  normalizeSlugInput,
  slugFromName,
} from '../../_lib/onboarding-input';
import { apiRequest, type ApiResult, type MeResponse } from '../../_lib/platform';

/**
 * Onboarding persists ONLY through the platform API (ONCF-01, ADR-0052): person → athlete, or
 * person → organization (the API makes the creator OWNER). Nothing is written to Supabase.
 */

type Path = 'athlete' | 'organization';

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

/** `next`: a validated continuation carried through onboarding (ONCF-04), kept on retries. */
function back(path: Path, error: AuthErrorCode, next: string | null = null): never {
  const carry = next === null ? '' : `&next=${encodeURIComponent(next)}`;
  redirect(`/app/onboarding?path=${path}&error=${error}${carry}`);
}

function failure(
  path: Path,
  result: Exclude<ApiResult<unknown>, { kind: 'ok' }>,
  next: string | null = null,
): never {
  if (result.kind === 'unauthenticated') redirect('/signin?error=session_expired&next=%2Fapp');
  if (result.kind === 'unavailable') back(path, 'platform_unavailable', next);
  if (result.code === 'SLUG_TAKEN') back(path, 'profile_address_taken', next);
  if (result.code === 'SLUG_INVALID') back(path, 'profile_address_invalid', next);
  if (result.status === 403) back(path, 'not_permitted', next);
  if (result.status === 400) back(path, 'profile_invalid', next);
  back(path, 'platform_unavailable', next);
}

async function session(): Promise<string> {
  const s = await verifiedSession();
  if (s === null) redirect('/signin?error=session_expired&next=%2Fapp%2Fonboarding');
  return s.accessToken;
}

/** The caller's SELF person: reuse it, or create it (idempotent per rendered form). */
async function ensurePerson(
  token: string,
  path: Path,
  key: string,
  next: string | null = null,
): Promise<string> {
  const me = await apiRequest<MeResponse>(token, 'GET', '/v1/me');
  if (me.kind !== 'ok') failure(path, me, next);
  if (me.data.selfPersonId !== null) return me.data.selfPersonId;
  const created = await apiRequest<{ personId: string }>(token, 'POST', '/v1/persons', {
    body: { relation: 'SELF' },
    idempotencyKey: key,
  });
  if (created.kind !== 'ok') failure(path, created, next);
  return created.data.personId;
}

export async function createAthleteProfileAction(form: FormData): Promise<never> {
  const displayName = field(form, 'displayName').trim();
  const slugInput = normalizeSlugInput(field(form, 'slug'));
  const country = countryInput(field(form, 'country'));
  const sport = field(form, 'sport').trim();
  // ONCF-04: where to resume afterwards (e.g. the registration that sent the athlete here).
  const next = validateContinuationRoute(field(form, 'next'));
  if (displayName === '' || displayName.length > 80) back('athlete', 'missing_fields', next);
  if (slugInput === null) back('athlete', 'profile_address_invalid', next);
  if (country === null || sport.length > 40) back('athlete', 'profile_invalid', next);

  const token = await session();
  const personId = await ensurePerson(
    token,
    'athlete',
    idempotencyKey(field(form, 'personKey')),
    next,
  );
  const result = await apiRequest<{ athleteId: string; slug: string }>(
    token,
    'POST',
    '/v1/athletes',
    {
      idempotencyKey: idempotencyKey(field(form, 'profileKey')),
      body: {
        personId,
        slug: slugInput === '' ? slugFromName(displayName) : slugInput,
        profile: {
          displayName,
          ...(country === undefined ? {} : { homeCountry: country }),
          ...(sport === '' ? {} : { preferredSports: [sport] }),
        },
      },
    },
  );
  if (result.kind !== 'ok') failure('athlete', result, next);
  if (next !== null) redirect(`${next}${next.includes('?') ? '&' : '?'}notice=athlete_created`);
  redirect('/app?notice=athlete_created');
}

export async function createOrganizationAction(form: FormData): Promise<never> {
  const displayName = field(form, 'displayName').trim();
  const orgType = field(form, 'orgType');
  const slugInput = normalizeSlugInput(field(form, 'slug'));
  const country = countryInput(field(form, 'country'));
  if (displayName === '' || displayName.length > 120) back('organization', 'missing_fields');
  if (!isOrganizationType(orgType)) back('organization', 'profile_invalid');
  if (slugInput === null) back('organization', 'profile_address_invalid');
  if (country === null) back('organization', 'profile_invalid');

  const token = await session();
  await ensurePerson(token, 'organization', idempotencyKey(field(form, 'personKey')));
  const result = await apiRequest<{ organizationId: string; slug: string }>(
    token,
    'POST',
    '/v1/organizations',
    {
      idempotencyKey: idempotencyKey(field(form, 'profileKey')),
      body: {
        orgType,
        slug: slugInput === '' ? slugFromName(displayName) : slugInput,
        profile: { displayName, ...(country === undefined ? {} : { country }) },
      },
    },
  );
  if (result.kind !== 'ok') failure('organization', result);
  redirect(`/app/orgs/${result.data.slug}?notice=organization_created`);
}
