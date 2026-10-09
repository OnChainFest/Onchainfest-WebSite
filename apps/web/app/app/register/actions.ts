'use server';

import { redirect } from 'next/navigation';
import type { AuthErrorCode } from '../../_lib/auth/messages';
import { verifiedSession } from '../../_lib/auth/session';
import { idempotencyKey } from '../../_lib/onboarding-input';
import { apiRequest } from '../../_lib/platform';
import { attributeContext, changedAttributes } from '../../_lib/entry-attributes';
import {
  registerPath,
  registrationById,
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

/**
 * Submits the entry reviewed on the registration page (one idempotency key per rendered review).
 * The entrant is an athlete (individual categories) or a team the caller manages (team
 * categories, ONCF-05B); exactly one is sent and the API decides whether it may enter.
 */
export async function registerAction(form: FormData): Promise<never> {
  const slug = field(form, 'competitionSlug');
  const eventSlug = field(form, 'eventSlug');
  if (!SEGMENT_RE.test(slug) || !SEGMENT_RE.test(eventSlug)) redirect('/app/registrations');
  const page = registerPath(slug, eventSlug);
  const eventId = field(form, 'eventId');
  const athleteId = field(form, 'athleteId');
  const teamId = field(form, 'teamId');
  const team = teamId !== '';
  const entrant = team ? teamId : athleteId;
  const review = `${page}?step=review&${team ? 'team' : 'athlete'}=${UUID_RE.test(entrant) ? entrant : ''}`;
  const back = (error: AuthErrorCode): never => redirect(`${review}&error=${error}`);
  if (!UUID_RE.test(eventId) || !UUID_RE.test(entrant) || (team && athleteId !== ''))
    redirect(`${page}?error=missing_fields`);
  if (field(form, 'eligibility') !== 'yes') back('eligibility_required');

  const t = await token(review);
  const r = await apiRequest<{ registrationId: string; status: RegistrationStatus }>(
    t,
    'POST',
    `/v1/events/${eventId}/registrations`,
    {
      idempotencyKey: idempotencyKey(field(form, 'key')),
      body: { ...(team ? { teamId } : { athleteId }), eligibilityDeclared: true },
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

/**
 * ONCF-05B: declares (or clears) entry values on the entrant's own registration. Only values that
 * differ from what was rendered are sent; the discipline's declarations come from the catalog,
 * never from the form. The API validates types, bounds, members and the lock window.
 */
export async function declareAttributesAction(form: FormData): Promise<never> {
  const id = field(form, 'registrationId');
  if (!UUID_RE.test(id)) redirect('/app/registrations?error=registration_not_found');
  const page = `/app/registrations/${id}`;
  const t = await token(page);
  const reg = await registrationById(t, id);
  if (reg.kind === 'unauthenticated')
    redirect(`/signin?error=session_expired&next=${encodeURIComponent(page)}`);
  if (reg.kind !== 'ok') redirect(`${page}?error=${registrationErrorCode(reg, 'withdraw')}`);
  const ctx = await attributeContext(t, reg.data);
  if (ctx === null) redirect(`${page}?error=platform_unavailable`);
  if (!ctx.editable) redirect(`${page}?error=attributes_frozen`);
  const names = [...new Set([...form.keys()])];
  const changed = changedAttributes((n) => field(form, n), names, ctx.specs);
  if (changed.kind === 'invalid') redirect(`${page}?error=attribute_invalid`);
  if (changed.attributes.length === 0) redirect(`${page}?notice=attributes_saved`);
  const r = await apiRequest(t, 'POST', `/v1/registrations/${id}/entry-attributes`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { attributes: changed.attributes },
  });
  if (r.kind === 'unauthenticated')
    redirect(`/signin?error=session_expired&next=${encodeURIComponent(page)}`);
  if (r.kind !== 'ok')
    redirect(
      `${page}?error=${
        r.kind === 'error' && r.code === 'INVALID_TRANSITION'
          ? 'attributes_frozen'
          : r.kind === 'error' && r.code === 'INVALID_INPUT'
            ? 'attribute_invalid'
            : registrationErrorCode(r, 'withdraw')
      }`,
    );
  redirect(`${page}?notice=attributes_saved`);
}
