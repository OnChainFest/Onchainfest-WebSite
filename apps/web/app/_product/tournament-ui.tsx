import type { CSSProperties, ReactNode } from 'react';
import {
  COMPETITION_STATUS_LABEL,
  EVENT_STATUS_LABEL,
  dayParts,
  hueFor,
} from '../_lib/tournament-builder';
import type { CompetitionStatus, EventStatus } from '../_lib/tournaments';

/** ONCF-03B presentation pieces for the organizer Tournament Builder (server-safe, no state). */

export function StatusBadge({ status }: { status: CompetitionStatus | EventStatus }) {
  const label =
    (COMPETITION_STATUS_LABEL as Record<string, string>)[status] ??
    (EVENT_STATUS_LABEL as Record<string, string>)[status] ??
    status;
  return (
    <span className="tb-status mono" data-status={status}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Tournament artwork: the organization's brand colour over court lines, with the opening date as a
 * ticket stub. Generated from real data only; no stock imagery.
 */
export function TournamentArt({
  startsAt,
  timezone,
  status,
  size = 'card',
  children,
}: {
  startsAt: string | null;
  timezone: string;
  status: CompetitionStatus;
  size?: 'card' | 'hero';
  children?: ReactNode;
}) {
  const day = dayParts(startsAt, timezone);
  return (
    <div className={`tb-art tb-art-${size}`} data-status={status}>
      <svg
        className="tb-court"
        viewBox="0 0 400 200"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <rect x="40" y="30" width="320" height="140" />
        <line x1="200" y1="30" x2="200" y2="170" />
        <line x1="40" y1="100" x2="360" y2="100" />
        <rect x="110" y="55" width="180" height="90" />
        <circle cx="200" cy="100" r="18" />
      </svg>
      <div className="tb-art-top">
        <StatusBadge status={status} />
        {children}
      </div>
      {day !== null ? (
        <span className="tb-stub">
          <strong>{day.day}</strong>
          <span className="mono">{day.month}</span>
        </span>
      ) : (
        <span className="tb-stub tb-stub-tbd">
          <strong>—</strong>
          <span className="mono">Date tbd</span>
        </span>
      )}
    </div>
  );
}

/** Generated sport tile (hue derived from the catalog code; nothing hard-coded per sport). */
export function SportGlyph({
  code,
  name,
  size = 44,
}: {
  code: string;
  name: string;
  size?: number;
}) {
  const initials =
    name
      .split(/[\s.-]+/)
      .filter((w) => w !== '')
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '·';
  return (
    <span
      className="tb-glyph"
      style={{ '--hue': hueFor(code), width: size, height: size } as CSSProperties}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/** Lifecycle track: the usual path, with the current state marked (cancelled shown as a break). */
export function StatusTrack<S extends string>({
  track,
  status,
  labels,
}: {
  track: readonly S[];
  status: S;
  labels: Record<S, string>;
}) {
  const cancelled = status === 'CANCELLED';
  const at = track.indexOf(status);
  return (
    <ol className="tb-track" data-cancelled={cancelled} aria-label="Lifecycle">
      {track.map((s, i) => (
        <li
          key={s}
          data-state={cancelled ? 'off' : i < at ? 'done' : i === at ? 'current' : 'todo'}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="mono">{labels[s]}</span>
        </li>
      ))}
      {cancelled ? (
        <li data-state="cancelled" aria-current="step">
          <span className="mono">Cancelled</span>
        </li>
      ) : null}
    </ol>
  );
}

export interface RailStep {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly state: 'done' | 'current' | 'todo';
  readonly href?: string;
}

/** Builder progress: Identity → Categories → Configuration → Review → Publish. */
export function BuilderRail({ steps }: { steps: readonly RailStep[] }) {
  return (
    <ol className="tb-rail" aria-label="Tournament builder">
      {steps.map((s, i) => (
        <li
          key={s.key}
          data-state={s.state}
          aria-current={s.state === 'current' ? 'step' : undefined}
        >
          {s.href === undefined ? (
            <RailBody step={s} n={i + 1} />
          ) : (
            <a href={s.href}>
              <RailBody step={s} n={i + 1} />
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

function RailBody({ step, n }: { step: RailStep; n: number }) {
  return (
    <>
      <span className="tb-rail-n mono">
        {step.state === 'done' ? '✓' : String(n).padStart(2, '0')}
      </span>
      <span className="tb-rail-t">
        <strong>{step.label}</strong>
        <span className="muted small">{step.detail}</span>
      </span>
    </>
  );
}

/** Confirm-then-submit cancellation with a required reason (sent to the API as is). */
export function CancelForm({
  action,
  hidden,
  label,
}: {
  action: (form: FormData) => Promise<never>;
  hidden: Record<string, string>;
  label: string;
}) {
  return (
    <details className="confirm tb-cancel">
      <summary className="btn btn-ghost btn-sm">{label}</summary>
      <form action={action} className="tb-cancel-form">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <input type="hidden" name="command" value="cancel" />
        <label className="field">
          <span>Reason · required</span>
          <textarea name="reason" required minLength={1} maxLength={500} rows={2} />
        </label>
        <button className="btn btn-danger btn-sm" type="submit">
          Confirm cancellation
        </button>
      </form>
    </details>
  );
}

/** Small labelled fact (dates, venue, capacity…), used in rows of facts. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tb-fact">
      <span className="mono muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}
