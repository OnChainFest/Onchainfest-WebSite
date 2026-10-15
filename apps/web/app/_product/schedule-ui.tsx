import type { CSSProperties, ReactNode } from 'react';
import { idempotencyKey } from '../_lib/onboarding-input';
import {
  conflictText,
  PROPOSAL_STATUS,
  timeText,
  unplacedText,
  type CategoryReadiness,
  type ConflictView,
  type LaneDay,
  type MatchInfo,
  type Proposal,
  type ScheduleDay,
  type ScheduleRow,
  type ScheduleVersion,
  type Unplaced,
} from '../_lib/schedule';
import { SubmitButton } from './submit-button';

/**
 * ONCF-L3 scheduling workspace pieces. Server-rendered and presentation only: every state, time and
 * conflict comes from the API; forms carry only what the commands need (a hash, a scope, a reason)
 * plus a fresh idempotency key, and the submit button disables itself while a command is pending.
 */

export type Hidden = { slug: string; competitionId: string };
type Action = (form: FormData) => Promise<never>;

function HiddenFields({ hidden }: { hidden: Hidden }) {
  return (
    <>
      <input type="hidden" name="slug" value={hidden.slug} />
      <input type="hidden" name="competitionId" value={hidden.competitionId} />
      <input type="hidden" name="key" value={idempotencyKey('')} />
    </>
  );
}

// ───────────────────────────── readiness ─────────────────────────────

const CHECK_MARK = { ok: '✓', todo: '!', blocked: '✕' } as const;
const CATEGORY_STATE = {
  complete: 'Inputs in place',
  incomplete: 'Needs setup',
  blocked: 'Can’t be scheduled',
} as const;

/**
 * What each category still needs before a proposal can place its matches. "Inputs in place" is not
 * "ready": whether everything fits is only known from a proposal, and the panel says so.
 */
export function SchedulingReadiness({ categories }: { categories: readonly CategoryReadiness[] }) {
  const complete = categories.filter((c) => c.state === 'complete').length;
  const state =
    categories.length > 0 && complete === categories.length
      ? 'ready'
      : categories.some((c) => c.state === 'blocked')
        ? 'blocked'
        : 'todo';
  return (
    <section className="res-summary sch-readiness" data-state={state} aria-labelledby="sr-h">
      <h3 id="sr-h" className="mono muted">
        Scheduling readiness
      </h3>
      {categories.length === 0 ? (
        <strong>No categories to schedule</strong>
      ) : (
        <strong>
          {complete} of {categories.length}{' '}
          {categories.length === 1 ? 'category has' : 'categories have'} everything scheduling needs
        </strong>
      )}
      <p className="muted small">
        A proposal shows whether every match fits — these checks only cover what it needs to try.
      </p>
      <ul className="sch-cats">
        {categories.map((c) => (
          <li key={c.event.id} data-state={c.state}>
            <div className="sch-cat-head">
              <strong>{c.event.settings.name}</strong>
              <span className="sch-chip" data-state={c.state}>
                {CATEGORY_STATE[c.state]}
              </span>
            </div>
            <ul className="sch-checks">
              {c.checks.map((k) => (
                <li key={k.key} data-state={k.state}>
                  <span className="sch-mark" aria-hidden="true">
                    {CHECK_MARK[k.state]}
                  </span>
                  <span>
                    <span className="sr-only">
                      {k.state === 'ok' ? 'Done: ' : k.state === 'todo' ? 'To do: ' : 'Blocked: '}
                    </span>
                    {k.href !== null ? <a href={k.href}>{k.label}</a> : k.label}
                    {k.detail !== '' ? <span className="muted small"> — {k.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── version state ─────────────────────────────

/** Where the schedule stands: nothing yet, a private draft, the official (published) one. */
export function ScheduleState({
  draft,
  published,
  draftCount,
}: {
  draft: ScheduleVersion | null;
  published: ScheduleVersion | null;
  draftCount: number | null;
}) {
  return (
    <section className="sch-state-panel" aria-label="Schedule state">
      <div data-kind="published">
        <span className="mono muted">Official schedule</span>
        {published !== null ? (
          <strong>
            Published · version {published.versionNumber}
            <span className="muted small"> · since {dayTime(published.statusChangedAt)} UTC</span>
          </strong>
        ) : (
          <strong>Not published yet</strong>
        )}
      </div>
      <div data-kind="draft">
        <span className="mono muted">Draft</span>
        {draft !== null ? (
          <strong>
            Version {draft.versionNumber} · not published
            {draftCount !== null ? (
              <span className="muted small">
                {' '}
                · {draftCount} {draftCount === 1 ? 'match' : 'matches'} placed
              </span>
            ) : null}
          </strong>
        ) : (
          <strong>No draft open</strong>
        )}
      </div>
    </section>
  );
}

const dayTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

// ───────────────────────────── schedule views ─────────────────────────────

export type RowState = 'proposed' | 'draft' | 'official' | 'conflict' | 'warning';

const ROW_LABEL: Record<RowState, string> = {
  proposed: 'Proposed',
  draft: 'In draft',
  official: 'Official',
  conflict: 'Conflict',
  warning: 'Warning',
};

export interface RowContext {
  matches: ReadonlyMap<string, MatchInfo>;
  courts: ReadonlyMap<string, string>;
  stateOf: (row: ScheduleRow) => RowState;
  /** Show each row's zone (only when categories use different zones). */
  showZone: boolean;
}

const matchOf = (ctx: RowContext, contestId: string): MatchInfo =>
  ctx.matches.get(contestId) ?? {
    contestId,
    eventId: '',
    category: 'Match',
    round: '',
    title: 'Match',
    sides: [],
    status: '',
  };

/** The schedule as a day-by-day table: time, court, match, players, state (cards on phones). */
export function Agenda({
  days,
  ctx,
  label,
}: {
  days: readonly ScheduleDay[];
  ctx: RowContext;
  label: string;
}) {
  return (
    <div className="sch-agenda" aria-label={label}>
      {days.map((d) => (
        <section key={d.date} className="sch-day" aria-label={d.label}>
          <h4 className="mono">
            {d.label}{' '}
            <span className="muted">
              · {d.rows.length} {d.rows.length === 1 ? 'match' : 'matches'}
            </span>
          </h4>
          <table className="sch-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Court</th>
                <th scope="col">Match</th>
                <th scope="col">Players</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => {
                const m = matchOf(ctx, r.contestId);
                const state = ctx.stateOf(r);
                return (
                  <tr key={r.contestId} data-state={state}>
                    <td data-label="Time" className="mono">
                      <span>
                        {timeText(r)}
                        {ctx.showZone ? <span className="muted small"> {r.zone}</span> : null}
                      </span>
                    </td>
                    <td data-label="Court">
                      {r.resourceId !== null
                        ? (ctx.courts.get(r.resourceId) ?? 'Court')
                        : 'No court'}
                    </td>
                    <td data-label="Match">
                      <span>
                        <strong>{m.title}</strong>
                        <span className="muted small">
                          {' '}
                          {[m.category, m.round].filter((x) => x !== '').join(' · ')}
                        </span>
                      </span>
                    </td>
                    <td data-label="Players">{m.sides.length > 0 ? m.sides.join(' vs ') : '—'}</td>
                    <td data-label="State">
                      <span className="sch-chip" data-state={state}>
                        {ROW_LABEL[state]}
                        {r.locked ? ' · locked' : ''}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

/**
 * Court lanes per day: each match as a block at its local time, the court's declared-open time
 * behind it, hatched time where the court is unavailable. Desktop only; phones get the agenda.
 */
export function Lanes({ days, ctx }: { days: readonly LaneDay[]; ctx: RowContext }) {
  return (
    <div className="sch-lanes-wrap" aria-hidden="true">
      {days.map((d) => {
        const span = d.hours.length - 1;
        return (
          <section key={d.date} className="sch-lanes-day">
            <h4 className="mono muted">{d.label} · courts</h4>
            <div className="sch-lanes-scroll">
              <div className="sch-lanes" style={{ '--span': span } as CSSProperties}>
                <div className="sch-lane sch-hours">
                  <span className="sch-lane-label" />
                  <div className="sch-track">
                    {d.hours.map((h, i) => (
                      <span
                        key={h}
                        className="sch-hour mono"
                        style={{ left: `${(i / span) * 100}%` }}
                      >
                        {String(h % 24).padStart(2, '0')}:00
                      </span>
                    ))}
                  </div>
                </div>
                {d.lanes.map((l) => (
                  <div key={l.resourceId} className="sch-lane">
                    <span className="sch-lane-label">{l.label}</span>
                    <div className="sch-track" data-hours={l.open === null ? 'unknown' : 'known'}>
                      {(l.open ?? []).map((o, i) => (
                        <span
                          key={i}
                          className="sch-open"
                          style={{ left: `${o.left}%`, width: `${o.width}%` }}
                        />
                      ))}
                      {l.blocks.map((b) => {
                        const m = matchOf(ctx, b.row.contestId);
                        return (
                          <span
                            key={b.row.contestId}
                            className="sch-block"
                            data-state={ctx.stateOf(b.row)}
                            style={{ left: `${b.left}%`, width: `${b.width}%` }}
                            title={`${timeText(b.row)} · ${m.title} · ${m.sides.join(' vs ')}`}
                          >
                            {m.title}
                          </span>
                        );
                      })}
                      {l.blocks.length === 0 ? (
                        <span className="sch-free mono">
                          {l.open !== null && l.open.length === 0 ? 'Unavailable' : 'Free'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
      <p className="sch-legend mono muted small">
        <span className="sch-key" data-key="open" /> Declared open{' '}
        <span className="sch-key" data-key="closed" /> Unavailable{' '}
        <span className="sch-key" data-key="block" /> Match
      </p>
    </div>
  );
}

// ───────────────────────────── conflicts and unplaced ─────────────────────────────

const matchList = (ctx: RowContext, ids: readonly string[]) =>
  ids
    .map((id) => {
      const m = matchOf(ctx, id);
      return m.category === 'Match' ? m.title : `${m.title} (${m.category})`;
    })
    .join(', ');

/** The draft's conflict report: what must be fixed (blocks publishing) and what to acknowledge. */
export function ConflictList({
  conflicts,
  ctx,
}: {
  conflicts: readonly ConflictView[];
  ctx: RowContext;
}) {
  const hard = conflicts.filter((c) => c.severity === 'HARD');
  const soft = conflicts.filter((c) => c.severity === 'SOFT');
  const item = (c: ConflictView) => (
    <li key={c.conflictKey} data-severity={c.severity}>
      <strong>{conflictText(c.code)}</strong>
      {c.contestIds.length > 0 ? (
        <span className="muted small"> — {matchList(ctx, c.contestIds)}</span>
      ) : null}
      {c.resourceIds.length > 0 ? (
        <span className="muted small">
          {' '}
          · {c.resourceIds.map((id) => ctx.courts.get(id) ?? 'Court').join(', ')}
        </span>
      ) : null}
      {c.certainty === 'POSSIBLE' ? <span className="muted small"> · possible</span> : null}
    </li>
  );
  return (
    <div className="sch-conflicts">
      {hard.length > 0 ? (
        <section className="sch-issues" data-severity="HARD" aria-label="Conflicts">
          <h4>
            {hard.length} {hard.length === 1 ? 'conflict' : 'conflicts'} to fix before publishing
          </h4>
          <ul>{hard.map(item)}</ul>
        </section>
      ) : null}
      {soft.length > 0 ? (
        <section className="sch-issues" data-severity="SOFT" aria-label="Warnings">
          <h4>
            {soft.length} {soft.length === 1 ? 'warning' : 'warnings'} to review
          </h4>
          <ul>{soft.map(item)}</ul>
        </section>
      ) : null}
    </div>
  );
}

/** Matches a proposal couldn't place, with the reason in organizer words. */
export function UnplacedList({
  unplaced,
  ctx,
}: {
  unplaced: readonly Unplaced[];
  ctx: RowContext;
}) {
  const byReason = new Map<string, string[]>();
  for (const u of unplaced)
    byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), ...u.contestIds]);
  return (
    <section className="sch-issues" data-severity="HARD" aria-label="Matches without a time">
      <h4>{unplaced.reduce((n, u) => n + u.contestIds.length, 0)} matches couldn’t be placed</h4>
      <ul>
        {[...byReason.entries()].map(([reason, ids]) => (
          <li key={reason}>
            <strong>{unplacedText(reason)}</strong>
            <span className="muted small"> — {matchList(ctx, ids)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The proposal's outcome in one line: the status, how many were placed, what's left. */
export function ProposalVerdict({ proposal }: { proposal: Proposal }) {
  const s = PROPOSAL_STATUS[proposal.status];
  const left = proposal.unplaced.reduce((n, u) => n + u.contestIds.length, 0);
  return (
    <div className="sch-verdict" data-tone={s.tone} role="status">
      <strong>{s.title}</strong>
      <span>{s.detail}</span>
      <span className="mono muted small">
        {proposal.metrics.placedContests} placed · {left} without a time
      </span>
    </div>
  );
}

// ───────────────────────────── forms ─────────────────────────────

/** Generate a proposal for every schedulable category or one of them. */
export function GenerateForm({
  hidden,
  action,
  categories,
  current,
  submit,
}: {
  hidden: Hidden;
  action: Action;
  categories: readonly { id: string; name: string }[];
  current: string;
  submit: string;
}) {
  return (
    <form action={action} className="tb-form sch-generate">
      <HiddenFields hidden={hidden} />
      <label>
        Categories
        <select name="scope" defaultValue={current}>
          <option value="all">All categories that can be scheduled</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <SubmitButton pending="Generating" className="btn btn-cyan btn-sm">
        {submit}
      </SubmitButton>
    </form>
  );
}

/** Commit the reviewed proposal: its hash and scope only; the API re-checks it. */
export function CommitForm({
  hidden,
  action,
  versionId,
  proposal,
  scope,
}: {
  hidden: Hidden;
  action: Action;
  versionId: string;
  proposal: Proposal;
  scope: string;
}) {
  return (
    <form action={action} className="sch-commit">
      <HiddenFields hidden={hidden} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="proposalHash" value={proposal.proposalHash} />
      <input type="hidden" name="scope" value={scope} />
      <p className="muted small">
        Adds these {proposal.metrics.placedContests} matches to the draft. Nothing is published yet:
        you check the draft and publish it next.
      </p>
      <SubmitButton pending="Committing" className="btn btn-cyan btn-sm">
        Commit to draft
      </SubmitButton>
    </form>
  );
}

/** Publish the draft against the reviewed report; warnings need an explicit confirmation. */
export function PublishForm({
  hidden,
  action,
  versionId,
  baseVersionId,
  reportHash,
  warnings,
  replacing,
}: {
  hidden: Hidden;
  action: Action;
  versionId: string;
  baseVersionId: string | null;
  reportHash: string;
  warnings: readonly string[];
  replacing: number | null;
}) {
  return (
    <details className="confirm sch-publish">
      <summary className="btn btn-cyan btn-sm">Publish schedule</summary>
      <form action={action} className="tb-form">
        <HiddenFields hidden={hidden} />
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="baseVersionId" value={baseVersionId ?? ''} />
        <input type="hidden" name="reportHash" value={reportHash} />
        {warnings.map((k) => (
          <input key={k} type="hidden" name="warning" value={k} />
        ))}
        <p className="small">
          Publishing makes this the official schedule: players and the public see it, and its
          matches become scheduled.
          {replacing !== null ? ` It replaces published version ${replacing}.` : ''}
        </p>
        {warnings.length > 0 ? (
          <label className="tb-check">
            <input type="checkbox" name="acknowledge" value="yes" required />I have reviewed the{' '}
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'} and want to publish
            anyway
          </label>
        ) : null}
        <SubmitButton pending="Publishing" className="btn btn-cyan btn-sm">
          Confirm and publish
        </SubmitButton>
      </form>
    </details>
  );
}

export function DiscardForm({
  hidden,
  action,
  versionId,
}: {
  hidden: Hidden;
  action: Action;
  versionId: string;
}) {
  return (
    <details className="confirm sch-discard">
      <summary className="btn btn-ghost btn-sm">Discard draft</summary>
      <form action={action} className="tb-form">
        <HiddenFields hidden={hidden} />
        <input type="hidden" name="versionId" value={versionId} />
        <label>
          Reason
          <input name="reason" required maxLength={500} placeholder="Why this draft is dropped" />
        </label>
        <p className="muted small">
          The draft and everything placed in it is dropped. The published schedule doesn’t change.
          This can’t be undone.
        </p>
        <SubmitButton pending="Discarding" className="btn btn-ghost btn-sm">
          Discard draft
        </SubmitButton>
      </form>
    </details>
  );
}

export function OpenDraftForm({ hidden, action }: { hidden: Hidden; action: Action }) {
  return (
    <form action={action}>
      <HiddenFields hidden={hidden} />
      <SubmitButton pending="Opening" className="btn btn-ghost btn-sm">
        Open a new draft
      </SubmitButton>
    </form>
  );
}

/** Matches that have no time in the version shown. */
export function Unscheduled({
  matches,
  children,
}: {
  matches: readonly MatchInfo[];
  children?: ReactNode;
}) {
  return (
    <section className="sch-unscheduled" aria-labelledby="un-h">
      <h3 id="un-h" className="tb-h3">
        Without a time <span className="tb-count">{matches.length}</span>
      </h3>
      {children}
      <ul className="sch-match-list">
        {matches.map((m) => (
          <li key={m.contestId}>
            <strong>{m.title}</strong>{' '}
            <span className="muted small">
              {m.category}
              {m.round !== '' ? ` · ${m.round}` : ''}
            </span>
            <span className="small"> {m.sides.join(' vs ')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
