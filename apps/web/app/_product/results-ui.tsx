import type { ReactNode } from 'react';
import { contestStatusLabel } from '../_lib/operations';
import {
  currentVersion,
  outcomeReasonLabel,
  pendingVersions,
  podiumGroups,
  RESULT_STATE_LABEL,
  resultState,
  TRANSITIONS,
  versionStatusLabel,
  type ResultAttention,
  type ResultMatch,
  type ResultVersion,
  type StaffOutcome,
  type TransitionKey,
} from '../_lib/results';
import { FAMILY_LABEL, formValues, isEntryFamily, scoreLine } from '../_lib/score-sheet';
import { dateTime } from '../_lib/tournament-builder';
import { StandingsTable } from './classification-table';
import type { EntryState } from '../app/orgs/[slug]/tournaments/[competitionId]/results/actions';
import { ScoreSheetForm } from './score-sheet-form';
import { SubmitButton } from './submit-button';

/**
 * ONCF-L5 results workspace pieces. Server-rendered and presentation only: every result, status
 * and score line comes from the API's stored versions. Entering and correcting go through the
 * two-step score sheet form; accepting and declaring official through a confirmation that names
 * the match, the score and what it becomes. The API decides authority and every transition.
 */

export type Hidden = { slug: string; competitionId: string };

export interface RowContext {
  hidden: Hidden;
  /** The caller's staff role can ever hold result authority (ADR-0077); the API still decides. */
  eligible: boolean;
  entry: (prev: EntryState, form: FormData) => Promise<EntryState>;
  transition: (form: FormData) => Promise<never>;
  /** A fresh idempotency key per form. */
  newKey: () => string;
  zone: string;
}

/** "Los Tigres won · 6–1 6–2", or what is honestly known. */
function scoreText(m: ResultMatch, v: ResultVersion): string {
  const ids = m.sideIds.every((x) => x !== null) ? (m.sideIds as string[]) : [];
  const line = m.scoring === null ? null : scoreLine(m.scoring.family, v.content, ids);
  if (line === null) return 'Score recorded';
  const how = line.how === null ? '' : ` · ${line.how.toLowerCase()}`;
  return line.winner === null
    ? `${line.how ?? 'Draw'} · ${line.score}`
    : `${m.sides[line.winner] ?? ''} won${how} · ${line.score}`;
}

const matchName = (m: ResultMatch) => `${m.event.settings.name} · ${m.round} · ${m.title}`;

// ───────────────────────────── at a glance ─────────────────────────────

export function ResultsPulse({
  counts,
}: {
  counts: { needs: number; entered: number; provisional: number; official: number };
}) {
  const cells: [keyof typeof counts, string][] = [
    ['needs', 'Needs result'],
    ['entered', 'To accept'],
    ['provisional', 'To declare official'],
    ['official', 'Official'],
  ];
  return (
    <nav className="ops-pulse rs-pulse" aria-label="Results at a glance">
      {cells.map(([key, label]) => (
        <a key={key} href={`#res-${key}`} data-key={key} data-zero={counts[key] === 0}>
          <span className="mono muted">{label}</span>
          <strong>{counts[key]}</strong>
        </a>
      ))}
    </nav>
  );
}

export function ResultAttentionList({ items }: { items: readonly ResultAttention[] }) {
  if (items.length === 0) return null;
  return (
    <section className="ops-attention" aria-labelledby="res-att-h">
      <h3 id="res-att-h" className="mono">
        Needs attention <span className="tb-count">{items.length}</span>
      </h3>
      <ul>
        {items.map((i) => (
          <li key={i.key} data-tone={i.tone}>
            <a href={i.href}>
              <strong>{i.label}</strong>
              <span className="muted small">{i.detail}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── lists ─────────────────────────────

export function ResultList({
  id,
  title,
  matches,
  empty,
  ctx,
  children,
  headless = false,
}: {
  id: string;
  title: string;
  matches: readonly ResultMatch[];
  empty: string;
  ctx: RowContext;
  children?: ReactNode;
  headless?: boolean;
}) {
  return (
    <section
      id={`res-${id}`}
      className="ops-section"
      {...(headless ? { 'aria-label': title } : { 'aria-labelledby': `res-${id}-h` })}
    >
      {headless ? null : (
        <div className="section-head">
          <h3 id={`res-${id}-h`} className="tb-h3">
            {title} <span className="tb-count">{matches.length}</span>
          </h3>
        </div>
      )}
      {children}
      {matches.length === 0 ? (
        <p className="muted small ops-empty">{empty}</p>
      ) : (
        <ol className="ops-list">
          {matches.map((m) => (
            <ResultRow key={m.contestId} m={m} ctx={ctx} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ResultRow({ m, ctx }: { m: ResultMatch; ctx: RowContext }) {
  const state = resultState(m);
  const cur = currentVersion(m);
  const pending = pendingVersions(m);
  const shown = cur ?? (pending.length === 1 ? pending[0] : undefined);
  const line =
    shown === undefined || m.scoring === null || m.sideIds.some((x) => x === null)
      ? null
      : scoreLine(m.scoring.family, shown.content, m.sideIds as string[]);
  return (
    <li id={`r-${m.contestId}`} className="rs-match" data-result={state} data-status={m.status}>
      <div className="rs-what">
        <strong className="rs-sides">
          {m.sides.map((s, i) => (
            <span key={i} data-won={line?.winner === i ? 'true' : undefined}>
              {i > 0 ? <span className="muted"> vs </span> : null}
              {s}
            </span>
          ))}
        </strong>
        <span className="muted small">{matchName(m)}</span>
      </div>
      <div className="rs-state">
        <span className="ops-chip" data-status={m.status}>
          {contestStatusLabel(m.status)}
        </span>
        <span className="rs-chip" data-state={state}>
          {RESULT_STATE_LABEL[state]}
        </span>
      </div>
      <div className="rs-body">
        {cur !== null ? (
          <p className="rs-score">
            <strong>{scoreText(m, cur)}</strong>
            <span className="muted small">
              {versionStatusLabel(cur.status)} · version {cur.versionNumber}
            </span>
          </p>
        ) : null}
        <RowActions m={m} ctx={ctx} />
        {m.versions !== null && m.versions.length > 0 ? <History m={m} zone={ctx.zone} /> : null}
      </div>
    </li>
  );
}

function RowActions({ m, ctx }: { m: ResultMatch; ctx: RowContext }) {
  const state = resultState(m);
  if (state === 'unreadable')
    return <p className="small rs-note">This match’s result can’t be read right now.</p>;
  // ONCF-L6: a finished category's results are frozen (the API refuses every change).
  if (m.frozen)
    return (
      <p className="small rs-note" data-frozen="true">
        Results frozen: the category is {m.event.status === 'CANCELLED' ? 'cancelled' : 'completed'}
        .
      </p>
    );
  // A voided match decides nothing: its versions stay in the record but never count.
  if (m.status === 'VOID')
    return (
      <p className="small rs-note" data-void="true">
        Match voided: its result doesn’t count in the standings or the outcome.
      </p>
    );
  const cur = currentVersion(m);
  const pending = pendingVersions(m);
  const ready = m.sideIds.length === 2 && m.sideIds.every((x) => x !== null);
  const family = m.scoring?.family;
  const enterable = ready && isEntryFamily(family);
  const why =
    m.scoring === null
      ? 'No scoring is chosen for this category, so results can’t be entered.'
      : !isEntryFamily(family)
        ? `Entering ${FAMILY_LABEL[family ?? ''] ?? 'this kind of'} results isn’t available in this workspace yet.`
        : !ready
          ? 'Both sides must be known before its result can be entered.'
          : null;
  const form = (mode: 'enter' | 'correct', supersedes?: ResultVersion) =>
    m.scoring !== null && isEntryFamily(m.scoring.family) ? (
      <ScoreSheetForm
        action={ctx.entry}
        hidden={ctx.hidden}
        contestId={m.contestId}
        family={m.scoring.family}
        parameters={m.scoring.parameters}
        names={[m.sides[0] ?? 'Side A', m.sides[1] ?? 'Side B']}
        sideIds={[m.sideIds[0] ?? '', m.sideIds[1] ?? '']}
        mode={mode}
        {...(supersedes === undefined ? {} : { supersedes: supersedes.resultVersionId })}
        initialValues={
          supersedes === undefined
            ? {}
            : formValues(m.scoring.family, supersedes.content, m.sideIds as string[])
        }
        initialKey={ctx.newKey()}
      />
    ) : null;

  if (state === 'needs') {
    if (!ctx.eligible) return null;
    if (why !== null || !enterable) return <p className="small rs-note">{why}</p>;
    return (
      <details className="rs-entry">
        <summary className="btn btn-sm btn-cyan">
          <span className="ops-when-closed">Enter result</span>
          <span className="ops-when-open">Close</span>
        </summary>
        {form('enter')}
      </details>
    );
  }

  if (state === 'entered')
    return (
      <div className="rs-pending">
        {pending.length > 1 ? (
          <p className="small ops-warning" role="note">
            {pending.length} different scores were entered. Accept only the right one: once one is
            accepted, the others stay in the record unused.
          </p>
        ) : null}
        <ul className="rs-versions">
          {pending.map((v) => (
            <li key={v.resultVersionId}>
              <span>
                <strong>{scoreText(m, v)}</strong>
                <span className="muted small">
                  {' '}
                  · entered {dateTime(v.recordedAt ?? null, ctx.zone) ?? ''} · version{' '}
                  {v.versionNumber}
                </span>
              </span>
              {ctx.eligible ? <ResultConfirm step="accept" m={m} v={v} ctx={ctx} /> : null}
            </li>
          ))}
        </ul>
      </div>
    );

  if (cur === null || !ctx.eligible) return null;
  return (
    <div className="ops-act">
      {state === 'provisional' ? <ResultConfirm step="official" m={m} v={cur} ctx={ctx} /> : null}
      {enterable ? (
        <details className="rs-entry rs-correct">
          <summary className="btn btn-sm btn-ghost">
            <span className="ops-when-closed">Correct result</span>
            <span className="ops-when-open">Keep as is</span>
          </summary>
          {form('correct', cur)}
        </details>
      ) : null}
    </div>
  );
}

/** Accept or declare official, behind a confirmation naming the match, the score and the outcome. */
function ResultConfirm({
  step,
  m,
  v,
  ctx,
}: {
  step: TransitionKey;
  m: ResultMatch;
  v: ResultVersion;
  ctx: RowContext;
}) {
  const t = TRANSITIONS[step];
  return (
    <details
      className="confirm ops-confirm"
      data-tone={t.final ? 'neutral' : 'go'}
      data-step={step}
    >
      <summary className="btn btn-sm btn-cyan">
        <span className="ops-when-closed">{t.label}</span>
        <span className="ops-when-open">Keep as is</span>
      </summary>
      <form action={ctx.transition} className="ops-confirm-form">
        <input type="hidden" name="slug" value={ctx.hidden.slug} />
        <input type="hidden" name="competitionId" value={ctx.hidden.competitionId} />
        <input type="hidden" name="contestId" value={m.contestId} />
        <input type="hidden" name="versionId" value={v.resultVersionId} />
        <input type="hidden" name="step" value={step} />
        <input type="hidden" name="key" value={ctx.newKey()} />
        <p className="ops-confirm-title">
          <strong>{t.label}?</strong> <span>{matchName(m)}</span>
        </p>
        <p className="small">
          <strong>{scoreText(m, v)}</strong>
        </p>
        <p className="ops-transition mono">
          <span>{versionStatusLabel(t.from)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only"> becomes </span>
          <span data-to={t.to}>{versionStatusLabel(t.to)}</span>
        </p>
        <p className="small">{t.consequence}</p>
        {t.final ? (
          <label className="ops-ack">
            <input type="checkbox" name="confirm" value="yes" required />
            <span>I have checked this score against the official scorecard.</span>
          </label>
        ) : null}
        <SubmitButton pending="Working" className="btn btn-sm btn-cyan">
          {`Confirm · ${t.label.toLowerCase()}`}
        </SubmitButton>
      </form>
    </details>
  );
}

/** Every version of the match's result, newest first: the record nothing ever overwrites. */
function History({ m, zone }: { m: ResultMatch; zone: string }) {
  const versions = m.versions ?? [];
  return (
    <details className="rs-history">
      <summary className="small">
        Record · {versions.length} {versions.length === 1 ? 'version' : 'versions'}
      </summary>
      <ol className="rs-versions">
        {versions.map((v) => (
          <li key={v.resultVersionId} data-status={v.status}>
            <span className="mono">v{v.versionNumber}</span>
            <span className="rs-chip" data-version={v.status}>
              {versionStatusLabel(v.status)}
              {v.current ? ' · current' : ''}
            </span>
            <span className="small">{scoreText(m, v)}</span>
            <span className="muted small">{dateTime(v.recordedAt ?? null, zone) ?? ''}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// ───────────────────────────── aside ─────────────────────────────

export function LifecyclePanel() {
  return (
    <section className="tb-panel" aria-labelledby="res-how-h">
      <h3 id="res-how-h" className="mono muted">
        How a result becomes official
      </h3>
      <ol className="sch-steps">
        <li>
          <strong>Entered</strong>
          <span className="muted small">
            The score is checked against the category’s scoring and kept. It doesn’t count yet.
          </span>
        </li>
        <li>
          <strong>Provisional</strong>
          <span className="muted small">Accepted: the match’s current result.</span>
        </li>
        <li>
          <strong>Official</strong>
          <span className="muted small">Declared official: advancement and standings use it.</span>
        </li>
        <li>
          <strong>Corrected</strong>
          <span className="muted small">
            A wrong score is replaced by a new provisional version with a reason; the old one stays
            in the record.
          </span>
        </li>
        <li>
          <strong>Final</strong>
          <span className="muted small">
            Completing a category settles its outcome from the official results and freezes them:
            nothing can be corrected afterwards.
          </span>
        </li>
      </ol>
      <p className="muted small">
        If two staff act on the same result, the first change wins; the other sees why and the page
        shows the current result.
      </p>
    </section>
  );
}

export function ProgressionPanel({
  categories,
  base,
}: {
  categories: readonly { id: string; name: string }[];
  base: string;
}) {
  if (categories.length === 0) return null;
  return (
    <section className="tb-panel" aria-labelledby="res-adv-h">
      <h3 id="res-adv-h" className="mono muted">
        Advancement
      </h3>
      <p className="muted small">
        Official results fill the next rounds once advancement is confirmed on the category’s
        progression page.
      </p>
      <ul className="ops-staff">
        {categories.map((c) => (
          <li key={c.id}>
            <a className="link" href={`${base}/categories/${c.id}/progression`}>
              {c.name} →
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────────── category outcome (ONCF-L6) ─────────────────────────────

/**
 * One category's outcome as the API derives it from OFFICIAL results only: standings so far while
 * it is played (never a podium), what still blocks completing it, and — once completed — the
 * final podium. Completion itself stays in operations.
 */
export function CategoryOutcomePanel({
  name,
  status,
  data,
  nameOf,
  base,
}: {
  name: string;
  status: string;
  /** null: the outcome couldn't be read. */
  data: StaffOutcome | null;
  nameOf: (participantId: string) => string;
  base: string;
}) {
  const final = status === 'COMPLETED';
  const outcome = data?.outcome;
  const readiness = data?.readiness;
  const tables = outcome?.standings ?? [];
  const blocking = [...(readiness?.contestsOpen ?? []), ...(readiness?.resultsNotOfficial ?? [])];
  const reasons = (outcome?.reasons ?? []).filter(
    (r) => final || !['TIE_UNBROKEN_LOT', 'GROUPS_NO_CHAMPION'].includes(r.code),
  );
  const notes = (outcome?.reasons ?? []).filter((r) =>
    ['TIE_UNBROKEN_LOT', 'GROUPS_NO_CHAMPION'].includes(r.code),
  );
  return (
    <section className="tb-panel rs-outcome" data-final={final} aria-label={`${name} outcome`}>
      <div className="section-head">
        <h3 className="tb-h3">
          {name} <span className="muted small">· {final ? 'Final' : 'Standings so far'}</span>
        </h3>
      </div>
      {data === null ? (
        <p className="small rs-note">The outcome can’t be read right now. Nothing was changed.</p>
      ) : (
        <>
          <p className="small rs-authority">
            {final
              ? 'Final · Official (organizer-declared), not independently verified'
              : 'Standings so far — official results only'}
          </p>
          {readiness !== undefined && readiness.official === 0 && !final ? (
            <p className="muted small ops-empty">No official results yet.</p>
          ) : null}
          {final ? (
            <>
              {outcome?.status === 'DECIDED' && outcome.kind !== 'GROUPS' ? (
                <ol className="rs-podium">
                  {podiumGroups(outcome.placements).map((g) => (
                    <li key={g.position} data-position={g.position}>
                      <span className="mono muted">{g.label}</span>
                      <strong>{g.entrants.map((p) => nameOf(p.participantId)).join(' · ')}</strong>
                    </li>
                  ))}
                </ol>
              ) : null}
              <p className="small rs-note" data-frozen="true">
                Results frozen: nothing in this category can be changed.
              </p>
            </>
          ) : readiness !== undefined ? (
            <div className="rs-readiness">
              <p className="small">
                Official results: {readiness.official} / {readiness.required}
              </p>
              {blocking.length > 0 ? (
                <p className="small">
                  Still blocking completion:{' '}
                  {blocking.map((id, i) => (
                    <span key={id}>
                      {i > 0 ? ', ' : ''}
                      <a className="link" href={`#r-${id}`}>
                        match {i + 1}
                      </a>
                    </span>
                  ))}
                  .{' '}
                  {readiness.contestsOpen.length > 0
                    ? 'Finish or cancel every match first; unplayed ones are cancelled in operations.'
                    : 'Every finished match needs an official result.'}
                </p>
              ) : null}
              {reasons.map((r) => (
                <p key={r.code} className="small ops-warning" role="note">
                  {outcomeReasonLabel(r.code)}
                </p>
              ))}
              {readiness.ready ? (
                <p className="small">
                  <a className="link" href={`${base}/operations#cat-${data.eventId}`}>
                    Ready · complete the category in operations →
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}
          {notes.map((r) => (
            <p key={r.code} className="muted small">
              {outcomeReasonLabel(r.code)}
            </p>
          ))}
          {tables.map((t) => (
            <div key={t.groupKey ?? 'all'} className="rs-standings">
              {t.groupKey === undefined ? null : (
                <p className="mono muted small">Group {t.groupKey.slice(1)}</p>
              )}
              <StandingsTable entries={t.document.entries} nameOf={nameOf} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
