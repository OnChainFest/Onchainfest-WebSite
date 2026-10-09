import { redirect } from 'next/navigation';
import type { AuthErrorCode, AuthNoticeCode } from '../../../_lib/auth/messages';
import { verifiedSession } from '../../../_lib/auth/session';
import { SLUG_RE } from '../../../_lib/onboarding-input';
import { loadAccountState, type ApiResult } from '../../../_lib/platform';

/**
 * Shared plumbing for the organization-area server actions (ONCF-02 administration, ONCF-03B
 * tournaments): session re-verification, the caller's own membership, the redirect-with-code
 * pattern and the API error → fixed vocabulary mapping. Not a 'use server' module: nothing here
 * is callable from the browser.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

export const optional = (v: string) => (v.trim() === '' ? null : v.trim());

/** Redirects to `/app/orgs/<slug>[/<area>]?error=…|notice=…` (area may carry a sub-path). */
export function to(
  slug: string,
  area: string,
  params: { error?: AuthErrorCode; notice?: AuthNoticeCode },
): never {
  const q = params.error !== undefined ? `error=${params.error}` : `notice=${params.notice}`;
  return redirect(`/app/orgs/${slug}${area === '' ? '' : `/${area}`}?${q}`);
}

/**
 * API refusal → message code. `scope` picks the wording for codes whose meaning depends on what
 * was being changed (a member's status vs a tournament's lifecycle, a profile vs a tournament
 * address). Only codes the API actually returns are mapped; anything else falls back.
 */
export function errorCode(
  result: Exclude<ApiResult<unknown>, { kind: 'ok' }>,
  scope: 'organization' | 'tournament' = 'organization',
): AuthErrorCode {
  if (result.kind === 'unavailable' || result.kind === 'unauthenticated')
    return 'platform_unavailable';
  if (scope === 'tournament')
    switch (result.code) {
      case 'FORBIDDEN':
        return 'not_permitted';
      case 'SLUG_TAKEN':
        return 'tournament_address_taken';
      case 'SLUG_INVALID':
        return 'profile_address_invalid';
      case 'INVALID_TRANSITION':
        return 'tournament_transition';
      case 'INVALID_INPUT':
        return 'tournament_invalid';
      case 'NOT_FOUND':
        return 'tournament_not_found';
      default:
        return result.status === 403 ? 'not_permitted' : 'tournament_invalid';
    }
  switch (result.code) {
    case 'FORBIDDEN':
      return 'not_permitted';
    case 'SLUG_TAKEN':
      return 'profile_address_taken';
    case 'SLUG_INVALID':
      return 'profile_address_invalid';
    case 'ALREADY_EXISTS':
      return 'already_member';
    case 'INVITATION_INVALID':
      return 'invitation_invalid';
    case 'NOT_FOUND':
      return 'athlete_not_found';
    case 'INVALID_TRANSITION':
      return 'invalid_change';
    default:
      return result.status === 403 ? 'not_permitted' : 'profile_invalid';
  }
}

/** Session + the caller's ACTIVE membership of `slug` (the organization id comes from the API). */
export async function context(slug: string) {
  if (!SLUG_RE.test(slug)) redirect('/app');
  const session = await verifiedSession();
  if (session === null) redirect(`/signin?error=session_expired&next=%2Fapp%2Forgs%2F${slug}`);
  const state = await loadAccountState(session.accessToken);
  if (state.kind === 'unauthenticated') redirect('/signin?error=session_expired&next=%2Fapp');
  if (state.kind === 'unavailable') to(slug, '', { error: 'platform_unavailable' });
  const memberships = state.state.organizations.filter((o) => o.slug === slug);
  const org = memberships[0];
  if (org === undefined) redirect('/app');
  return { token: session.accessToken, org, memberships };
}
