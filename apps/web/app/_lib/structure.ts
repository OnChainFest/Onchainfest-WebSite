import { apiRequest, type ApiResult } from './platform';
import type { EntryAttributeSpec } from './tournaments';

/**
 * ONCF-05B event structure for organizers: readiness (derived from facts, never a lifecycle state),
 * the locked field with its frozen declared attributes, a side-effect-free plan preview, and the
 * seeding request the form builds. Locking, seeding and generating are single immutable commands
 * decided by the API; nothing here decides permissions or rules.
 */

export interface Readiness {
  eventId: string;
  status: string;
  fieldLocked: boolean;
  fieldVersion: number | null;
  participants: number;
  rosterSnapshot: { teams: number; snapshotted: number } | null;
  entryAttributesFrozen: number;
  seeded: boolean;
  seeding: { method: string; version: number | null; overrides: number } | null;
  planGenerated: boolean;
  plan: {
    engine: string;
    planVersion: number | null;
    stages: number;
    contests: number;
    dynamicRounds: number;
  } | null;
  contestsScheduled: { scheduled: number; total: number };
  blockers: string[];
  warnings: string[];
}

export interface FieldParticipant {
  participantId: string;
  registrationId: string;
  kind: 'INDIVIDUAL' | 'TEAM';
  athleteId: string | null;
  teamId: string | null;
  teamName: string | null;
  status: string;
  seed: number | null;
  rosterSize: number | null;
  attributes: { key: string; value: string; athleteId?: string }[];
  athlete: { slug: string; displayName: string } | null;
}

export interface PlanPreview {
  engine: string;
  planVersion: 1 | 2;
  stages: { key: string; label: string; primitive: string; partitionKind: string | null }[];
  transitions: { key: string; kind: string; fromStage: string; toStage: string }[];
  rounds: {
    key: string;
    label: string;
    roundType: string;
    stageKey: string | null;
    groupKey: string | null;
    dynamic: boolean;
    contests: number;
    entries: number;
  }[];
  contests: number;
}

export function readiness(token: string, eventId: string): Promise<ApiResult<Readiness>> {
  return apiRequest(token, 'GET', `/v1/events/${eventId}/readiness`);
}

export function lockedField(
  token: string,
  eventId: string,
): Promise<ApiResult<{ items: FieldParticipant[] }>> {
  return apiRequest(token, 'GET', `/v1/events/${eventId}/field`);
}

export function planPreview(token: string, eventId: string): Promise<ApiResult<PlanPreview>> {
  return apiRequest(token, 'GET', `/v1/events/${eventId}/plan-preview`);
}

// ───────────────────────────── vocabulary ─────────────────────────────

export const BLOCKER_LABEL: Record<string, string> = {
  FIELD_NOT_LOCKED: 'Lock the field',
  NOT_SEEDED: 'Seed the field',
  NO_PLAN: 'Generate the structure',
};

export const WARNING_LABEL: Record<string, string> = {
  CONTESTS_UNSCHEDULED: 'Some contests have no time or court yet',
  ROUNDS_AWAIT_ADVANCEMENT: 'Some rounds get their field from results (cut, qualifiers)',
};

export const SEEDING_METHOD_LABEL: Record<string, string> = {
  DETERMINISTIC_DRAW: 'Random draw',
  RANKED_THEN_DRAWN: 'Seeds, then draw',
  BY_ENTRY_ATTRIBUTE: 'By a declared value',
  MANUAL: 'Manual order',
};

export const PRIMITIVE_LABEL: Record<string, string> = {
  KNOCKOUT: 'Knockout',
  ROUND_ROBIN: 'Round robin',
  FIELD: 'Field',
  HEATS: 'Heats',
};

export const TRANSITION_LABEL: Record<string, string> = {
  RANK_FROM_GROUP: 'group ranks',
  QUALIFY_BY_PLACE_AND_TIME: 'heat qualifiers',
  CUT: 'the cut',
  ELIMINATE_NON_FINISHERS: 'non-finisher elimination',
  STEPLADDER: 'the stepladder',
  RANK_TO_BRACKET: 'qualifying ranks',
};

/** Numeric PARTICIPANT attributes a field can be seeded by (from the discipline's declaration). */
export function seedableAttributes(
  specs: readonly EntryAttributeSpec[] | undefined,
): EntryAttributeSpec[] {
  return (specs ?? []).filter((a) => a.scope === 'PARTICIPANT' && a.valueType !== 'TEXT');
}

// ───────────────────────────── seeding request ─────────────────────────────

export type SeedingForm =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'error'; code: 'seeding_invalid' | 'reason_required' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds the `/seed` body from the organizer form. Only participants of the locked field are
 * accepted; seed numbers must be 1..k without gaps or repeats; each override needs a reason.
 */
export function seedingRequest(
  get: (name: string) => string,
  field: readonly Pick<FieldParticipant, 'participantId'>[],
  seedable: readonly Pick<EntryAttributeSpec, 'key'>[],
): SeedingForm {
  const method = get('method');
  const ids = new Set(field.map((p) => p.participantId));
  const body: Record<string, unknown> = { method };
  if (method === 'RANKED_THEN_DRAWN') {
    const seeds: { id: string; n: number }[] = [];
    for (const p of field) {
      const raw = get(`seed.${p.participantId}`).trim();
      if (raw === '') continue;
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || String(n) !== raw || n < 1)
        return { kind: 'error', code: 'seeding_invalid' };
      seeds.push({ id: p.participantId, n });
    }
    seeds.sort((a, b) => a.n - b.n);
    if (seeds.length === 0 || seeds.length > 64 || seeds.some((s, i) => s.n !== i + 1))
      return { kind: 'error', code: 'seeding_invalid' };
    body.seeds = seeds.map((s) => s.id);
    body.banded = get('banded') === 'on';
  } else if (method === 'BY_ENTRY_ATTRIBUTE') {
    const key = get('attributeKey');
    if (!seedable.some((a) => a.key === key)) return { kind: 'error', code: 'seeding_invalid' };
    body.attributeKey = key;
    body.direction = get('direction') === 'DESC' ? 'DESC' : 'ASC';
  } else if (method !== 'DETERMINISTIC_DRAW') return { kind: 'error', code: 'seeding_invalid' };

  const label = get('sourceLabel').trim();
  const asOf = get('sourceAsOf').trim();
  if (asOf !== '' && !DATE_RE.test(asOf)) return { kind: 'error', code: 'seeding_invalid' };
  if (label !== '' || asOf !== '')
    body.source = {
      kind:
        method === 'BY_ENTRY_ATTRIBUTE'
          ? 'ENTRY_ATTRIBUTE'
          : method === 'RANKED_THEN_DRAWN'
            ? 'DECLARED_EXTERNAL'
            : 'ORGANIZER',
      ...(label === '' ? {} : { label: label.slice(0, 120) }),
      ...(asOf === '' ? {} : { asOf }),
    };

  const overrides = [];
  for (let i = 1; i <= 3; i++) {
    const participantId = get(`override.${i}.participant`);
    const pos = get(`override.${i}.position`).trim();
    const reason = get(`override.${i}.reason`).trim();
    if (participantId === '' && pos === '' && reason === '') continue;
    if (!UUID_RE.test(participantId) || !ids.has(participantId))
      return { kind: 'error', code: 'seeding_invalid' };
    const n = Number.parseInt(pos, 10);
    if (!Number.isInteger(n) || n < 1 || n > field.length)
      return { kind: 'error', code: 'seeding_invalid' };
    if (reason === '') return { kind: 'error', code: 'reason_required' };
    overrides.push({ participantId, toPosition: n, reason: reason.slice(0, 300) });
  }
  if (overrides.length > 0) body.overrides = overrides;
  return { kind: 'ok', body };
}

/** Seconds after the start → "+m:ss" (interval starts); null stays empty. */
export function startOffset(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `+${m}:${String(s).padStart(2, '0')}`;
}
