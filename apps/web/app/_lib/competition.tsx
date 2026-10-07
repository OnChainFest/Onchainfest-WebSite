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
    };

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
  byes: { participantId: string; display: EntrantDisplay }[];
  contests: Contest[];
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
      TBD{' '}
      <small>
        ({slot.kind === 'WINNER_OF_CONTEST' ? 'winner' : 'loser'} of contest #{slot.contestSequence}
        )
      </small>
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
