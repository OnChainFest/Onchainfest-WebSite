import { notFound } from 'next/navigation';
import { assignableRoles, orgContext, roster, ROLE_LABEL } from '../../../../_lib/org-context';
import { idempotencyKey } from '../../../../_lib/onboarding-input';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { Flash } from '../../../../_product/flash';
import { InviteForm } from '../../../../_product/invite-form';
import { inviteAction, memberStatusAction } from '../actions';

export const metadata = { title: 'Invitations · OnChainFest', referrer: 'no-referrer' };

const dateFmt = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export default async function InvitationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const result = await orgContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  const canInvite = ctx.permissions.has('ORG_INVITE_MEMBER');
  const canSee = ctx.permissions.has('ORG_VIEW_PRIVATE');
  if (!canInvite && !canSee) notFound();
  const members = canSee ? await roster(ctx) : [];
  const pending = (members ?? []).filter((m) => m.status === 'INVITED');
  const canRevoke = ctx.permissions.has('ORG_REMOVE_MEMBER');
  const now = Date.now();

  return (
    <div className="split">
      <section aria-labelledby="inv-h">
        <h2 id="inv-h" className="mono muted">
          Invite a member
        </h2>
        {canInvite ? (
          <InviteForm
            slug={slug}
            roles={assignableRoles(ctx, 'INVITE')}
            initialKey={idempotencyKey('')}
            action={inviteAction}
          />
        ) : (
          <p className="muted">Your role can view invitations but not create them.</p>
        )}
      </section>
      <section aria-labelledby="pend-h">
        <h2 id="pend-h" className="mono muted">
          Pending · {pending.length}
        </h2>
        <Flash error={one(query.error)} notice={one(query.notice)} />
        {members === null ? (
          <p className="muted">Invitations are unavailable right now.</p>
        ) : pending.length === 0 ? (
          <div className="empty">
            <span className="empty-mark" aria-hidden="true" />
            <strong>No pending invitations</strong>
            <p className="muted">Invitations you create stay here until they’re answered.</p>
          </div>
        ) : (
          <ul className="list">
            {pending.map((m) => {
              const expired =
                m.invitationExpiresAt !== null && Date.parse(m.invitationExpiresAt) <= now;
              return (
                <li key={m.membershipId}>
                  <span>
                    <strong>{m.athlete?.displayName ?? 'Invited person'}</strong>{' '}
                    <span className="tag mono">{ROLE_LABEL[m.role] ?? m.role}</span>
                    <span className="muted small block">
                      {expired
                        ? 'Expired'
                        : m.invitationExpiresAt !== null
                          ? `Expires ${dateFmt.format(new Date(m.invitationExpiresAt))}`
                          : 'Awaiting answer'}
                    </span>
                  </span>
                  {canRevoke ? (
                    <form action={memberStatusAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="from" value="invitations" />
                      <input type="hidden" name="membershipId" value={m.membershipId} />
                      <input type="hidden" name="role" value={m.role} />
                      <input type="hidden" name="status" value="ENDED" />
                      <button className="btn btn-ghost btn-sm" type="submit">
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
