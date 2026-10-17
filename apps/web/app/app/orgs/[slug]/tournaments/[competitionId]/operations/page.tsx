import { notFound } from 'next/navigation';
import {
  attention,
  board,
  categoryOps,
  competitionOps,
  dayContext,
  OPERATIONAL,
  opsMatches,
  recentChanges,
  scopeText,
} from '../../../../../../_lib/operations';
import { orgContext } from '../../../../../../_lib/org-context';
import { competitionResources } from '../../../../../../_lib/resources';
import {
  currentVersions,
  eventBracket,
  scheduleVersion,
  scheduleVersions,
} from '../../../../../../_lib/schedule';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { competitionStaff, isStaffRole, STAFF_ROLE_LABEL } from '../../../../../../_lib/staff';
import { lockedField } from '../../../../../../_lib/structure';
import { instantToZoned } from '../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { CompetitionNav } from '../../../../../../_product/competition-hub-ui';
import { Flash } from '../../../../../../_product/flash';
import {
  Attention,
  Blocked,
  CategoryTable,
  MatchList,
  OpsConfirm,
  Pulse,
  RecentPanel,
  StaffPanel,
  type Hidden,
} from '../../../../../../_product/operations-ui';
import { StatusBadge } from '../../../../../../_product/tournament-ui';
import { operateAction } from './actions';

export const metadata = { title: 'Tournament operations · OnChainFest' };

/**
 * ONCF-L4 operations workspace: running the tournament on the day. What is in play, what is up
 * next on the official schedule, what is waiting and why, and the lifecycle commands the API
 * already has — tournament start/complete/cancel, category start/complete/cancel, match
 * start/finish/cancel/void — each behind a confirmation. Every state is read fresh on each request
 * and after each command (the action redirects back here); the API decides every permission and
 * transition, so a stale screen can never push a change through.
 */
export default async function TournamentOperationsPage({
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
        <p className="muted">Nothing was changed. Try again in a moment.</p>
      </div>
    );

  const { competition: c, access, events } = t.data;
  const base = `${hub}/${c.id}`;
  const token = org.ctx.accessToken;
  const hidden: Hidden = { slug, competitionId: c.id };
  const perms = access.permissions;
  const now = Date.now();
  const zone = c.profile.timezone;
  const today = instantToZoned(new Date(now).toISOString(), zone).slice(0, 10);
  const ctxDay = dayContext(c, now);
  const roles = access.staffRoles.filter(isStaffRole).map((r) => STAFF_ROLE_LABEL[r]);
  const running = events.filter((e) => OPERATIONAL.has(e.status));

  const [staff, versions, resources, structures] = await Promise.all([
    competitionStaff(token, c.id),
    scheduleVersions(token, c.id),
    competitionResources(token, c.id),
    Promise.all(
      running.map(async (event) => {
        const [b, f] = await Promise.all([
          eventBracket(c.slug, event.slug),
          lockedField(token, event.id),
        ]);
        return {
          event,
          rounds: b.kind === 'ok' ? b.data.rounds : null,
          field: f.kind === 'ok' ? f.data.items : [],
        };
      }),
    ),
  ]);
  const published = versions.kind === 'ok' ? currentVersions(versions.data.items).published : null;
  const official = published === null ? null : await scheduleVersion(token, published.versionId);
  const courts = new Map(
    (resources.kind === 'ok' ? resources.data.items : []).map((r) => [r.resourceId, r.label]),
  );
  const unreadable = structures.filter((s) => s.rounds === null).map((s) => s.event.settings.name);
  const matches = opsMatches(
    structures.map((s) => ({ ...s, rounds: s.rounds ?? [] })),
    official?.kind === 'ok' ? official.data.assignments : [],
    courts,
  );
  const planned = new Set(
    structures
      .filter((s) => (s.rounds ?? []).some((r) => r.contests.length > 0))
      .map((s) => s.event.id),
  );
  const day = board(matches);
  const cats = categoryOps(t.data, base, matches, planned);
  const tournament = competitionOps(t.data);
  const items = attention(t.data, cats, day, now);
  const closed = c.status === 'COMPLETED' || c.status === 'CANCELLED';

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span>{' '}
        <span>Operations</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CompetitionNav data={t.data} base={base} current="operations" />

      <header className="ops-head" data-status={c.status}>
        <div className="ops-head-id">
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">Operations</h2>
          <p className="ops-context">
            <StatusBadge status={c.status} />
            {ctxDay.today !== '' ? (
              <span className="small">
                Today {ctxDay.today}
                {ctxDay.day !== null ? ` · ${ctxDay.day}` : ''}
              </span>
            ) : null}
            <span className="muted small">Times in {zone.replaceAll('_', ' ')}</span>
          </p>
          <p className="muted small">
            {roles.length > 0 ? `${roles.join(' · ')}. ` : ''}
            {scopeText(perms)}
          </p>
        </div>
        <div id="ops-lifecycle" className="ops-head-act" aria-label="Tournament">
          {tournament.operations
            .filter((o) => o.tone !== 'danger')
            .map((o) => (
              <OpsConfirm
                key={o.command}
                op={o}
                action={operateAction}
                hidden={hidden}
                targetId={c.id}
                from={c.status}
                name={<>{c.profile.name}</>}
              />
            ))}
          {tournament.blocked !== null ? (
            <Blocked label={tournament.blocked.label} reason={tournament.blocked.reason} />
          ) : null}
          {tournament.operations
            .filter((o) => o.tone === 'danger')
            .map((o) => (
              <OpsConfirm
                key={o.command}
                op={o}
                action={operateAction}
                hidden={hidden}
                targetId={c.id}
                from={c.status}
                name={<>{c.profile.name}</>}
                compact
              />
            ))}
        </div>
      </header>

      {c.status === 'DRAFT' ? (
        <div className="empty">
          <span className="empty-mark" aria-hidden="true" />
          <strong>Not running yet</strong>
          <span className="muted small">
            Operations start once the tournament is published. Finish its setup in the{' '}
            <a className="link" href={base}>
              overview
            </a>
            .
          </span>
        </div>
      ) : (
        <>
          {closed ? (
            <p className="ops-closed small" role="status">
              This tournament is {c.status === 'COMPLETED' ? 'completed' : 'cancelled'}. Nothing
              here can change any more; the lists below are its record.
            </p>
          ) : null}
          {unreadable.length > 0 ? (
            <div className="state-block bad">
              <strong>Some matches can’t be loaded right now: {unreadable.join(', ')}.</strong>
              <p className="muted">Nothing was changed. Reload the page in a moment.</p>
            </div>
          ) : null}
          <Attention items={items} />
          {running.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>No category is ready to run</strong>
              <span className="muted small">
                Matches show here once a category’s field is locked and its matches are generated.{' '}
                <a className="link" href={`${base}#categories`}>
                  Go to the categories →
                </a>
              </span>
            </div>
          ) : (
            <div className="tb-layout">
              <section className="tb-main ops-main" aria-label="Matches and categories">
                <Pulse
                  live={day.live.length}
                  next={day.next.length}
                  unscheduled={day.unscheduled.length}
                  done={day.done.length}
                  total={matches.length}
                />
                <MatchList
                  id="live"
                  title="In play"
                  matches={day.live}
                  permissions={perms}
                  action={operateAction}
                  hidden={hidden}
                  today={today}
                  empty="No match is in play right now."
                />
                <MatchList
                  id="next"
                  title="Up next"
                  matches={day.next}
                  permissions={perms}
                  action={operateAction}
                  hidden={hidden}
                  today={today}
                  empty={
                    published === null
                      ? 'No schedule is published yet: matches are ready to start once they’re on the official schedule.'
                      : 'Nothing else is scheduled.'
                  }
                >
                  {published === null && day.unscheduled.length > 0 ? (
                    <p className="small ops-note">
                      Matches can only start once they’re on the official schedule.{' '}
                      <a className="link" href={`${base}/schedule`}>
                        Open the schedule →
                      </a>
                    </p>
                  ) : null}
                </MatchList>

                <section id="ops-cats" className="ops-section" aria-labelledby="ops-cats-h">
                  <div className="section-head">
                    <h3 id="ops-cats-h" className="tb-h3">
                      Categories <span className="tb-count">{cats.length}</span>
                    </h3>
                  </div>
                  <CategoryTable
                    categories={cats}
                    action={operateAction}
                    hidden={hidden}
                    base={base}
                  />
                  {events.length > running.length ? (
                    <p className="muted small">
                      {events.length - running.length} other{' '}
                      {events.length - running.length === 1 ? 'category is' : 'categories are'}{' '}
                      still in setup or cancelled — see the{' '}
                      <a className="link" href={`${base}#categories`}>
                        overview
                      </a>
                      .
                    </p>
                  ) : null}
                </section>

                <details id="ops-unscheduled" className="ops-fold">
                  <summary className="tb-h3">
                    Not on the schedule <span className="tb-count">{day.unscheduled.length}</span>
                  </summary>
                  <MatchList
                    id="unscheduled-list"
                    title="Not on the schedule"
                    matches={day.unscheduled}
                    permissions={perms}
                    action={operateAction}
                    hidden={hidden}
                    today={today}
                    empty="Every match has a time on the official schedule."
                    headless
                  >
                    <p className="muted small">
                      These need a court and a time before they can start.{' '}
                      <a className="link" href={`${base}/schedule`}>
                        Open the schedule →
                      </a>
                    </p>
                  </MatchList>
                </details>
                <details id="ops-done" className="ops-fold">
                  <summary className="tb-h3">
                    Done <span className="tb-count">{day.done.length}</span>
                  </summary>
                  <MatchList
                    id="done-list"
                    title="Done"
                    matches={day.done}
                    permissions={perms}
                    action={operateAction}
                    hidden={hidden}
                    today={today}
                    empty="No match has finished yet."
                    headless
                  >
                    <p className="muted small">
                      Finished, cancelled and void matches. A finished match records no result —
                      results come separately.
                    </p>
                  </MatchList>
                </details>
              </section>

              <aside className="tb-side">
                <StaffPanel
                  staff={staff.kind === 'ok' ? staff.data.items : null}
                  staffHref={`${base}/staff`}
                />
                <RecentPanel items={recentChanges(t.data)} zone={zone} />
                <section className="tb-panel" aria-labelledby="ops-how-h">
                  <h3 id="ops-how-h" className="mono muted">
                    How a match runs
                  </h3>
                  <ol className="sch-steps">
                    <li>
                      <strong>Scheduled</strong>
                      <span className="muted small">
                        On the official schedule. Starts once its category is in play and both sides
                        are known.
                      </span>
                    </li>
                    <li>
                      <strong>In play</strong>
                      <span className="muted small">Started on court.</span>
                    </li>
                    <li>
                      <strong>Finished</strong>
                      <span className="muted small">
                        Play ended. No score is recorded here — results come separately.
                      </span>
                    </li>
                  </ol>
                  <p className="muted small">
                    If two staff act on the same match, the first change wins; the other sees why
                    and the page shows the current state.
                  </p>
                </section>
              </aside>
            </div>
          )}
        </>
      )}
    </>
  );
}
