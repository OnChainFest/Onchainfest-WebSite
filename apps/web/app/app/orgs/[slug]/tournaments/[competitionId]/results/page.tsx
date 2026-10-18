import { notFound } from 'next/navigation';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { OPERATIONAL } from '../../../../../../_lib/operations';
import { orgContext } from '../../../../../../_lib/org-context';
import {
  resultAttention,
  resultEligible,
  resultMatches,
  resultsBoard,
  RESULT_STATUSES,
  type MatchScoring,
  type ResultVersion,
  type StaffOutcome,
} from '../../../../../../_lib/results';
import { contestResults, eventOutcome } from '../../../../../../_lib/results-api';
import { eventBracket } from '../../../../../../_lib/schedule';
import { eventScoring, type EventScoring } from '../../../../../../_lib/scoring';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { isStaffRole, STAFF_ROLE_LABEL } from '../../../../../../_lib/staff';
import { lockedField } from '../../../../../../_lib/structure';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { tournamentCatalog } from '../../../../../../_lib/tournaments';
import { CompetitionNav } from '../../../../../../_product/competition-hub-ui';
import { Flash } from '../../../../../../_product/flash';
import {
  CategoryOutcomePanel,
  LifecyclePanel,
  ProgressionPanel,
  ResultAttentionList,
  ResultList,
  ResultsPulse,
  type RowContext,
} from '../../../../../../_product/results-ui';
import { StatusBadge } from '../../../../../../_product/tournament-ui';
import { entryAction, transitionAction } from './actions';

export const metadata = { title: 'Tournament results · OnChainFest' };

/**
 * ONCF-L5 results workspace: recording what happened. Which matches need a result, which wait
 * to be accepted or declared official, and what is official — with each match's score entered in
 * the shape its category's ruleset records, checked by the API before it is recorded. Every
 * result is read fresh on each request and after each command; the API validates every score,
 * decides result authority (ADR-0077) and serializes every write, so a stale screen never writes.
 */
export default async function TournamentResultsPage({
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
  const zone = c.profile.timezone;
  const roles = access.staffRoles.filter(isStaffRole).map((r) => STAFF_ROLE_LABEL[r]);
  const eligible = resultEligible(access.staffRoles);
  const running = events.filter((e) => OPERATIONAL.has(e.status));

  const structures = await Promise.all(
    running.map(async (event) => {
      const [b, f, s, o] = await Promise.all([
        eventBracket(c.slug, event.slug),
        lockedField(token, event.id),
        eventScoring(token, event.id),
        // ONCF-L6: the category outcome (official results only) once play has started.
        event.status === 'FIELD_LOCKED' ? null : eventOutcome(token, event.id),
      ]);
      return {
        event,
        rounds: b.kind === 'ok' ? b.data.rounds : null,
        field: f.kind === 'ok' ? f.data.items : [],
        scoring: s.kind === 'ok' ? s.data : null,
        outcome: o === null ? undefined : o.kind === 'ok' ? o.data : null,
      };
    }),
  );
  // A stage may be scored under its own ruleset: its parameters come from the catalog.
  const overridden = structures.some(
    (s) => Object.keys(s.scoring?.stageOverrides ?? {}).length > 0,
  );
  const catalog = overridden ? await tournamentCatalog() : null;
  const rulesets = new Map(
    (catalog?.kind === 'ok' ? (catalog.data.rulesetVersions ?? []) : []).map((r) => [
      r.versionId,
      r,
    ]),
  );
  const scoringFor =
    (scoring: EventScoring | null) =>
    (stageKey: string | null): MatchScoring | null => {
      if (scoring === null || !scoring.pinned) return null;
      const override = stageKey === null ? undefined : scoring.stageOverrides?.[stageKey];
      if (override?.rulesetVersionId !== undefined) {
        const r = rulesets.get(override.rulesetVersionId);
        return r?.spec === undefined
          ? null
          : {
              family: r.family,
              parameters: (r.spec.parameters ?? {}) as Record<string, unknown>,
              name: r.name,
            };
      }
      const r = scoring.ruleset;
      return r === undefined || r === null
        ? null
        : {
            family: r.family,
            parameters: (r.spec.parameters ?? {}) as Record<string, unknown>,
            name: r.name ?? r.code,
          };
    };

  // Each match whose result matters now, read from the ledger (null: couldn't be read).
  const wanted = structures.flatMap((s) =>
    (s.rounds ?? []).flatMap((r) =>
      r.contests
        .filter((x) => RESULT_STATUSES.has(x.status) && x.slots.length > 0)
        .map((x) => x.contestId),
    ),
  );
  const versions = new Map<string, ResultVersion[] | null>(
    await Promise.all(
      wanted.map(async (id) => {
        const r = await contestResults(token, id);
        return [id, r.kind === 'ok' ? r.data.versions : null] as const;
      }),
    ),
  );
  const matches = resultMatches(
    structures.map((s) => ({
      event: s.event,
      rounds: s.rounds ?? [],
      field: s.field,
      scoringFor: scoringFor(s.scoring),
    })),
    versions,
  );
  const unreadable = structures.filter((s) => s.rounds === null).map((s) => s.event.settings.name);
  const board = resultsBoard(matches);
  const items = resultAttention(
    board,
    structures
      .filter((s) => s.scoring !== null)
      .map((s) => ({
        event: s.event,
        pinned: s.scoring?.pinned === true,
        family: s.scoring?.ruleset?.family ?? null,
      })),
  );
  const ctx: RowContext = {
    hidden: { slug, competitionId: c.id },
    eligible,
    entry: entryAction,
    transition: transitionAction,
    newKey: () => idempotencyKey(''),
    zone,
  };
  const recorded = board.official.length + board.provisional.length;

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span> <span>Results</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CompetitionNav data={t.data} base={base} current="results" />

      <header className="ops-head" data-status={c.status}>
        <div className="ops-head-id">
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">Results</h2>
          <p className="ops-context">
            <StatusBadge status={c.status} />
            <span className="muted small">Times in {zone.replaceAll('_', ' ')}</span>
          </p>
          <p className="muted small">
            {roles.length > 0 ? `${roles.join(' · ')}. ` : ''}
            {eligible
              ? 'You can enter, accept, declare official and correct results once the platform has issued you result authority for this tournament.'
              : 'You can follow results here. Owners and admins record them, under result authority the platform issues for this tournament.'}
          </p>
        </div>
      </header>

      {c.status === 'DRAFT' ? (
        <div className="empty">
          <span className="empty-mark" aria-hidden="true" />
          <strong>No results yet</strong>
          <span className="muted small">
            Results are recorded once the tournament is published and its matches are played. Finish
            its setup in the{' '}
            <a className="link" href={base}>
              overview
            </a>
            .
          </span>
        </div>
      ) : (
        <>
          {unreadable.length > 0 ? (
            <div className="state-block bad">
              <strong>Some matches can’t be loaded right now: {unreadable.join(', ')}.</strong>
              <p className="muted">Nothing was changed. Reload the page in a moment.</p>
            </div>
          ) : null}
          <ResultAttentionList items={items} />
          {running.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>No category is being played</strong>
              <span className="muted small">
                Matches show here once a category’s field is locked and play has started.{' '}
                <a className="link" href={`${base}/operations`}>
                  Go to operations →
                </a>
              </span>
            </div>
          ) : (
            <div className="tb-layout">
              <section className="tb-main ops-main" aria-label="Match results">
                {structures.some((s) => s.outcome !== undefined) ? (
                  <section id="res-outcome" className="ops-section" aria-labelledby="res-outcome-h">
                    <div className="section-head">
                      <h3 id="res-outcome-h" className="tb-h3">
                        Category outcome
                      </h3>
                    </div>
                    {structures
                      .filter((s) => s.outcome !== undefined)
                      .map((s) => {
                        const names = new Map(
                          s.field.map((p) => [
                            p.participantId,
                            p.athlete?.displayName ?? p.teamName ?? 'Private entrant',
                          ]),
                        );
                        return (
                          <CategoryOutcomePanel
                            key={s.event.id}
                            name={s.event.settings.name}
                            status={s.event.status}
                            data={(s.outcome ?? null) as StaffOutcome | null}
                            nameOf={(id) => names.get(id) ?? 'Private entrant'}
                            base={base}
                          />
                        );
                      })}
                  </section>
                ) : null}
                <ResultsPulse
                  counts={{
                    needs: board.needs.length,
                    entered: board.entered.length,
                    provisional: board.provisional.length,
                    official: board.official.length,
                  }}
                />
                <ResultList
                  id="needs"
                  title="Needs a result"
                  matches={[...board.needs, ...board.unreadable]}
                  empty={
                    matches.length === 0
                      ? 'No match has started yet. Matches appear here once they are in play.'
                      : 'Every match in play or finished has a result.'
                  }
                  ctx={ctx}
                >
                  <p className="muted small ops-note">
                    Finished matches first, then those still in play.{' '}
                    <a className="link" href={`${base}/operations`}>
                      Start and finish matches in operations →
                    </a>
                  </p>
                </ResultList>
                <ResultList
                  id="entered"
                  title="Entered · to accept"
                  matches={board.entered}
                  empty="No entered result is waiting to be accepted."
                  ctx={ctx}
                />
                <ResultList
                  id="provisional"
                  title="Provisional · to declare official"
                  matches={board.provisional}
                  empty="No provisional result is waiting."
                  ctx={ctx}
                />
                <details id="res-official" className="ops-fold">
                  <summary className="tb-h3">
                    Official <span className="tb-count">{board.official.length}</span>
                  </summary>
                  <ResultList
                    id="official-list"
                    title="Official"
                    matches={board.official}
                    empty="No result is official yet."
                    ctx={ctx}
                    headless
                  />
                </details>
              </section>

              <aside className="tb-side">
                <LifecyclePanel />
                <ProgressionPanel
                  base={base}
                  categories={
                    recorded > 0
                      ? running
                          .filter((e) => e.status !== 'FIELD_LOCKED')
                          .map((e) => ({ id: e.id, name: e.settings.name }))
                      : []
                  }
                />
              </aside>
            </div>
          )}
        </>
      )}
    </>
  );
}
