import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../_lib/org-context';
import {
  addDays,
  competitionAvailability,
  competitionResources,
  dayStart,
  effectiveAvailability,
} from '../../../../../../_lib/resources';
import {
  canManageSchedule,
  categoryReadiness,
  currentVersions,
  eventBracket,
  fromAssignment,
  fromPlacement,
  laneDays,
  matchIndex,
  previewProposal,
  profileResourceTypes,
  SCHEDULABLE,
  scheduleClosed,
  scheduleDays,
  scheduleVersion,
  scheduleVersions,
  validateVersion,
  zonesOf,
  type ScheduleRow,
} from '../../../../../../_lib/schedule';
import { eventScoring } from '../../../../../../_lib/scoring';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { lockedField, readiness } from '../../../../../../_lib/structure';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { CompetitionNav } from '../../../../../../_product/competition-hub-ui';
import { Flash } from '../../../../../../_product/flash';
import {
  Agenda,
  CommitForm,
  ConflictList,
  DiscardForm,
  GenerateForm,
  Lanes,
  OpenDraftForm,
  ProposalVerdict,
  PublishForm,
  ScheduleState,
  SchedulingReadiness,
  Unscheduled,
  UnplacedList,
  type Hidden,
  type RowContext,
  type RowState,
} from '../../../../../../_product/schedule-ui';
import {
  commitProposalAction,
  discardAction,
  generateAction,
  openDraftAction,
  publishAction,
} from './actions';

export const metadata = { title: 'Tournament schedule · OnChainFest' };

/** Lanes are drawn for at most this many days (the agenda lists every day). */
const LANE_DAYS = 14;

/**
 * ONCF-L3 scheduling workspace over the ONCF-05E-C/D/E/F API. Readiness per category (what the
 * proposal needs), the schedule's state (one private DRAFT, one official PUBLISHED version), the
 * draft or official schedule by day and court, the draft's conflict report, and the read-only
 * proposal preview with its commit. Changes need COMP_MANAGE_SCHEDULE (owner, admin, scheduler) on
 * an open tournament; the API checks again, recomputes every proposal and judges every conflict.
 */
export default async function TournamentSchedulePage({
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

  const { competition: c, access, events } = t.data;
  const base = `${hub}/${c.id}`;
  const token = org.ctx.accessToken;
  const manage = canManageSchedule(access.permissions) && !scheduleClosed(c.status);
  const hidden: Hidden = { slug, competitionId: c.id };
  const live = events.filter((e) => e.status !== 'CANCELLED' && e.status !== 'COMPLETED');
  const schedulable = events.filter((e) => SCHEDULABLE.has(e.status));

  const head = (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span> <span>Schedule</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CompetitionNav data={t.data} base={base} current="schedule" />
      <header className="rg-console-head">
        <div>
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">Schedule</h2>
          <p className="muted small">Which match is played where, and when.</p>
        </div>
      </header>
    </>
  );

  const [versions, resources, facts, inputs] = await Promise.all([
    scheduleVersions(token, c.id),
    competitionResources(token, c.id),
    competitionAvailability(token, c.id),
    Promise.all(
      live.map(async (e) => {
        const [s, r] = await Promise.all([eventScoring(token, e.id), readiness(token, e.id)]);
        return [
          e.id,
          { scoring: s.kind === 'ok' ? s.data : null, structure: r.kind === 'ok' ? r.data : null },
        ] as const;
      }),
    ),
  ]);

  if (versions.kind !== 'ok')
    return (
      <>
        {head}
        <div className="state-block bad">
          <strong>The schedule can’t be loaded right now.</strong>
          <p className="muted">
            Nothing was changed. Try again in a moment, or go back to the{' '}
            <a href={base}>tournament overview</a>.
          </p>
        </div>
      </>
    );

  const allResources = resources.kind === 'ok' ? resources.data.items : null;
  const allFacts = facts.kind === 'ok' ? facts.data.items : null;
  const categories = categoryReadiness(t.data, base, new Map(inputs), allResources, allFacts);
  const { draft, published } = currentVersions(versions.data.items);
  const viewing =
    one(query.view) === 'published' && published !== null ? published : (draft ?? published);
  const scopeParam = one(query.review);
  const reviewScope: string | null =
    scopeParam !== undefined &&
    (scopeParam === 'all' || schedulable.some((e) => e.id === scopeParam))
      ? scopeParam
      : null;

  // The version shown, its conflicts (drafts, for those who can act on them), and the proposal.
  const [detail, validation, preview, structures] = await Promise.all([
    viewing === null ? null : scheduleVersion(token, viewing.versionId),
    manage && viewing !== null && viewing.status === 'DRAFT'
      ? validateVersion(token, viewing.versionId)
      : null,
    manage && draft !== null && reviewScope !== null
      ? previewProposal(token, draft.versionId, reviewScope === 'all' ? null : [reviewScope])
      : null,
    Promise.all(
      schedulable.map(async (event) => {
        const [b, f] = await Promise.all([
          eventBracket(c.slug, event.slug),
          lockedField(token, event.id),
        ]);
        return {
          event,
          rounds: b.kind === 'ok' ? b.data.rounds : [],
          field: f.kind === 'ok' ? f.data.items : [],
        };
      }),
    ),
  ]);
  const matches = matchIndex(structures);
  const courts = new Map((allResources ?? []).map((r) => [r.resourceId, r.label]));

  const rows = detail?.kind === 'ok' ? detail.data.assignments.map(fromAssignment) : [];
  const proposal = preview?.kind === 'ok' ? preview.data.proposal : null;
  const proposedRows = proposal?.placements.map(fromPlacement) ?? [];
  const report = validation?.kind === 'ok' ? validation.data : null;

  // Courts drawn in the lanes: the kinds the categories' profiles use, plus any court in use.
  const neededTypes = new Set(categories.flatMap((x) => profileResourceTypes(x.profile)));
  const laneCourts = (allResources ?? []).filter(
    (r) => r.status === 'ACTIVE' && neededTypes.has(r.typeCode),
  );
  const visibleDays = scheduleDays([...rows, ...proposedRows]);
  const first = visibleDays[0]?.date;
  const last = visibleDays.at(-1)?.date;
  const zone = [...rows, ...proposedRows][0]?.zone ?? c.profile.timezone;
  const open = new Map<string, { start: string; end: string }[]>();
  if (first !== undefined && last !== undefined) {
    const from = dayStart(first, zone);
    const to = dayStart(addDays(last, 1), zone);
    const ids = new Set([
      ...laneCourts.map((r) => r.resourceId),
      ...[...rows, ...proposedRows].flatMap((r) => (r.resourceId === null ? [] : [r.resourceId])),
    ]);
    if (from !== null && to !== null && visibleDays.length <= LANE_DAYS)
      await Promise.all(
        [...ids].map(async (id) => {
          const e = await effectiveAvailability(token, id, from, to);
          if (e.kind === 'ok') open.set(id, e.data.intervals);
        }),
      );
  }

  const hardContests = new Set(
    (report?.conflicts ?? []).filter((x) => x.severity === 'HARD').flatMap((x) => x.contestIds),
  );
  const softContests = new Set(
    (report?.conflicts ?? []).filter((x) => x.severity === 'SOFT').flatMap((x) => x.contestIds),
  );
  // Proposed matches are never already placed (the proposal only places matches without a time).
  const proposedIds = new Set(proposedRows.map((r) => r.contestId));
  const rowCtx = (fallback: RowState): RowContext => ({
    matches,
    courts,
    showZone: zonesOf([...rows, ...proposedRows]).length > 1,
    stateOf: (r: ScheduleRow) =>
      proposedIds.has(r.contestId)
        ? 'proposed'
        : hardContests.has(r.contestId)
          ? 'conflict'
          : softContests.has(r.contestId)
            ? 'warning'
            : fallback,
  });

  const placed = new Set([...rows.map((r) => r.contestId)]);
  // Matches still without a time (those the open proposal would place are listed there instead).
  const waiting = [...matches.values()].filter(
    (m) => m.status === 'PLANNED' && !placed.has(m.contestId) && !proposedIds.has(m.contestId),
  );
  const isDraft = viewing?.status === 'DRAFT';
  const showingPublished = viewing !== null && viewing.status === 'PUBLISHED';
  const categoryChoices = schedulable.map((e) => ({ id: e.id, name: e.settings.name }));
  const warnings = (report?.conflicts ?? [])
    .filter((x) => x.severity === 'SOFT')
    .map((x) => x.conflictKey);

  return (
    <>
      {head}
      <SchedulingReadiness categories={categories} />
      <ScheduleState
        draft={draft}
        published={published}
        draftCount={draft !== null && viewing?.versionId === draft.versionId ? rows.length : null}
      />

      <div className="tb-layout">
        <section aria-labelledby="sch-h" className="tb-main sch-main">
          {reviewScope !== null && draft !== null && manage ? (
            <section id="proposal" className="sch-proposal" aria-labelledby="prop-h">
              <div className="section-head">
                <h3 id="prop-h" className="tb-h3">
                  Proposal
                  <span className="sch-chip" data-state="proposed">
                    Not saved
                  </span>
                </h3>
                <a className="btn btn-ghost btn-sm" href={`${base}/schedule`}>
                  Close proposal
                </a>
              </div>
              {preview === null || preview.kind !== 'ok' ? (
                <div className="state-block bad">
                  <strong>The proposal couldn’t be generated right now.</strong>
                  <p className="muted">
                    {preview?.kind === 'error' && preview.code === 'INVALID_TRANSITION'
                      ? 'The draft is no longer open. Reload the page and generate again.'
                      : 'Nothing was changed. Try again in a moment.'}
                  </p>
                </div>
              ) : (
                <>
                  <ProposalVerdict proposal={preview.data.proposal} />
                  {preview.data.proposal.unplaced.length > 0 ? (
                    <UnplacedList unplaced={preview.data.proposal.unplaced} ctx={rowCtx('draft')} />
                  ) : null}
                  {proposedRows.length > 0 ? (
                    <>
                      <Lanes
                        days={laneDays(
                          scheduleDays([...(isDraft ? rows : []), ...proposedRows]),
                          laneCourts,
                          open,
                        )}
                        ctx={rowCtx('draft')}
                      />
                      <Agenda
                        days={scheduleDays(proposedRows)}
                        ctx={rowCtx('draft')}
                        label="Proposed matches"
                      />
                    </>
                  ) : null}
                  {preview.data.proposal.status === 'SUCCESS' ? (
                    <CommitForm
                      hidden={hidden}
                      action={commitProposalAction}
                      versionId={draft.versionId}
                      proposal={preview.data.proposal}
                      scope={reviewScope}
                    />
                  ) : (
                    <p className="muted small">
                      This proposal can’t be committed. Fix what’s listed above — courts, hours,
                      dates or the category setup — then generate it again.
                    </p>
                  )}
                </>
              )}
            </section>
          ) : null}

          <div className="section-head">
            <h3 id="sch-h" className="tb-h3">
              {viewing === null
                ? 'Schedule'
                : isDraft
                  ? `Draft · version ${viewing.versionNumber}`
                  : `Official schedule · version ${viewing.versionNumber}`}
              {viewing !== null ? (
                <span className="sch-chip" data-state={isDraft ? 'draft' : 'official'}>
                  {isDraft ? 'Not published' : 'Published'}
                </span>
              ) : null}
            </h3>
            {draft !== null && published !== null ? (
              <nav className="sch-tabs" aria-label="Schedule version">
                <a href={`${base}/schedule`} aria-current={isDraft ? 'page' : undefined}>
                  Draft
                </a>
                <a
                  href={`${base}/schedule?view=published`}
                  aria-current={showingPublished ? 'page' : undefined}
                >
                  Official
                </a>
              </nav>
            ) : null}
          </div>

          {viewing === null ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>No schedule yet</strong>
              <span className="muted small">
                {schedulable.length === 0
                  ? 'Matches are scheduled once a category’s field is locked and its matches are generated.'
                  : manage
                    ? 'Generate a proposal: the system places every match on a court and a time, and you review it before anything is saved.'
                    : 'The organizers haven’t started the schedule yet.'}
              </span>
            </div>
          ) : detail === null || detail.kind !== 'ok' ? (
            <div className="state-block bad">
              <strong>This schedule version can’t be loaded right now.</strong>
              <p className="muted">Nothing was changed. Try again in a moment.</p>
            </div>
          ) : (
            <>
              {isDraft ? (
                <p className="muted small">
                  Only staff see the draft. The official schedule
                  {published !== null ? ` (version ${published.versionNumber})` : ''} doesn’t change
                  until you publish.
                </p>
              ) : (
                <p className="muted small">
                  This is the schedule players and the public see.
                  {draft !== null ? ' A draft with changes is open.' : ''}
                </p>
              )}
              {isDraft && manage && rows.length > 0 ? (
                validation?.kind === 'ok' ? (
                  validation.data.conflicts.length === 0 ? (
                    <div className="sch-verdict" data-tone="ok" role="status">
                      <strong>No conflicts</strong>
                      <span>The draft passes every check publishing makes.</span>
                    </div>
                  ) : (
                    <ConflictList conflicts={validation.data.conflicts} ctx={rowCtx('draft')} />
                  )
                ) : (
                  <div className="state-block bad">
                    <strong>The draft couldn’t be checked right now.</strong>
                    <p className="muted">It can’t be published until it is. Reload to try again.</p>
                  </div>
                )
              ) : null}
              {rows.length === 0 ? (
                <div className="empty">
                  <span className="empty-mark" aria-hidden="true" />
                  <strong>No matches placed in this version</strong>
                  <span className="muted small">
                    {isDraft && manage
                      ? 'Generate a proposal and commit it to fill the draft.'
                      : 'Nothing has a time yet.'}
                  </span>
                </div>
              ) : (
                <>
                  <Lanes
                    days={laneDays(scheduleDays(rows), laneCourts, open)}
                    ctx={rowCtx(isDraft ? 'draft' : 'official')}
                  />
                  <Agenda
                    days={scheduleDays(rows)}
                    ctx={rowCtx(isDraft ? 'draft' : 'official')}
                    label={isDraft ? 'Draft schedule' : 'Official schedule'}
                  />
                </>
              )}
              {isDraft && manage && viewing !== null ? (
                <div className="sch-actions">
                  {report !== null && report.hardConflicts === 0 && rows.length > 0 ? (
                    <PublishForm
                      hidden={hidden}
                      action={publishAction}
                      versionId={viewing.versionId}
                      baseVersionId={viewing.baseVersionId}
                      reportHash={report.reportHash}
                      warnings={warnings}
                      replacing={published?.versionNumber ?? null}
                    />
                  ) : report !== null && report.hardConflicts > 0 ? (
                    <p className="small sch-blocked">
                      Publishing is blocked until the conflicts above are fixed. Discard the draft
                      and generate a new proposal once the courts, hours or category setup allow it.
                    </p>
                  ) : null}
                  <DiscardForm
                    hidden={hidden}
                    action={discardAction}
                    versionId={viewing.versionId}
                  />
                </div>
              ) : null}
            </>
          )}

          {waiting.length > 0 && !showingPublished ? (
            <Unscheduled matches={waiting}>
              <p className="muted small">
                Matches still to place{draft !== null ? ' in the draft' : ''}. Generate a proposal
                to find them a court and a time.
              </p>
            </Unscheduled>
          ) : null}
        </section>

        <aside className="tb-side">
          {manage ? (
            <section id="generate" aria-labelledby="gen-h" className="tb-panel">
              <h3 id="gen-h" className="mono muted">
                Generate a proposal
              </h3>
              {schedulable.length === 0 ? (
                <p className="muted small">
                  No category can be scheduled yet: lock a category’s field and generate its matches
                  first.
                </p>
              ) : (
                <>
                  <p className="muted small">
                    Places every match without a time on a free court within its category’s dates
                    and the courts’ declared hours. You review it before anything is saved.
                    {draft === null
                      ? published !== null
                        ? ' A new draft is opened from the official schedule.'
                        : ' A draft is opened to hold it.'
                      : ''}
                  </p>
                  <GenerateForm
                    hidden={hidden}
                    action={generateAction}
                    categories={categoryChoices}
                    current={reviewScope ?? 'all'}
                    submit={reviewScope !== null ? 'Generate again' : 'Generate proposal'}
                  />
                </>
              )}
              {draft === null && published !== null ? (
                <>
                  <p className="muted small">
                    Or open a draft of the official schedule without generating anything.
                  </p>
                  <OpenDraftForm hidden={hidden} action={openDraftAction} />
                </>
              ) : null}
            </section>
          ) : (
            <section className="tb-panel">
              <h3 className="mono muted">View only</h3>
              <p className="muted small">
                {scheduleClosed(c.status)
                  ? 'This tournament has ended, so its schedule can’t change.'
                  : 'Only a tournament owner, admin or scheduler can generate, commit or publish the schedule.'}
              </p>
            </section>
          )}

          <section aria-labelledby="how-h" className="tb-panel">
            <h3 id="how-h" className="mono muted">
              How scheduling works
            </h3>
            <ol className="sch-steps">
              <li>
                <strong>Generate</strong>
                <span className="muted small">
                  A proposal places matches on courts and times. Nothing is saved.
                </span>
              </li>
              <li>
                <strong>Commit</strong>
                <span className="muted small">
                  A proposal where every match fits is added to the private draft.
                </span>
              </li>
              <li>
                <strong>Check</strong>
                <span className="muted small">
                  The draft is checked for conflicts. Conflicts block publishing; warnings need your
                  confirmation.
                </span>
              </li>
              <li>
                <strong>Publish</strong>
                <span className="muted small">
                  The draft becomes the official schedule players and the public see.
                </span>
              </li>
            </ol>
            <p className="muted small">
              Times are shown in each category’s time zone ({c.profile.timezone} unless a category
              sets its own).
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
