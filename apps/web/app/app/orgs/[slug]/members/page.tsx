import { notFound } from 'next/navigation';
import { assignableRoles, orgContext, roster, ROLE_LABEL } from '../../../../_lib/org-context';
import { idempotencyKey } from '../../../../_lib/onboarding-input';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { Flash } from '../../../../_product/flash';
import { changeRoleAction, memberStatusAction } from '../actions';

export const metadata = { title: 'Members · OnChainFest' };

const dateFmt = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  INVITED: 'Invited',
};

export default async function MembersPage({
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
  const members = await roster(ctx);
  const shown = (members ?? []).filter((m) => m.status === 'ACTIVE' || m.status === 'SUSPENDED');
  const roles = assignableRoles(ctx, 'CHANGE');
  const canRemove = ctx.permissions.has('ORG_REMOVE_MEMBER');
  const isOwner = ctx.roles.includes('OWNER');

  return (
    <>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <div className="section-head">
        <h2 className="mono muted">
          {shown.length} {shown.length === 1 ? 'member' : 'members'}
        </h2>
        {ctx.permissions.has('ORG_INVITE_MEMBER') ? (
          <a className="btn btn-cyan" href={`/app/orgs/${slug}/invitations`}>
            Invite member
          </a>
        ) : null}
      </div>
      {members === null ? (
        <p className="muted">Members are unavailable right now.</p>
      ) : (
        <ul className="roster">
          {shown.map((m) => {
            const self = m.personId === ctx.selfPersonId;
            const ownerRow = m.role === 'OWNER';
            const manageable = !self && (!ownerRow || isOwner);
            return (
              <li key={m.membershipId} data-status={m.status}>
                <div className="who">
                  <span className="avatar" aria-hidden="true">
                    {(m.athlete?.displayName ?? '·').slice(0, 1)}
                  </span>
                  <span>
                    <strong>
                      {m.athlete?.displayName ?? 'Member'}
                      {self ? <span className="muted"> · you</span> : null}
                    </strong>
                    <span className="muted small">
                      {m.athlete ? (
                        <a href={`/athletes/${m.athlete.slug}`}>/athletes/{m.athlete.slug}</a>
                      ) : (
                        'No public athlete profile'
                      )}
                    </span>
                  </span>
                </div>
                <span className="role-chip mono">{ROLE_LABEL[m.role] ?? m.role}</span>
                <span className={`status mono ${m.status.toLowerCase()}`}>
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
                <span className="muted small">Since {dateFmt.format(new Date(m.since))}</span>
                <div className="row-actions">
                  {manageable && roles.length > 0 && m.status === 'ACTIVE' ? (
                    <form action={changeRoleAction} className="inline-form">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="membershipId" value={m.membershipId} />
                      <input type="hidden" name="key" value={idempotencyKey('')} />
                      <label className="sr-only" htmlFor={`role-${m.membershipId}`}>
                        Role
                      </label>
                      <select id={`role-${m.membershipId}`} name="role" defaultValue={m.role}>
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r] ?? r}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-ghost btn-sm" type="submit">
                        Set
                      </button>
                    </form>
                  ) : null}
                  {manageable && canRemove ? (
                    <>
                      <form action={memberStatusAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="membershipId" value={m.membershipId} />
                        <input type="hidden" name="role" value={m.role} />
                        <input
                          type="hidden"
                          name="status"
                          value={m.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}
                        />
                        <button className="btn btn-ghost btn-sm" type="submit">
                          {m.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                        </button>
                      </form>
                      <details className="confirm">
                        <summary className="btn btn-ghost btn-sm">Remove</summary>
                        <form action={memberStatusAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="membershipId" value={m.membershipId} />
                          <input type="hidden" name="role" value={m.role} />
                          <input type="hidden" name="status" value="ENDED" />
                          <button className="btn btn-danger btn-sm" type="submit">
                            Confirm removal
                          </button>
                        </form>
                      </details>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
