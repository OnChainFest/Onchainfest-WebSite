import { notFound } from 'next/navigation';
import {
  orgContext,
  profileChecklist,
  publicCompetitions,
  roster,
  ROLE_LABEL,
} from '../../../_lib/org-context';
import { one, type SearchParams } from '../../../_lib/search-params';
import { COMPETITION_STATUS_LABEL } from '../../../_lib/tournament-builder';
import { tournamentsFor } from '../../../_lib/tournament-context';
import { Flash } from '../../../_product/flash';

export const metadata = { title: 'Organization · OnChainFest' };

const dateFmt = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export default async function OrgDashboard({
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
  // Organizers see every tournament (drafts included); everyone else sees the public list.
  const manages = ctx.permissions.has('ORG_MANAGE_COMPETITIONS');
  const [members, tournaments] = await Promise.all([
    roster(ctx),
    manages ? tournamentsFor(ctx) : publicCompetitions(slug),
  ]);
  const competitions = tournaments?.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    startsAt: c.startsAt,
    href: manages ? `/app/orgs/${slug}/tournaments/${c.id}` : `/competitions/${c.slug}`,
  }));
  const drafts = competitions?.filter((c) => c.status === 'DRAFT').length ?? 0;

  const active = members?.filter((m) => m.status === 'ACTIVE') ?? [];
  const pending = members?.filter((m) => m.status === 'INVITED') ?? [];
  const canSeePending = ctx.permissions.has('ORG_VIEW_PRIVATE');
  const checklist = profileChecklist(ctx.profile);
  const done = checklist.filter((c) => c.done).length;
  const pct = Math.round((done / checklist.length) * 100);
  const byRole = new Map<string, number>();
  for (const m of active) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  const canEdit = ctx.permissions.has('ORG_EDIT_PROFILE');
  const canInvite = ctx.permissions.has('ORG_INVITE_MEMBER');
  const base = `/app/orgs/${slug}`;

  const actions = [
    ...(canEdit
      ? checklist
          .filter((c) => !c.done)
          .slice(0, 3)
          .map((c) => ({ href: `${base}/profile`, label: `Add ${c.label.toLowerCase()}` }))
      : []),
    ...(canInvite && active.length <= 1
      ? [{ href: `${base}/invitations`, label: 'Invite your first member' }]
      : []),
  ];

  return (
    <>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <section className="stat-grid" aria-label="At a glance">
        <div className="stat">
          <span className="mono muted">Active members</span>
          <strong>{members === null ? '—' : active.length}</strong>
          <span className="role-bar" aria-hidden="true">
            {[...byRole.entries()].map(([role, n]) => (
              <span key={role} style={{ flexGrow: n }} data-role={role} />
            ))}
          </span>
          <span className="muted small">
            {[...byRole.entries()].map(([r, n]) => `${n} ${ROLE_LABEL[r] ?? r}`).join(' · ') ||
              'No active members'}
          </span>
        </div>
        {canSeePending ? (
          <div className="stat">
            <span className="mono muted">Pending invitations</span>
            <strong>{members === null ? '—' : pending.length}</strong>
            <a className="link mono small" href={`${base}/invitations`}>
              {pending.length === 0 ? 'Invite someone →' : 'Review →'}
            </a>
          </div>
        ) : null}
        <div className="stat">
          <span className="mono muted">Tournaments</span>
          <strong>{competitions === undefined ? '—' : competitions.length}</strong>
          {manages ? (
            <a className="link mono small" href={`${base}/tournaments`}>
              {drafts > 0 ? `${drafts} draft${drafts === 1 ? '' : 's'} · ` : ''}Open hub →
            </a>
          ) : (
            <span className="muted small">Published</span>
          )}
        </div>
        <div className="stat">
          <span className="mono muted">Public profile</span>
          <span className="ring" style={{ '--pct': pct } as Record<string, number>}>
            <strong>{pct}%</strong>
          </span>
          <span className="muted small">
            {done} of {checklist.length} details
          </span>
        </div>
      </section>

      <div className="split">
        <section aria-labelledby="t-h">
          <h2 id="t-h" className="mono muted">
            Tournaments
          </h2>
          {competitions === undefined ? (
            <p className="muted">Tournaments are unavailable right now.</p>
          ) : competitions.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>{manages ? 'No tournaments yet' : 'No published tournaments yet'}</strong>
              {manages ? (
                <a className="link mono" href={`${base}/tournaments/new`}>
                  Create your first tournament →
                </a>
              ) : (
                <p className="muted">Published tournaments appear here and on your public page.</p>
              )}
            </div>
          ) : (
            <ul className="list">
              {competitions.slice(0, 6).map((c) => (
                <li key={c.id}>
                  <span>
                    <strong>{c.name}</strong>{' '}
                    <span className="tag mono">
                      {(COMPETITION_STATUS_LABEL as Record<string, string>)[c.status] ?? c.status}
                    </span>
                  </span>
                  <a className="link mono" href={c.href}>
                    {c.startsAt ? dateFmt.format(new Date(c.startsAt)) : 'Open'} →
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="a-h">
          <h2 id="a-h" className="mono muted">
            {actions.length > 0 ? 'Next steps' : 'Members'}
          </h2>
          {actions.length > 0 ? (
            <ul className="list">
              {actions.map((a) => (
                <li key={a.label}>
                  <strong>{a.label}</strong>
                  <a className="link mono" href={a.href}>
                    Go →
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="list">
              {active.slice(0, 5).map((m) => (
                <li key={m.membershipId}>
                  <strong>{m.athlete?.displayName ?? 'Member'}</strong>
                  <span className="tag mono">{ROLE_LABEL[m.role] ?? m.role}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
