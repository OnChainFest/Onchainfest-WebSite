import { notFound } from 'next/navigation';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { orgContext, roster, ROLE_LABEL } from '../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import {
  canManageStaff,
  competitionStaff,
  organizerStaff,
  STAFF_ROLE_DUTY,
  STAFF_ROLE_LABEL,
  STAFF_ROLES,
  staffCandidates,
} from '../../../../../../_lib/staff';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { CompetitionNav } from '../../../../../../_product/competition-hub-ui';
import { Flash } from '../../../../../../_product/flash';
import { SubmitButton } from '../../../../../../_product/submit-button';
import { addStaffAction, removeStaffAction } from './actions';

export const metadata = { title: 'Tournament staff · OnChainFest' };

const dateFmt = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * ONCF-L1 tournament staff. The list is GET /v1/competitions/:id/staff (COMP_VIEW_PRIVATE); add and
 * remove are offered only with COMP_MANAGE_STAFF from the caller's competition permissions, and the
 * API checks it again. People are picked from the organization roster (the existing identity
 * surface); the API accepts a person id only.
 */
export default async function TournamentStaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId }, query] = await Promise.all([params, searchParams]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const t = await tournamentFor(org.ctx, competitionId);
  if (t.kind === 'not_found') notFound();
  const hub = `/app/orgs/${slug}/tournaments`;
  if (t.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <strong>This tournament can’t be loaded right now.</strong>
        <p className="muted">Nothing was lost. Try again in a moment.</p>
      </div>
    );

  const { competition: c, access } = t.data;
  const base = `${hub}/${c.id}`;
  const [staff, members] = await Promise.all([
    competitionStaff(org.ctx.accessToken, c.id),
    roster(org.ctx),
  ]);
  const manage = canManageStaff(access.permissions);
  const candidates = members === null ? [] : staffCandidates(members);
  const organizers = members === null ? [] : organizerStaff(members);
  const hidden = { slug, competitionId: c.id };

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span> <span>Staff</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CompetitionNav data={t.data} base={base} current="staff" />
      <header className="rg-console-head">
        <div>
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">Staff</h2>
        </div>
      </header>

      <div className="tb-layout">
        <section aria-labelledby="staff-h" className="tb-main">
          <h3 id="staff-h" className="tb-h3">
            Tournament staff{' '}
            {staff.kind === 'ok' ? (
              <span className="tb-count">{staff.data.items.length}</span>
            ) : null}
          </h3>
          {staff.kind !== 'ok' ? (
            <div className="state-block bad">
              <strong>Staff can’t be loaded right now.</strong>
              <p className="muted">Nothing was changed. Try again in a moment.</p>
            </div>
          ) : staff.data.items.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>No staff assigned yet</strong>
              <span className="muted small">
                Organization owners and admins already run this tournament.
                {manage ? ' Add people below to delegate registration or scheduling.' : ''}
              </span>
            </div>
          ) : (
            <ul className="roster staff-list">
              {staff.data.items.map((s) => {
                const self = s.personId === org.ctx.selfPersonId;
                const name = s.athlete?.displayName ?? 'Person without a public profile';
                return (
                  <li key={s.staffId} data-role={s.role}>
                    <div className="who">
                      <span className="avatar" aria-hidden="true">
                        {(s.athlete?.displayName ?? '·').slice(0, 1)}
                      </span>
                      <span>
                        <strong>
                          {name}
                          {self ? <span className="muted"> · you</span> : null}
                        </strong>
                        <span className="muted small">
                          {s.athlete !== null ? (
                            <a href={`/athletes/${s.athlete.slug}`}>/athletes/{s.athlete.slug}</a>
                          ) : (
                            'No public athlete profile'
                          )}
                        </span>
                      </span>
                    </div>
                    <span className="role-chip mono">{STAFF_ROLE_LABEL[s.role] ?? s.role}</span>
                    <span className="muted small">{STAFF_ROLE_DUTY[s.role]?.summary}</span>
                    <span className="muted small">Since {dateFmt.format(new Date(s.since))}</span>
                    <div className="row-actions">
                      {manage ? (
                        <details className="confirm">
                          <summary className="btn btn-ghost btn-sm">Remove</summary>
                          <form action={removeStaffAction} className="staff-confirm">
                            <input type="hidden" name="slug" value={hidden.slug} />
                            <input
                              type="hidden"
                              name="competitionId"
                              value={hidden.competitionId}
                            />
                            <input type="hidden" name="staffId" value={s.staffId} />
                            <span className="small">
                              {self
                                ? `Remove your own ${STAFF_ROLE_LABEL[s.role]} role? You lose the access it gives you.`
                                : `Remove ${name} as ${STAFF_ROLE_LABEL[s.role]}?`}
                            </span>
                            <button className="btn btn-danger btn-sm" type="submit">
                              Confirm removal
                            </button>
                          </form>
                        </details>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="tb-h3 staff-sub">Through the organization</h3>
          {members === null ? (
            <p className="muted small">The organization roster is unavailable right now.</p>
          ) : (
            <>
              <p className="muted small">
                Active organization owners and admins act as tournament owners and admins. Change
                that on the organization’s <a href={`/app/orgs/${slug}/members`}>Members</a> page.
              </p>
              <ul className="roster staff-list">
                {organizers.map((m) => (
                  <li key={m.membershipId}>
                    <div className="who">
                      <span className="avatar" aria-hidden="true">
                        {(m.athlete?.displayName ?? '·').slice(0, 1)}
                      </span>
                      <span>
                        <strong>
                          {m.athlete?.displayName ?? 'Member'}
                          {m.personId === org.ctx.selfPersonId ? (
                            <span className="muted"> · you</span>
                          ) : null}
                        </strong>
                        <span className="muted small">
                          Organization {ROLE_LABEL[m.role] ?? m.role}
                        </span>
                      </span>
                    </div>
                    <span className="role-chip mono">
                      {m.role === 'OWNER' ? STAFF_ROLE_LABEL.OWNER : STAFF_ROLE_LABEL.ADMIN}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="tb-side">
          {manage ? (
            <section aria-labelledby="add-h" className="tb-panel staff-add">
              <h3 id="add-h" className="mono muted">
                Add staff
              </h3>
              {members === null ? (
                <p className="muted small">
                  The organization roster is unavailable, so no one can be picked right now.
                </p>
              ) : candidates.length === 0 ? (
                <p className="muted small">
                  Staff are picked from your organization’s active members.{' '}
                  <a href={`/app/orgs/${slug}/invitations`}>Invite someone</a> first.
                </p>
              ) : (
                <form action={addStaffAction} className="tb-form">
                  <input type="hidden" name="slug" value={hidden.slug} />
                  <input type="hidden" name="competitionId" value={hidden.competitionId} />
                  <input type="hidden" name="key" value={idempotencyKey('')} />
                  <label className="field">
                    <span>Person</span>
                    <select name="personId" required defaultValue="">
                      <option value="" disabled>
                        Choose a member
                      </option>
                      {candidates.map((m) => (
                        <option key={m.personId} value={m.personId}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <small>Only active members of this organization can be picked.</small>
                  </label>
                  <label className="field">
                    <span>Role</span>
                    <select name="role" required defaultValue="REGISTRATION_MANAGER">
                      {STAFF_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {STAFF_ROLE_LABEL[r]} — {STAFF_ROLE_DUTY[r].summary}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton pending="Adding">Add to staff</SubmitButton>
                </form>
              )}
            </section>
          ) : (
            <section className="tb-panel">
              <h3 className="mono muted">View only</h3>
              <p className="muted small">Only a tournament owner can add or remove staff.</p>
            </section>
          )}

          <section aria-labelledby="roles-h" className="tb-panel">
            <h3 id="roles-h" className="mono muted">
              Roles
            </h3>
            <dl className="staff-roles">
              {STAFF_ROLES.map((r) => (
                <div key={r}>
                  <dt>
                    {STAFF_ROLE_LABEL[r]}
                    <span className="muted small"> · {STAFF_ROLE_DUTY[r].summary}</span>
                  </dt>
                  <dd className="muted small">{STAFF_ROLE_DUTY[r].detail}</dd>
                </div>
              ))}
            </dl>
            <p className="muted small">
              Roles are operational only — they never make anyone an official or confirm results.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
