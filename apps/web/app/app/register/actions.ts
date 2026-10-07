'use server';

import { redirect } from 'next/navigation';
import type { AuthErrorCode } from '../../_lib/auth/messages';
import { verifiedSession } from '../../_lib/auth/session';
import { idempotencyKey } from '../../_lib/onboarding-input';
import { apiRequest } from '../../_lib/platform';
import {
  registerPath,
  registrationErrorCode,
  UUID_RE,
  type RegistrationStatus,
} from '../../_lib/registrations';

/**
 * ONCF-04 athlete registration actions. Re-verify the session, then call the canonical BRT-05
 * commands; the API decides who may enter which athlete, the window, capacity, duplicates and the
 * resulting status. Hidden fields only say what was intended — nothing is trusted for authorization.
 */

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

// Path segments are lookup keys; anything else never reaches a redirect.
const SEGMENT_RE = /^[a-z0-9-]{1,100}$/;

async function token(next: string): Promise<string> {
  const s = await verifiedSession();
  if (s === null) redirect(`/signin?error=session_expired&next=${encodeURIComponent(next)}`);
  return s.accessToken;
}

/** Submits the entry reviewed on the registration page (one idempotency key per rendered review). */
export async function registerAction(form: FormData): Promise<never> {
  const slug = field(form, 'competitionSlug');
  const eventSlug = field(form, 'eventSlug');
  if (!SEGMENT_RE.test(slug) || !SEGMENT_RE.test(eventSlug)) redirect('/app/registrations');
  const page = registerPath(slug, eventSlug);
  const eventId = field(form, 'eventId');
  const athleteId = field(form, 'athleteId');
  const review = `${page}?step=review&athlete=${UUID_RE.test(athleteId) ? athleteId : ''}`;
  const back = (error: AuthErrorCode): never => redirect(`${review}&error=${error}`);
  if (!UUID_RE.test(eventId) || !UUID_RE.test(athleteId)) redirect(`${page}?error=missing_fields`);
  if (field(form, 'eligibility') !== 'yes') back('eligibility_required');

  const t = await token(review);
  const r = await apiRequest<{ registrationId: string; status: RegistrationStatus }>(
    t,
    'POST',
    `/v1/events/${eventId}/registrations`,
    {
      idempotencyKey: idempotencyKey(field(form, 'key')),
      body: { athleteId, eligibilityDeclared: true },
    },
  );
  if (r.kind === 'unauthenticated')
    redirect(`/signin?error=session_expired&next=${encodeURIComponent(review)}`);
  if (r.kind !== 'ok') return back(registrationErrorCode(r, 'register'));
  redirect(`/app/registrations/${r.data.registrationId}?notice=registration_received`);
}

/** The entrant withdraws its own entry (the API refuses anyone else and anything after the lock). */
export async function withdrawRegistrationAction(form: FormData): Promise<never> {
  const id = field(form, 'registrationId');
  if (!UUID_RE.test(id)) redirect('/app/registrations?error=registration_not_found');
  const page = `/app/registrations/${id}`;
  const t = await token(page);
  const r = await apiRequest(t, 'POST', `/v1/registrations/${id}/withdraw`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
  });
  if (r.kind === 'unauthenticated')
    redirect(`/signin?error=session_expired&next=${encodeURIComponent(page)}`);
  if (r.kind !== 'ok') redirect(`${page}?error=${registrationErrorCode(r, 'withdraw')}`);
  redirect(`${page}?notice=registration_withdrawn`);
}
