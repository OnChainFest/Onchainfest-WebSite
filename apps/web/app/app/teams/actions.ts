'use server';

import { redirect } from 'next/navigation';
import { getPublic, type AthletePassport } from '../../_lib/api';
import type { AuthErrorCode, AuthNoticeCode } from '../../_lib/auth/messages';
import { validateContinuationRoute } from '../../_lib/auth/continuation';
import { verifiedSession } from '../../_lib/auth/session';
import { idempotencyKey, normalizeSlugInput } from '../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../_lib/platform';
import { UUID_RE } from '../../_lib/registrations';

/**
 * ONCF-05B team actions (pairs and squads over the BRT-05 Team model). Re-verify the session, then
 * call the canonical team commands; the API decides who may manage, invite and accept. A partner
 * is named by their public athlete address and resolved through the public passport.
 */

const PAGE = '/app/teams';
const KINDS = ['EVENT_PAIR', 'EVENT_SQUAD'];

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

/** Back to the teams page (keeping a safe continuation) with a fixed-vocabulary code. */
function back(form: FormData, params: { error?: AuthErrorCode; notice?: AuthNoticeCode }): never {
  const next = validateContinuationRoute(field(form, 'next'));
  const q = new URLSearchParams();
  if (params.error !== undefined) q.set('error', params.error);
  if (params.notice !== undefined) q.set('notice', params.notice);
  if (next !== null) q.set('next', next);
  return redirect(`${PAGE}?${q}`);
}

async function token(): Promise<string> {
  const s = await verifiedSession();
  if (s === null) redirect(`/signin?error=session_expired&next=${encodeURIComponent(PAGE)}`);
  return s.accessToken;
}

function teamErrorCode(r: Exclude<ApiResult<unknown>, { kind: 'ok' }>): AuthErrorCode {
  if (r.kind === 'unavailable' || r.kind === 'unauthenticated') return 'platform_unavailable';
  switch (r.code) {
    case 'FORBIDDEN':
      return 'not_permitted';
    case 'NOT_FOUND':
      return 'athlete_not_found';
    case 'INVALID_INPUT':
    case 'ALREADY_EXISTS':
    case 'INVALID_TRANSITION':
      return 'team_member_invalid';
    default:
      return r.status === 403 ? 'not_permitted' : 'unknown';
  }
}

/** Creates a pair or squad (the caller manages it), optionally adding one of the caller's athletes. */
export async function createTeamAction(form: FormData): Promise<never> {
  const name = field(form, 'displayName').trim();
  const kind = field(form, 'teamKind');
  const me = field(form, 'athleteId');
  if (name === '' || name.length > 80 || !KINDS.includes(kind))
    back(form, { error: 'team_invalid' });
  if (me !== '' && !UUID_RE.test(me)) back(form, { error: 'team_invalid' });
  const t = await token();
  const r = await apiRequest<{ teamId: string }>(t, 'POST', '/v1/teams', {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { teamKind: kind, displayName: name },
  });
  if (r.kind !== 'ok')
    back(form, {
      error: r.kind === 'error' && r.status === 400 ? 'team_invalid' : teamErrorCode(r),
    });
  if (me !== '') {
    const m = await apiRequest(t, 'POST', `/v1/teams/${r.data.teamId}/members`, {
      idempotencyKey: idempotencyKey(`${field(form, 'key')}-self`),
      body: { athleteId: me },
    });
    if (m.kind !== 'ok') back(form, { error: teamErrorCode(m) });
  }
  back(form, { notice: 'team_created' });
}

/** Invites an athlete (by public address) to a team the caller manages; they accept it. */
export async function inviteMemberAction(form: FormData): Promise<never> {
  const teamId = field(form, 'teamId');
  const address = normalizeSlugInput(field(form, 'athleteSlug').replace(/^@/, ''));
  if (!UUID_RE.test(teamId) || address === null || address === '')
    back(form, { error: 'athlete_not_found' });
  const passport = await getPublic<{ passport: AthletePassport }>(
    `/v1/athletes/${encodeURIComponent(address)}`,
  );
  if (passport.kind === 'unavailable') back(form, { error: 'platform_unavailable' });
  if (passport.kind === 'not_found') back(form, { error: 'athlete_not_found' });
  const t = await token();
  const r = await apiRequest(t, 'POST', `/v1/teams/${teamId}/members`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { athleteId: passport.data.passport.athlete.id },
  });
  if (r.kind !== 'ok') back(form, { error: teamErrorCode(r) });
  back(form, { notice: 'member_invited' });
}

/** Accepts or declines an invitation for an athlete the caller manages. */
export async function respondMembershipAction(form: FormData): Promise<never> {
  const id = field(form, 'membershipId');
  const answer = field(form, 'answer');
  if (!UUID_RE.test(id) || (answer !== 'accept' && answer !== 'decline'))
    back(form, { error: 'team_member_invalid' });
  const t = await token();
  const r = await apiRequest(t, 'POST', `/v1/team-memberships/${id}/${answer}`);
  if (r.kind !== 'ok') back(form, { error: teamErrorCode(r) });
  back(form, { notice: answer === 'accept' ? 'membership_accepted' : 'membership_declined' });
}
