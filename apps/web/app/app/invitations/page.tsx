import { appContext } from '../../_lib/app-context';
import { apiRequest } from '../../_lib/platform';
import { ORG_TYPE_LABEL, ROLE_LABEL } from '../../_lib/org-context';
import { one, type SearchParams } from '../../_lib/search-params';
import { Flash } from '../../_product/flash';
import { OrgMark } from '../../_product/org-chrome';
import { SubmitButton } from '../../_product/submit-button';
import { acceptInvitationAction, declineInvitationAction } from './actions';

// The token is in the URL: never send it onward as a referrer.
export const metadata = { title: 'Invitation · OnChainFest', referrer: 'no-referrer' };

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

interface Preview {
  role: string;
  expiresAt: string;
  organization: { slug: string; displayName: string; orgType: string };
}

export default async function InvitationPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  const token = one(params.token);
  const preview =
    token !== undefined && TOKEN_RE.test(token)
      ? await apiRequest<Preview>(ctx.session.accessToken, 'POST', '/v1/invitations/inspect', {
          body: { token },
        })
      : null;

  if (preview === null || preview.kind !== 'ok') {
    const unavailable = preview?.kind === 'unavailable';
    return (
      <>
        <div className="page-head">
          <span className="mono muted">Invitation</span>
          <h1 className="page-title">
            {unavailable ? 'Try again' : 'Not valid'} <span className="outline">for you.</span>
          </h1>
        </div>
        <Flash
          error={unavailable ? 'platform_unavailable' : (one(params.error) ?? 'invitation_invalid')}
        />
        <p className="muted">Ask the organization for a new invitation link.</p>
        <a className="btn btn-ghost" href="/app">
          Back to OnChainFest
        </a>
      </>
    );
  }

  const { organization: org, role, expiresAt } = preview.data;
  return (
    <>
      <div className="page-head">
        <span className="mono muted">You’re invited</span>
        <h1 className="page-title">
          Join <span className="outline">{org.displayName}.</span>
        </h1>
      </div>
      <Flash error={one(params.error)} />
      <article className="invite-card">
        <OrgMark name={org.displayName} logoUrl={null} size={64} />
        <div>
          <span className="mono muted">{ORG_TYPE_LABEL[org.orgType] ?? org.orgType}</span>
          <strong>{org.displayName}</strong>
          <span className="muted small">
            As <b>{ROLE_LABEL[role] ?? role}</b> · expires{' '}
            {new Date(expiresAt).toLocaleDateString('en', {
              day: 'numeric',
              month: 'short',
              timeZone: 'UTC',
            })}
          </span>
        </div>
        <a className="link mono" href={`/organizations/${org.slug}`}>
          Public page ↗
        </a>
      </article>
      <div className="row-actions" style={{ marginTop: '1.5rem' }}>
        <form action={acceptInvitationAction}>
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="orgSlug" value={org.slug} />
          <SubmitButton pending="Joining" className="btn btn-cyan">
            Accept and join
          </SubmitButton>
        </form>
        <form action={declineInvitationAction}>
          <input type="hidden" name="token" value={token} />
          <SubmitButton pending="Declining" className="btn btn-ghost">
            Decline
          </SubmitButton>
        </form>
      </div>
    </>
  );
}
