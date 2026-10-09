'use server';

import { redirect } from 'next/navigation';
import type { AuthErrorCode, AuthNoticeCode } from '../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { apiRequest } from '../../../../../../_lib/platform';
import {
  registrationErrorCode,
  registrationFilter,
  type RegistrationDecision,
} from '../../../../../../_lib/registrations';
import { context, field, UUID_RE } from '../../../action-support';

/**
 * ONCF-04 organizer registration decisions. Same shape as the ONCF-02/03B actions: re-verify the
 * session and the caller's membership of the organization, then call the canonical BRT-05 command.
 * COMP_MANAGE_REGISTRATIONS, the lifecycle, the field lock and capacity are decided by the API.
 */

const NOTICE = {
  CONFIRM: 'registration_confirmed',
  WAITLIST: 'registration_waitlisted',
  DECLINE: 'registration_declined',
  CANCEL: 'registration_cancelled',
  WITHDRAW: 'registration_withdrawn',
} as const satisfies Record<RegistrationDecision | 'WITHDRAW', AuthNoticeCode>;

/** Back to the list (keeping its validated filters) or to the registration's own page. */
function returnPath(form: FormData, slug: string, competitionId: string, registrationId: string) {
  const base = `/app/orgs/${slug}/tournaments/${competitionId}/registrations`;
  if (field(form, 'return') === 'detail' && UUID_RE.test(registrationId))
    return `${base}/${registrationId}`;
  const f = registrationFilter({
    category: field(form, 'category'),
    status: field(form, 'status'),
  });
  const q = new URLSearchParams();
  if (f.eventId !== undefined) q.set('category', f.eventId);
  if (f.status !== undefined) q.set('status', f.status);
  const s = q.toString();
  return s === '' ? base : `${base}?${s}`;
}

const withParam = (path: string, param: string) =>
  `${path}${path.includes('?') ? '&' : '?'}${param}`;

export async function registrationDecisionAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const competitionId = field(form, 'competitionId');
  if (!UUID_RE.test(competitionId)) redirect(`/app/orgs/${slug}/tournaments`);
  const registrationId = field(form, 'registrationId');
  const back = returnPath(form, slug, competitionId, registrationId);
  const fail = (error: AuthErrorCode): never => redirect(withParam(back, `error=${error}`));
  if (!UUID_RE.test(registrationId)) fail('registration_not_found');
  const command = field(form, 'command');
  if (!Object.hasOwn(NOTICE, command)) fail('registration_transition');
  const reason = field(form, 'reason').trim().slice(0, 500);
  const key = idempotencyKey(field(form, 'key'));

  const r =
    command === 'WITHDRAW'
      ? await apiRequest(token, 'POST', `/v1/registrations/${registrationId}/withdraw`, {
          idempotencyKey: key,
        })
      : await apiRequest(token, 'POST', `/v1/registrations/${registrationId}/decision`, {
          idempotencyKey: key,
          body: { decision: command, ...(reason === '' ? {} : { reason }) },
        });
  if (r.kind !== 'ok')
    fail(registrationErrorCode(r, command === 'WITHDRAW' ? 'withdraw' : 'decide'));
  redirect(withParam(back, `notice=${NOTICE[command as keyof typeof NOTICE]}`));
}
