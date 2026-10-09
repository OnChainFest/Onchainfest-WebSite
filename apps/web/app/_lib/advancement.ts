import { apiRequest, type ApiResult } from './platform';

/**
 * ONCF-05D organizer advancement: who occupies each next-stage slot and why. The API computes
 * everything (preview, states, provenance) from official results under the pinned AdvancementPolicy;
 * this module only reads it and labels it. Confirming sends back the preview hash the organizer saw
 * — if anything changed meanwhile the API refuses and the page shows the new preview.
 */

export type TargetState = 'UNRESOLVED' | 'RESOLVED' | 'VACANT' | 'STALE' | 'OVERRIDDEN';

export type AdvancementTarget =
  | { kind: 'SLOT'; contestId: string; slot: number }
  | { kind: 'FIELD'; transitionKey: string; ordinal: number };

export interface Provenance {
  family: string;
  source: {
    kind: string;
    contestId?: string;
    stageKey?: string;
    groupKey?: string;
    rank?: number;
    ordinal?: number;
    transitionKey?: string;
  };
  result?: { contestId: string; resultVersionId: string; status: string; outcome: string };
  classification?: {
    stageKey: string;
    groupKey?: string;
    throughRound?: number;
    position?: number;
    tied?: boolean;
  };
  heat?: { contestId: string; place: number };
  comparison?: {
    participantId: string;
    groupKey: string;
    values: { key: string; value: string }[];
  }[];
  candidates?: string[];
  decidedBy?: 'SEED';
  replaces?: { participantId?: string };
}

export interface AdvancementState {
  eventId: string;
  policy: { code: string; version: number; specHash: string } | null;
  commitMode: 'CONFIRM' | 'AUTOMATIC' | null;
  advancement: 'NOT_APPLICABLE' | 'POLICY_NOT_PINNED' | 'NO_ADVANCEMENT_REQUIRED' | 'REQUIRED';
  units: {
    unitKey: string;
    kind: 'CONTEST' | 'RANK' | 'BEST' | 'FIELD';
    families: string[];
    complete: boolean;
    previewHash: string;
    needsCommit: boolean;
    targets: {
      target: AdvancementTarget;
      label: {
        stageKey: string | null;
        round: string | null;
        contestPlanKey: string | null;
        contestSequence: number | null;
        contestStatus: string | null;
        place: number;
      };
      state: TargetState;
      current: { participantId: string | null; decisionKind: string; recordedAt: string } | null;
      proposed: {
        state: 'RESOLVED' | 'VACANT' | 'PENDING' | 'HELD';
        participantId: string | null;
        reason: string | null;
        provenance: Provenance;
      };
    }[];
  }[];
}

export interface TargetHistory {
  facts: {
    participantId: string | null;
    recordedAt: string;
    status: 'CURRENT' | 'INVALIDATED' | 'REPLACED';
    decision: { kind: string; documentHash: string; reason: string | null };
    provenance: Provenance | null;
  }[];
}

export function advancementState(
  token: string,
  eventId: string,
): Promise<ApiResult<AdvancementState>> {
  return apiRequest(token, 'GET', `/v1/events/${eventId}/advancement`);
}

export function targetHistory(
  token: string,
  eventId: string,
  target: AdvancementTarget,
): Promise<ApiResult<TargetHistory>> {
  const q =
    target.kind === 'SLOT'
      ? `contest=${target.contestId}&slot=${target.slot}`
      : `transition=${target.transitionKey}&ordinal=${target.ordinal}`;
  return apiRequest(token, 'GET', `/v1/events/${eventId}/advancement/history?${q}`);
}

/** Target ↔ form field (one hidden input carries the whole target). */
export function encodeTarget(t: AdvancementTarget): string {
  return t.kind === 'SLOT'
    ? `slot:${t.contestId}:${t.slot}`
    : `field:${t.transitionKey}:${t.ordinal}`;
}

export function decodeTarget(raw: string): AdvancementTarget | undefined {
  const slot = /^slot:([0-9a-f-]{36}):([1-9][0-9]?)$/.exec(raw);
  if (slot !== null) return { kind: 'SLOT', contestId: slot[1] as string, slot: Number(slot[2]) };
  const field = /^field:(t[0-9]{1,2}):([1-9][0-9]{0,4})$/.exec(raw);
  if (field !== null)
    return { kind: 'FIELD', transitionKey: field[1] as string, ordinal: Number(field[2]) };
  return undefined;
}

export const STATE_LABEL: Record<TargetState, string> = {
  UNRESOLVED: 'Pending',
  RESOLVED: 'Resolved',
  VACANT: 'Vacant',
  STALE: 'Stale — re-resolve',
  OVERRIDDEN: 'Overridden',
};

const REASON_LABEL: Record<string, string> = {
  RESULT_MISSING: 'No result yet',
  RESULT_NOT_OFFICIAL: 'Result not official yet',
  SOURCE_CANCELLED: 'Source contest cancelled — needs a decision',
  UPSTREAM_STALE: 'An earlier slot changed — resolve it first',
  SOURCE_OCCUPANTS_CHANGED: 'The source contest’s entrants changed',
  NO_WINNER: 'The result names no winner — needs a decision',
  CLASSIFICATION_INCOMPLETE: 'Classification not complete',
  CLASSIFICATION_UNAVAILABLE: 'Classification unavailable',
  TEMPLATE_NOT_PINNED: 'No classification is pinned for that stage',
  TIE_AT_BOUNDARY: 'Tie — needs a decision (play-off, lot)',
  CROSS_GROUP_ORDER_MISSING: 'The policy does not compare groups',
  CROSS_GROUP_VALUE_MISSING: 'A compared value is missing',
  ENTRANT_WITHDRAWN: 'Entrant withdrew',
  NO_ENTRANT_AT_PLACE: 'Nobody at that place',
  NOT_SELECTED: 'No longer selected',
  CONTEST_RESULT_INVALID: 'A stored result does not validate',
};

export function reasonLabel(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  return REASON_LABEL[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}

const FAMILY_LABEL: Record<string, string> = {
  DIRECT_WINNER: 'Winner',
  DIRECT_LOSER: 'Loser',
  GROUP_RANK: 'Group rank',
  TOP_N: 'Top N',
  BEST_N_ACROSS_GROUPS: 'Best across groups',
  CUT: 'Cut',
  STAGE_TOTAL: 'Stage total',
  MANUAL_OVERRIDE: 'Organizer decision',
};

/** "Why is this entrant here?" — one line from structured provenance (never invented). */
export function provenanceLine(p: Provenance, contestName: (id: string) => string): string {
  const family = FAMILY_LABEL[p.family] ?? p.family;
  const parts: string[] = [];
  if (p.source.kind === 'WINNER_OF_CONTEST' || p.source.kind === 'LOSER_OF_CONTEST')
    parts.push(`${family} of ${contestName(p.source.contestId ?? '')}`);
  else if (p.source.groupKey !== undefined && p.source.rank !== undefined)
    parts.push(`${family}: group ${p.source.groupKey.slice(1)} · place ${p.source.rank}`);
  else if (p.source.kind === 'BEST_RANKED_FROM_STAGE')
    parts.push(
      `${family}: ${ordinal(p.source.ordinal ?? 1)} best of the place-${p.source.rank} entrants`,
    );
  else if (p.source.kind === 'RANK_FROM_STAGE') parts.push(`${family}: place ${p.source.rank}`);
  else parts.push(`${family}: field place ${p.source.ordinal}`);
  if (p.result !== undefined) parts.push(`${p.result.status.toLowerCase()} result`);
  if (p.heat !== undefined)
    parts.push(`${ordinal(p.heat.place)} in ${contestName(p.heat.contestId)}`);
  if (p.classification?.position !== undefined)
    parts.push(
      `classified ${p.classification.position}${p.classification.tied === true ? '=' : ''}${
        p.classification.throughRound === undefined
          ? ''
          : ` after round ${p.classification.throughRound}`
      }`,
    );
  if (p.decidedBy === 'SEED') parts.push('tie broken by seed');
  return parts.join(' · ');
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

/** Contest id → "Round · #n" from the public bracket (names in provenance; no private data). */
export async function contestNames(
  token: string,
  competitionSlug: string,
  eventSlug: string,
): Promise<Map<string, string>> {
  const r = await apiRequest<{
    rounds: { label: string; contests: { contestId: string; sequence: number }[] }[];
  }>(token, 'GET', `/v1/competitions/${competitionSlug}/events/${eventSlug}/bracket`);
  const out = new Map<string, string>();
  if (r.kind === 'ok')
    for (const round of r.data.rounds)
      for (const c of round.contests) out.set(c.contestId, `${round.label} · #${c.sequence}`);
  return out;
}
