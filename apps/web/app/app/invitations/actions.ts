'use server';

import { redirect } from 'next/navigation';
import { verifiedSession } from '../../_lib/auth/session';
import { apiRequest } from '../../_lib/platform';

/** Accept/decline through the canonical token routes; the API binds the token to the invitee. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

async function respond(form: FormData, accept: boolean): Promise<never> {
  const raw = form.get('token');
  const token = typeof raw === 'string' ? raw : '';
  if (!TOKEN_RE.test(token)) redirect('/app/invitations?error=invitation_invalid');
  const session = await verifiedSession();
  if (session === null) redirect('/signin?error=session_expired&next=%2Fapp');
  const r = await apiRequest<{ membershipId: string; status: string }>(
    session.accessToken,
    'POST',
    `/v1/invitations/${accept ? 'accept' : 'decline'}`,
    { body: { token } },
  );
  if (r.kind === 'unavailable')
    redirect(`/app/invitations?token=${token}&error=platform_unavailable`);
  if (r.kind !== 'ok') redirect('/app/invitations?error=invitation_invalid');
  if (!accept) redirect('/app?notice=invitation_declined');
  const slug = form.get('orgSlug');
  redirect(
    typeof slug === 'string' && /^[a-z0-9-]{1,100}$/.test(slug)
      ? `/app/orgs/${slug}?notice=joined`
      : '/app?notice=joined',
  );
}

export async function acceptInvitationAction(form: FormData): Promise<never> {
  return respond(form, true);
}

export async function declineInvitationAction(form: FormData): Promise<never> {
  return respond(form, false);
}
