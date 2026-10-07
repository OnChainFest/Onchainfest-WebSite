import type { ReactNode } from 'react';

/** Public competition DTO shapes (subset used by the pages; mirrors @br/competition dto.ts). */
export type EntrantDisplay =
  | { kind: 'ATHLETE'; athleteSlug: string; displayName: string }
  | { kind: 'TEAM'; teamName: string }
  | { kind: 'PRIVATE_ENTRANT' };

export interface EventSummary {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** ONCF-04 (may be absent on older API builds). */
  entrantKind?: 'INDIVIDUAL' | 'TEAM';
  sport: { code: string; name: string };
  discipline: { code: string; name: string; version: number };
  format: { code: string; name: string; version: number; engine: string };
  category: Record<string, unknown>;
  capacity: number | null;
  confirmedCount: number;
  waitlistCount: number;
  participantCount: number;
  registration: { opensAt: string | null; closesAt: string | null };
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
}

export interface PublicCompetition {
  competition: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    timezone: string;
    startsAt: string | null;
    endsAt: string | null;
    locationLabel: string | null;
    organizer: { organizationId: string; slug: string | null; displayName: string | null };
  };
  events: EventSummary[];
  canonicalSlug: string;
  redirected: boolean;
}

export interface PublicEvent {
  competition: { id: string; slug: string; name: string; status: string };
  event: EventSummary;
  field: { locked: boolean; fieldHash: string | null };
  seeding: {
    method: string;
    drawAlgorithm: string | null;
    drawSeed: string | null;
    seedingHash: string;
  } | null;
  plan: { engine: string; inputHash: string; planHash: string; generatedAt: string } | null;
  canonical: { competitionSlug: string; eventSlug: string };
  redirected: boolean;
}

export type Slot =
  | { slot: number; kind: 'PARTICIPANT'; participantId: string; display: EntrantDisplay }
  | {
      slot: number;
      kind: 'WINNER_OF_CONTEST' | 'LOSER_OF_CONTEST';
      contestId: string;
      contestSequence: number;
      resolved: false;
    }
  // ONCF-05B stage-graph dependencies (unresolved until results exist).
  | {
      slot: number;
      kind: 'RANK_FROM_STAGE';
      stageKey: string | null;
      groupKey: string | null;
      rank: number;
      resolved: false;
    }
  | {
      slot: number;
      kind: 'BEST_RANKED_FROM_STAGE';
      stageKey: string;
      rank: number;
      ordinal: number;
      resolved: false;
    }
  | { slot: number; kind: 'QUALIFIER'; transitionKey: string; ordinal: number; resolved: false };

/** ONCF-05B field entry (mass start, wave, time trial, stage): no 64-slot ceiling. */
export interface FieldEntry {
  participantId: string;
  position: number;
  startOffsetSeconds: number | null;
  display: EntrantDisplay;
}

export interface Contest {
  contestId: string;
  sequence: number;
  contestType: string;
  status: string;
  round: { sequence: number; label: string; roundType: string };
  scheduledStart: string | null;
  scheduledEnd: string | null;
  locationLabel: string | null;
  courtLabel: string | null;
  slots: Slot[];
  /** ONCF-05B (absent on older API builds). */
  partitionKey?: string | null;
  entryCount?: number;
  entries?: FieldEntry[];
}

export interface Entry {
  participantId: string | null;
  kind: string;
  registrationStatus: string;
  participantStatus: string | null;
  seed: number | null;
  display: EntrantDisplay;
}

export interface StructureRound {
  sequence: number;
  label: string;
  roundType: string;
  /** ONCF-05B (absent / null for single-stage BRT-05 plans). */
  stage?: {
    key: string;
    label: string;
    primitive: 'KNOCKOUT' | 'ROUND_ROBIN' | 'FIELD' | 'HEATS';
    partitionKind: 'LOGISTIC' | 'COMPETITIVE' | null;
  } | null;
  groupKey?: string | null;
  dynamicEntry?: { transitionKey: string } | null;
  byes: { participantId: string; display: EntrantDisplay }[];
  contests: Contest[];
}

/** "g1" → "A", "g27" → "AA" (presentation only). */
export function groupName(groupKey: string | null | undefined): string | null {
  const m = /^g(\d{1,2})$/.exec(groupKey ?? '');
  if (m === null) return null;
  const i = Number(m[1]) - 1;
  return i < 26
    ? String.fromCharCode(65 + i)
    : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinalLabel(n: number): string {
  const tens = n % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}

/** Partition keys are kind-prefixed: w(ave), h(eat), t (start group), g(roup). */
export function partitionLabel(key: string | null | undefined): string | null {
  const m = /^([a-z])(\d{1,5})$/.exec(key ?? '');
  if (m === null) return null;
  const kind: Record<string, string> = { w: 'Wave', h: 'Heat', t: 'Start group', g: 'Group' };
  const n = m[2] as string;
  return m[1] === 'g'
    ? `Group ${groupName(`g${n}`) ?? n}`
    : `${kind[m[1] as string] ?? 'Group'} ${n}`;
}

/** Text for an unresolved dependency: never a name, only where the entrant will come from. */
export function dependencyLabel(slot: Exclude<Slot, { kind: 'PARTICIPANT' }>): string {
  switch (slot.kind) {
    case 'RANK_FROM_STAGE': {
      const g = groupName(slot.groupKey);
      return g !== null
        ? `Group ${g} · ${ordinalLabel(slot.rank)}`
        : `Qualifying ${ordinalLabel(slot.rank)}`;
    }
    case 'BEST_RANKED_FROM_STAGE':
      return `Best ${ordinalLabel(slot.rank)} #${slot.ordinal}`;
    case 'QUALIFIER':
      return `Qualifier #${slot.ordinal}`;
    default:
      return `${slot.kind === 'WINNER_OF_CONTEST' ? 'winner' : 'loser'} of contest #${slot.contestSequence}`;
  }
}

/** Formats an instant in the competition/event IANA timezone (storage is UTC). */
export function when(iso: string | null, timeZone: string): string {
  if (iso === null) return 'Not scheduled';
  return (
    new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    ) + ` (${timeZone})`
  );
}

export function Entrant({ display }: { display: EntrantDisplay }): ReactNode {
  if (display.kind === 'ATHLETE')
    return <a href={`/athletes/${display.athleteSlug}`}>{display.displayName}</a>;
  if (display.kind === 'TEAM') return <span>{display.teamName}</span>;
  return <em style={{ color: '#6b7280' }}>Private entrant</em>;
}

/** Unresolved slots are never given a name: "TBD" is presentation only. */
export function SlotView({ slot }: { slot: Slot }): ReactNode {
  if (slot.kind === 'PARTICIPANT') return <Entrant display={slot.display} />;
  return (
    <span style={{ color: '#6b7280' }}>
      TBD <small>({dependencyLabel(slot)})</small>
    </span>
  );
}

export function StatusPill({ status }: { status: string }): ReactNode {
  return (
    <span
      style={{
        border: '1px solid #9ca3af',
        borderRadius: 999,
        padding: '0 0.5rem',
        fontSize: '0.75rem',
        marginLeft: '0.5rem',
      }}
      title="Operational status — not a verified result"
    >
      {status.toLowerCase().replace(/_/g, ' ')}
    </span>
  );
}
