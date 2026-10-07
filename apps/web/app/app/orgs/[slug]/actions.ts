'use server';

import { redirect } from 'next/navigation';
import type { AuthErrorCode, AuthNoticeCode } from '../../../_lib/auth/messages';
import { siteUrl } from '../../../_lib/auth/request-meta';
import { verifiedSession } from '../../../_lib/auth/session';
import { idempotencyKey, normalizeSlugInput, SLUG_RE } from '../../../_lib/onboarding-input';
import { apiRequest, loadAccountState, type ApiResult } from '../../../_lib/platform';

/**
 * ONCF-02 organization administration actions. Each one re-verifies the session, resolves the
 * organization from the caller's own memberships and calls the canonical /v1 route; the API's
 * permission checks (ORG_EDIT_PROFILE, ORG_INVITE_MEMBER, ORG_MANAGE_ROLES, ORG_REMOVE_MEMBER) are
 * the authority. Errors map to the fixed message vocabulary.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = ['OWNER', 'ADMIN', 'STAFF', 'COACH', 'OFFICIAL', 'ATHLETE', 'MEMBER'] as const;

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

type Area = 'profile' | 'members' | 'invitations' | 'settings' | '';

function to(
  slug: string,
  area: Area,
  params: { error?: AuthErrorCode; notice?: AuthNoticeCode },
): never {
  const q = params.error !== undefined ? `error=${params.error}` : `notice=${params.notice}`;
  return redirect(`/app/orgs/${slug}${area === '' ? '' : `/${area}`}?${q}`);
}

function errorCode(result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): AuthErrorCode {
  if (result.kind === 'unavailable' || result.kind === 'unauthenticated')
    return 'platform_unavailable';
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
async function context(slug: string) {
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

const optional = (v: string) => (v.trim() === '' ? null : v.trim());

export async function updateProfileAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token, org } = await context(slug);
  const country = field(form, 'country').trim().toUpperCase();
  const accent = field(form, 'accentColor').trim().toLowerCase();
  const sports = field(form, 'sports')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  const displayName = field(form, 'displayName').trim();
  if (displayName === '') to(slug, 'profile', { error: 'missing_fields' });
  const r = await apiRequest(token, 'PATCH', `/v1/organizations/${org.organizationId}/profile`, {
    body: {
      displayName,
      description: optional(field(form, 'description')),
      website: optional(field(form, 'website')),
      publicContact: optional(field(form, 'publicContact')),
      country: country === '' ? null : country,
      logoUrl: optional(field(form, 'logoUrl')),
      accentColor: accent === '' ? null : accent,
      sports: [...new Set(sports)].slice(0, 10),
    },
  });
  if (r.kind !== 'ok') to(slug, 'profile', { error: errorCode(r) });
  to(slug, 'profile', { notice: 'profile_saved' });
}

export async function changeAddressAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token, org } = await context(slug);
  const next = normalizeSlugInput(field(form, 'newSlug'));
  if (next === null || next === '') to(slug, 'settings', { error: 'profile_address_invalid' });
  const r = await apiRequest<{ slug: string }>(
    token,
    'PUT',
    `/v1/organizations/${org.organizationId}/slug`,
    { body: { slug: next } },
  );
  if (r.kind !== 'ok') to(slug, 'settings', { error: errorCode(r) });
  to(r.data.slug, 'settings', { notice: 'address_changed' });
}

export interface InviteState {
  readonly kind: 'idle' | 'ok' | 'error';
  readonly link?: string;
  readonly expiresAt?: string;
  readonly error?: AuthErrorCode;
  /** Fresh key for the next submission (the form re-renders with it). */
  readonly nextKey: string;
}

/**
 * Creates an invitation for a public athlete profile address. The raw token is returned ONCE by
 * the API; it is shown to the inviter as a link and never stored by the web app.
 */
export async function inviteAction(prev: InviteState, form: FormData): Promise<InviteState> {
  const fresh = () => idempotencyKey('');
  const slug = field(form, 'slug');
  const { token, org } = await context(slug);
  const athleteSlug = normalizeSlugInput(field(form, 'athleteSlug').replace(/^.*\/athletes\//, ''));
  const role = field(form, 'role');
  const visibility = field(form, 'visibility');
  if (athleteSlug === null || athleteSlug === '')
    return { kind: 'error', error: 'athlete_not_found', nextKey: prev.nextKey };
  if (
    !(ROLES as readonly string[]).includes(role) ||
    !['PUBLIC', 'MEMBERS', 'PRIVATE'].includes(visibility)
  )
    return { kind: 'error', error: 'profile_invalid', nextKey: prev.nextKey };
  const base = siteUrl();
  if (base === null) return { kind: 'error', error: 'not_configured', nextKey: prev.nextKey };
  const r = await apiRequest<{ token: string | null; expiresAt: string }>(
    token,
    'POST',
    `/v1/organizations/${org.organizationId}/invitations`,
    {
      idempotencyKey: idempotencyKey(field(form, 'key')),
      body: { athleteSlug, role, visibility },
    },
  );
  if (r.kind !== 'ok') return { kind: 'error', error: errorCode(r), nextKey: fresh() };
  if (r.data.token === null)
    // An idempotent replay: the token was already shown once and cannot be recovered.
    return { kind: 'error', error: 'already_member', nextKey: fresh() };
  return {
    kind: 'ok',
    link: `${base}/app/invitations?token=${encodeURIComponent(r.data.token)}`,
    expiresAt: r.data.expiresAt,
    nextKey: fresh(),
  };
}

const STATUS_NOTICE = {
  ENDED: 'member_removed',
  SUSPENDED: 'member_suspended',
  ACTIVE: 'member_reactivated',
} as const;

export async function memberStatusAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const area = field(form, 'from') === 'invitations' ? 'invitations' : 'members';
  const membershipId = field(form, 'membershipId');
  const status = field(form, 'status');
  const { token } = await context(slug);
  if (!UUID_RE.test(membershipId) || !(status in STATUS_NOTICE))
    to(slug, area, { error: 'profile_invalid' });
  const r = await apiRequest(token, 'PUT', `/v1/memberships/${membershipId}/status`, {
    body: { status },
  });
  if (r.kind !== 'ok') {
    const lastOwner =
      r.kind === 'error' && r.code === 'INVALID_TRANSITION' && field(form, 'role') === 'OWNER';
    to(slug, area, { error: lastOwner ? 'last_owner' : errorCode(r) });
  }
  to(slug, area, {
    notice:
      area === 'invitations'
        ? 'invitation_revoked'
        : STATUS_NOTICE[status as keyof typeof STATUS_NOTICE],
  });
}

export async function changeRoleAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const membershipId = field(form, 'membershipId');
  const role = field(form, 'role');
  const { token } = await context(slug);
  if (!UUID_RE.test(membershipId) || !(ROLES as readonly string[]).includes(role))
    to(slug, 'members', { error: 'profile_invalid' });
  const r = await apiRequest(token, 'POST', `/v1/memberships/${membershipId}/role`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { role },
  });
  if (r.kind !== 'ok') to(slug, 'members', { error: errorCode(r) });
  to(slug, 'members', { notice: 'role_changed' });
}

/** Leaving ends every membership the caller holds in this organization (owners last). */
export async function leaveAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token, memberships } = await context(slug);
  const ordered = [...memberships].sort(
    (a, b) => Number(a.role === 'OWNER') - Number(b.role === 'OWNER'),
  );
  for (const m of ordered) {
    const r = await apiRequest(token, 'PUT', `/v1/memberships/${m.membershipId}/status`, {
      body: { status: 'ENDED' },
    });
    if (r.kind !== 'ok') {
      const code =
        r.kind === 'error' && r.code === 'INVALID_TRANSITION' && m.role === 'OWNER'
          ? 'last_owner'
          : errorCode(r);
      to(slug, 'settings', { error: code });
    }
  }
  redirect('/app?notice=left_organization');
}
