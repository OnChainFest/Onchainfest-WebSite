import {
  STAGE_STATE_LABEL,
  type HubStage,
  type NextAction,
  type StageState,
} from '../_lib/competition-hub';
import {
  Entrant,
  OFFICIAL_AUTHORITY_NOTE,
  placeLabel,
  type PublicCompetitionOutcome,
} from '../_lib/competition';
import type { ManagedCompetition } from '../_lib/tournaments';

/** ONCF-L1 Competition Hub presentation (server-safe, no state). */

const STAGE_MARK: Record<StageState, string> = {
  ready: '✓',
  open: '●',
  progress: '◐',
  attention: '!',
  todo: '○',
  planned: '–',
};

/**
 * The tournament's own navigation. Destinations that have no web surface yet are shown as
 * unavailable (no link), so the shape of the workflow is visible without promising it.
 */
export function CompetitionNav({
  data,
  base,
  current,
}: {
  data: ManagedCompetition;
  base: string;
  current:
    'overview' | 'registrations' | 'resources' | 'schedule' | 'operations' | 'results' | 'staff';
}) {
  const c = data.competition;
  const live = data.events.filter((e) => e.status !== 'CANCELLED');
  const only = live.length === 1 ? live[0] : undefined;
  const items: { key: string; label: string; href?: string; note?: string }[] = [
    { key: 'overview', label: 'Overview', href: base },
    data.events.length > 0
      ? { key: 'registrations', label: 'Registrations', href: `${base}/registrations` }
      : { key: 'registrations', label: 'Registrations', note: 'Add a category first' },
    live.length === 0
      ? { key: 'structure', label: 'Structure', note: 'Add a category first' }
      : {
          key: 'structure',
          label: 'Structure',
          href:
            only !== undefined ? `${base}/categories/${only.id}/structure` : `${base}#categories`,
        },
    { key: 'resources', label: 'Resources', href: `${base}/resources` },
    { key: 'schedule', label: 'Schedule', href: `${base}/schedule` },
    { key: 'operations', label: 'Operations', href: `${base}/operations` },
    { key: 'results', label: 'Results', href: `${base}/results` },
    { key: 'staff', label: 'Staff', href: `${base}/staff` },
    c.status === 'DRAFT'
      ? { key: 'public', label: 'Public', note: 'After publishing' }
      : { key: 'public', label: 'Public ↗', href: `/competitions/${c.slug}` },
  ];
  return (
    <nav className="tabs cn" aria-label="Tournament">
      {items.map((i) =>
        i.href === undefined ? (
          <span key={i.key} className="cn-off" aria-disabled="true" data-key={i.key}>
            {i.label} <small className="mono">{i.note}</small>
          </span>
        ) : (
          <a
            key={i.key}
            href={i.href}
            data-key={i.key}
            aria-current={i.key === current ? 'page' : undefined}
          >
            {i.label}
          </a>
        ),
      )}
    </nav>
  );
}

/** Workflow stages with their real status; only stages with a real destination link anywhere. */
export function StageGrid({ stages }: { stages: readonly HubStage[] }) {
  return (
    <ol className="hub-stages" aria-label="Tournament workflow">
      {stages.map((s) => {
        const body = (
          <>
            <span className="hub-stage-head">
              <strong>{s.label}</strong>
              <span className="hub-state mono" data-state={s.state}>
                <span aria-hidden="true">{STAGE_MARK[s.state]}</span>
                {STAGE_STATE_LABEL[s.state]}
              </span>
            </span>
            <span className="muted small">{s.detail}</span>
          </>
        );
        return (
          <li key={s.key} data-state={s.state} data-key={s.key}>
            {s.href === undefined ? <div>{body}</div> : <a href={s.href}>{body}</a>}
          </li>
        );
      })}
    </ol>
  );
}

export function NextActionPanel({ next }: { next: NextAction }) {
  return (
    <section className="hub-next" aria-labelledby="next-h">
      <span id="next-h" className="mono muted">
        Next step
      </span>
      <strong>{next.label}</strong>
      <span className="muted small">{next.detail}</span>
      {next.href !== undefined ? (
        <a className="btn btn-cyan btn-sm" href={next.href}>
          Go →
        </a>
      ) : null}
    </section>
  );
}

/**
 * ONCF-L6: the outcome of every completed category — its champion(s), joint when tied, or why
 * there is none — with links to the results workspace and the public outcome. Nothing is shown
 * until a category is completed (and never a provisional result).
 */
export function OutcomeSummary({
  outcome,
  base,
  publicHref,
}: {
  outcome: PublicCompetitionOutcome | null;
  base: string;
  publicHref: string;
}) {
  const done = (outcome?.events ?? []).filter((e) => e.final);
  if (done.length === 0) return null;
  return (
    <section className="tb-panel" aria-labelledby="hub-outcome-h">
      <h3 id="hub-outcome-h" className="mono muted">
        Completed categories <span className="tb-count">{done.length}</span>
      </h3>
      <ul className="ops-staff">
        {done.map((e) => (
          <li key={e.id}>
            <strong>{e.name}</strong>{' '}
            <span className="muted small">
              {e.champions !== null && e.champions.length > 0 ? (
                <>
                  {placeLabel(1, e.champions.length)}:{' '}
                  {e.champions.map((p, i) => (
                    <span key={p.participantId}>
                      {i > 0 ? ' · ' : ''}
                      <Entrant display={p.display} />
                    </span>
                  ))}
                </>
              ) : e.kind === 'GROUPS' ? (
                'Groups ranked separately — no overall champion'
              ) : (
                'Final results recorded'
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted small">{OFFICIAL_AUTHORITY_NOTE}.</p>
      <p className="small">
        <a className="link" href={`${base}/results`}>
          Results →
        </a>{' '}
        <a className="link" href={publicHref}>
          Public outcome ↗
        </a>
      </p>
    </section>
  );
}
