'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { errorMessage } from '../_lib/auth/messages';
import { F, scoreLine, sheetLayout, type EntryFamily, type SheetLayout } from '../_lib/score-sheet';
import type { EntryState } from '../app/orgs/[slug]/tournaments/[competitionId]/results/actions';

/**
 * ONCF-L5 score entry for one head-to-head match, in the shape its ruleset family records (sets
 * and tie-breaks, periods and overtime, a final score and how it ended, hole by hole). Two steps:
 * "Check score" asks the API to validate it and shows what would be recorded; "Record result"
 * records exactly that. Presentation only — the API validates, authorizes and records.
 */

type Action = (prev: EntryState, form: FormData) => Promise<EntryState>;

function Button({
  intent,
  children,
  pending,
  primary,
}: {
  intent: 'check' | 'record';
  children: ReactNode;
  pending: string;
  primary: boolean;
}) {
  const { pending: busy } = useFormStatus();
  return (
    <button
      className={`btn btn-sm ${primary ? 'btn-cyan' : 'btn-ghost'}`}
      type="submit"
      name="intent"
      value={intent}
      disabled={busy}
      aria-disabled={busy}
    >
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pending}
        </>
      ) : (
        children
      )}
    </button>
  );
}

function Num({
  name,
  label,
  values,
}: {
  name: string;
  label: string;
  values: Record<string, string>;
}) {
  return (
    <input
      className="rs-num"
      name={name}
      defaultValue={values[name] ?? ''}
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={3}
      autoComplete="off"
      aria-label={label}
    />
  );
}

/** One row of side-by-side numbers: "Set 1 · [6] [4]". */
function PairRow({
  label,
  names,
  a,
  b,
  values,
  extra,
}: {
  label: string;
  names: readonly [string, string];
  a: string;
  b: string;
  values: Record<string, string>;
  extra?: ReactNode;
}) {
  return (
    <div className="rs-row" role="group" aria-label={label}>
      <span className="rs-label mono">{label}</span>
      <Num name={a} label={`${label}, ${names[0]}`} values={values} />
      <Num name={b} label={`${label}, ${names[1]}`} values={values} />
      {extra}
    </div>
  );
}

function Fields({
  layout,
  names,
  values,
}: {
  layout: SheetLayout;
  names: readonly [string, string];
  values: Record<string, string>;
}) {
  const head = (
    <div className="rs-row rs-head" aria-hidden="true">
      <span />
      <span className="rs-side">{names[0]}</span>
      <span className="rs-side">{names[1]}</span>
    </div>
  );
  switch (layout.family) {
    case 'SETS_OF_GAMES':
      return (
        <div className="rs-grid" data-family={layout.family}>
          {head}
          {Array.from({ length: layout.sets }, (_, i) => (
            <PairRow
              key={i}
              label={`Set ${i + 1}`}
              names={names}
              a={F.set(i, 'a')}
              b={F.set(i, 'b')}
              values={values}
              extra={
                layout.tiebreaks ? (
                  <span className="rs-tb" role="group" aria-label={`Set ${i + 1} tie-break`}>
                    <span className="mono muted">TB</span>
                    <Num
                      name={F.tb(i, 'a')}
                      label={`Set ${i + 1} tie-break, ${names[0]}`}
                      values={values}
                    />
                    <Num
                      name={F.tb(i, 'b')}
                      label={`Set ${i + 1} tie-break, ${names[1]}`}
                      values={values}
                    />
                  </span>
                ) : null
              }
            />
          ))}
          {layout.matchTiebreak !== null ? (
            <PairRow
              label={`Match tie-break (to ${layout.matchTiebreak})`}
              names={names}
              a={F.mtb('a')}
              b={F.mtb('b')}
              values={values}
            />
          ) : null}
        </div>
      );
    case 'TIMED_PERIODS':
      return (
        <div className="rs-grid" data-family={layout.family}>
          {head}
          {Array.from({ length: layout.periods }, (_, i) => (
            <PairRow
              key={i}
              label={`Period ${i + 1}`}
              names={names}
              a={F.period(i, 'a')}
              b={F.period(i, 'b')}
              values={values}
            />
          ))}
          {Array.from({ length: layout.overtimes }, (_, i) => (
            <PairRow
              key={`ot${i}`}
              label={`Overtime ${i + 1}`}
              names={names}
              a={F.ot(i, 'a')}
              b={F.ot(i, 'b')}
              values={values}
            />
          ))}
        </div>
      );
    case 'TIMED_OR_TARGET':
      return (
        <div className="rs-grid" data-family={layout.family}>
          {head}
          <PairRow
            label="Final score"
            names={names}
            a={F.reg('a')}
            b={F.reg('b')}
            values={values}
          />
          <PairRow label="Overtime" names={names} a={F.tot('a')} b={F.tot('b')} values={values} />
          <label className="field rs-select">
            <span>How regulation ended</span>
            <select name={F.endedBy} defaultValue={values[F.endedBy] ?? ''}>
              <option value="">Choose…</option>
              <option value="TARGET">A side reached {layout.target}</option>
              <option value="TIME">Time ran out</option>
            </select>
          </label>
        </div>
      );
    case 'MATCH_PLAY_HOLES':
      return (
        <ol className="rs-holes" data-family={layout.family}>
          {Array.from({ length: layout.holes + layout.extra }, (_, i) => (
            <li key={i}>
              <label>
                <span className="mono muted">
                  {i < layout.holes ? `Hole ${i + 1}` : `Extra ${i - layout.holes + 1}`}
                </span>
                <select name={F.hole(i)} defaultValue={values[F.hole(i)] ?? ''}>
                  <option value="">Not played</option>
                  <option value="A">{names[0]}</option>
                  <option value="B">{names[1]}</option>
                  <option value="HALVED">Halved</option>
                </select>
              </label>
            </li>
          ))}
        </ol>
      );
  }
}

export function ScoreSheetForm({
  action,
  hidden,
  contestId,
  family,
  parameters,
  names,
  sideIds,
  mode,
  supersedes,
  initialValues,
  initialKey,
}: {
  action: Action;
  hidden: { slug: string; competitionId: string };
  contestId: string;
  family: EntryFamily;
  parameters: Readonly<Record<string, unknown>>;
  names: readonly [string, string];
  sideIds: readonly [string, string];
  mode: 'enter' | 'correct';
  supersedes?: string;
  initialValues: Record<string, string>;
  initialKey: string;
}) {
  const [state, formAction] = useActionState(action, {
    kind: 'idle',
    values: initialValues,
    nextKey: initialKey,
    seq: 0,
  });
  const layout = sheetLayout(family, parameters);
  const values = { ...state.values };
  const error = errorMessage(state.error);
  const line = state.kind === 'review' ? scoreLine(family, state.content, sideIds) : null;
  const correcting = mode === 'correct';
  return (
    <form key={state.seq} action={formAction} className="rs-form" data-mode={mode}>
      <input type="hidden" name="slug" value={hidden.slug} />
      <input type="hidden" name="competitionId" value={hidden.competitionId} />
      <input type="hidden" name="contestId" value={contestId} />
      <input type="hidden" name="family" value={family} />
      <input type="hidden" name="mode" value={mode} />
      {supersedes !== undefined ? (
        <input type="hidden" name="supersedes" value={supersedes} />
      ) : null}
      <input type="hidden" name="key" value={state.nextKey} />
      {state.hash !== undefined ? <input type="hidden" name="hash" value={state.hash} /> : null}
      <p className="muted small">{layout.note}</p>
      <Fields layout={layout} names={names} values={values} />
      <label className="field rs-select">
        <span>How the match ended</span>
        <select name={F.ending} defaultValue={values[F.ending] ?? ''}>
          <option value="">
            {family === 'MATCH_PLAY_HOLES' ? 'Played out' : 'Played to the end'}
          </option>
          {layout.endings.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label(names)}
            </option>
          ))}
        </select>
      </label>
      {correcting ? (
        <label className="field">
          <span>Reason for the correction · required, kept in the result’s record</span>
          <textarea
            name="reason"
            required
            maxLength={200}
            rows={2}
            defaultValue={values.reason ?? ''}
          />
        </label>
      ) : null}
      {state.issues !== undefined && state.issues.length > 0 ? (
        <ul className="rs-issues small" role="alert">
          {state.issues.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : null}
      {error !== null ? (
        <p className="flash" role="alert">
          {error}
        </p>
      ) : null}
      {state.kind === 'review' ? (
        <div className="rs-review" role="status">
          <span className="mono muted">
            {correcting ? 'Will replace the recorded score with' : 'Will be recorded'}
          </span>
          <strong>
            {line === null
              ? 'Valid score'
              : line.winner === null
                ? `${line.how ?? 'Draw'} · ${line.score}`
                : `${names[line.winner]} won${line.how !== null ? ` · ${line.how.toLowerCase()}` : ''} · ${line.score}`}
          </strong>
          <span className="muted small">
            {correcting
              ? 'The current result becomes “replaced” and stays in the record. The corrected one is provisional until declared official again.'
              : 'It is entered, not yet counted: it becomes the match’s result once accepted.'}
          </span>
        </div>
      ) : null}
      <div className="rs-actions">
        <Button intent="check" pending="Checking" primary={state.kind !== 'review'}>
          {state.kind === 'review' ? 'Check again' : 'Check score'}
        </Button>
        {state.kind === 'review' ? (
          <Button intent="record" pending="Recording" primary>
            {correcting ? 'Record correction' : 'Record result'}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
