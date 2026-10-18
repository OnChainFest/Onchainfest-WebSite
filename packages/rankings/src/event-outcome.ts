import {
  buildPreimage,
  serializeJcs,
  sha256,
  toContentHash,
  type CanonicalValue,
  type ContentHash,
} from '@br/canonical';
import { contestDecision, type NormalizedContestResult } from '@br/competition';
import type { ClassificationV2Document } from './classification-engine-v2';
import type { ClassificationPolicyV2Spec } from './classification-policy-v2';

/**
 * event-outcome/1 — ONCF-L6 (ADR-0078 §2.5). Pure and deterministic:
 *
 *   eventOutcome(input) → EventOutcomeDocument (+ its canonical hash)
 *
 * The sporting outcome of ONE event (category), derived on read from its FINAL stage — the stage
 * with the highest sequence, never "the round typed FINAL" (a qualifying stage ends with one too):
 *   KNOCKOUT / STEPLADDER  the final's winner and loser (the advancement winner rule,
 *                          `contestDecision`); third from a third-place play-off when one exists
 *                          and was decided, otherwise the losers of the contests that fed the final
 *                          share it (two semifinal losers → joint third; a stepladder → one);
 *   STANDINGS / METRIC     classification-engine/2's positions for the final stage;
 *   GROUPS                 one table per group, and no champion across independent groups;
 *   NOT_SUPPORTED          no stage graph (v1 engines) or no classification for the final stage.
 * The caller passes only OFFICIAL (or FINAL) evidence and classifications computed at the OFFICIAL
 * floor (ADR-0078 §2.5). Rules it never breaks: no invented runner-up or fourth place, shared
 * positions stay shared, an organizer lot that was never drawn stays a shared position
 * (TIE_UNBROKEN_LOT), and nothing is persisted (the outcome is derived, hashed, never stored).
 */

export const EVENT_OUTCOME_ENGINE = 'event-outcome/1';

export type EventOutcomeKind = 'KNOCKOUT' | 'STEPLADDER' | 'STANDINGS' | 'METRIC' | 'GROUPS';
export type EventOutcomeStatus = 'DECIDED' | 'PENDING' | 'UNDECIDED' | 'NOT_SUPPORTED';
export type EventOutcomeReason =
  | 'ENGINE_V1'
  | 'STRUCTURE_UNRECOGNIZED'
  | 'CLASSIFICATION_UNAVAILABLE'
  | 'CLASSIFICATION_INCOMPLETE'
  | 'DYNAMIC_ROUND_PENDING'
  | 'FINAL_NOT_OFFICIAL'
  | 'FINAL_NO_WINNER'
  | 'FINAL_VOID'
  | 'FINAL_CANCELLED'
  | 'FINAL_VACANT'
  | 'FINAL_OCCUPANTS_CHANGED'
  | 'THIRD_PLACE_NOT_OFFICIAL'
  | 'THIRD_PLACE_NO_WINNER'
  | 'SEMIFINAL_NOT_OFFICIAL'
  | 'TIE_UNBROKEN_LOT'
  | 'GROUPS_NO_CHAMPION';

export interface EventOutcomeContest {
  readonly contestId: string;
  readonly stageKey: string;
  readonly roundKey: string;
  readonly roundType: string;
  readonly groupKey?: string;
  /** Contest lifecycle status (PLANNED … COMPLETED, CANCELLED, VOID). */
  readonly status: string;
  /** Current occupants in place order; null = not (yet) occupied. */
  readonly occupants: readonly (string | null)[];
  /** A dependent place was decided vacant (advancement: nobody). */
  readonly vacant: boolean;
  /** Dependent places fed by another contest's winner or loser. */
  readonly feeders: readonly {
    readonly kind: 'WINNER_OF_CONTEST' | 'LOSER_OF_CONTEST';
    readonly contestId: string;
  }[];
  /** The current OFFICIAL / FINAL result, already re-validated under the pinned ruleset. */
  readonly evidence?: {
    readonly resultVersionId: string;
    readonly contentHash: string;
    readonly result: NormalizedContestResult;
  };
}

export interface EventOutcomeInput {
  readonly eventId: string;
  readonly stages: readonly {
    readonly key: string;
    readonly sequence: number;
    readonly primitive: 'KNOCKOUT' | 'ROUND_ROBIN' | 'FIELD' | 'HEATS';
  }[];
  readonly transitions: readonly {
    readonly kind: string;
    readonly fromStage: string;
    readonly toStage: string;
  }[];
  readonly rounds: readonly {
    readonly key: string;
    readonly stageKey: string;
    readonly groupKey?: string;
    /** A round whose contests are materialized by advancement (a cut / elimination). */
    readonly dynamic: boolean;
  }[];
  readonly contests: readonly EventOutcomeContest[];
  /** Final-stage classifications at the OFFICIAL floor (one per group for grouped stages). */
  readonly classifications: readonly {
    readonly groupKey?: string;
    readonly policy: ClassificationPolicyV2Spec;
    readonly document: ClassificationV2Document;
  }[];
}

export interface EventOutcomePlacement {
  readonly participantId: string;
  readonly position: number;
  readonly tied: boolean;
  readonly basis:
    | { readonly kind: 'CONTEST'; readonly contestId: string; readonly as: 'WINNER' | 'LOSER' }
    | { readonly kind: 'CLASSIFICATION'; readonly stageKey: string; readonly groupKey?: string };
}

export interface EventOutcomeDocument {
  readonly engine: typeof EVENT_OUTCOME_ENGINE;
  readonly eventId: string;
  readonly finalStageKey?: string;
  readonly kind?: EventOutcomeKind;
  readonly status: EventOutcomeStatus;
  readonly reasons: readonly {
    readonly code: EventOutcomeReason;
    readonly contestIds?: readonly string[];
  }[];
  /** Knockout / stepladder: the podium (and fourth after a play-off). Otherwise the classified entries. */
  readonly placements: readonly EventOutcomePlacement[];
  readonly standings: readonly {
    readonly groupKey?: string;
    readonly document: ClassificationV2Document;
  }[];
  /** Every official result the outcome read (contest id order). */
  readonly inputs: readonly {
    readonly contestId: string;
    readonly resultVersionId: string;
    readonly contentHash: string;
  }[];
}

export interface EventOutcome {
  readonly document: EventOutcomeDocument;
  readonly hash: ContentHash;
}

/** Positions 1–3 of an outcome (ties included; never an invented place). */
export function podium(document: EventOutcomeDocument): readonly EventOutcomePlacement[] {
  return document.placements.filter((p) => p.position <= 3);
}

type Reason = EventOutcomeDocument['reasons'][number];
type Input = EventOutcomeDocument['inputs'][number];

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** JCS has no undefined: an absent value is an omitted member. */
function omitAbsent(value: unknown): CanonicalValue {
  if (Array.isArray(value)) return value.map(omitAbsent);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, omitAbsent(v)]),
    );
  return value as CanonicalValue;
}

function hashOf(document: EventOutcomeDocument): ContentHash {
  const bytes = new TextEncoder().encode(serializeJcs(omitAbsent(document)));
  return toContentHash(sha256(buildPreimage('derived-view', 'br:event-outcome', 1, bytes)));
}

function finish(
  base: Pick<EventOutcomeDocument, 'eventId' | 'finalStageKey' | 'kind'>,
  status: EventOutcomeStatus,
  reasons: readonly Reason[],
  placements: readonly EventOutcomePlacement[],
  standings: EventOutcomeDocument['standings'],
  inputs: readonly Input[],
): EventOutcome {
  const unique = new Map<string, Input>();
  for (const i of inputs) unique.set(i.contestId, i);
  const document: EventOutcomeDocument = {
    engine: EVENT_OUTCOME_ENGINE,
    eventId: base.eventId,
    ...(base.finalStageKey === undefined ? {} : { finalStageKey: base.finalStageKey }),
    ...(base.kind === undefined ? {} : { kind: base.kind }),
    status,
    reasons: reasons.map((r) =>
      r.contestIds === undefined ? r : { ...r, contestIds: [...r.contestIds].sort(byStr) },
    ),
    placements: [...placements].sort(
      (a, b) => a.position - b.position || byStr(a.participantId, b.participantId),
    ),
    standings: [...standings].sort((a, b) => byStr(a.groupKey ?? '', b.groupKey ?? '')),
    inputs: [...unique.values()].sort((a, b) => byStr(a.contestId, b.contestId)),
  };
  return { document, hash: hashOf(document) };
}

const evidenceInput = (c: EventOutcomeContest): Input[] =>
  c.evidence === undefined
    ? []
    : [
        {
          contestId: c.contestId,
          resultVersionId: c.evidence.resultVersionId,
          contentHash: c.evidence.contentHash,
        },
      ];

type Decision =
  | {
      readonly state: 'DECIDED';
      readonly winner: string;
      readonly loser: string;
    }
  | { readonly state: 'PENDING' | 'UNDECIDED'; readonly reason: 'NOT_OFFICIAL' | 'NO_WINNER' }
  | { readonly state: 'UNDECIDED'; readonly reason: 'VOID' | 'CANCELLED' | 'VACANT' | 'CHANGED' };

/** One head-to-head contest, decided only by an official result naming exactly its occupants. */
function decide(c: EventOutcomeContest): Decision {
  if (c.status === 'VOID') return { state: 'UNDECIDED', reason: 'VOID' };
  if (c.status === 'CANCELLED') return { state: 'UNDECIDED', reason: 'CANCELLED' };
  if (c.vacant) return { state: 'UNDECIDED', reason: 'VACANT' };
  if (c.evidence === undefined) return { state: 'PENDING', reason: 'NOT_OFFICIAL' };
  const occupants = c.occupants.flatMap((o) => (o === null ? [] : [o])).sort(byStr);
  const inResult = c.evidence.result.entries.map((e) => e.participantId).sort(byStr);
  if (occupants.length !== c.occupants.length || occupants.join() !== inResult.join())
    return { state: 'UNDECIDED', reason: 'CHANGED' };
  const d = contestDecision(c.evidence.result);
  if (d === undefined) return { state: 'UNDECIDED', reason: 'NO_WINNER' };
  return { state: 'DECIDED', winner: d.winner.participantId, loser: d.loser.participantId };
}

const FINAL_REASON: Record<string, EventOutcomeReason> = {
  NOT_OFFICIAL: 'FINAL_NOT_OFFICIAL',
  NO_WINNER: 'FINAL_NO_WINNER',
  VOID: 'FINAL_VOID',
  CANCELLED: 'FINAL_CANCELLED',
  VACANT: 'FINAL_VACANT',
  CHANGED: 'FINAL_OCCUPANTS_CHANGED',
};

const contestBasis = (contestId: string, as: 'WINNER' | 'LOSER') =>
  ({ kind: 'CONTEST', contestId, as }) as const;

function knockout(
  input: EventOutcomeInput,
  base: Pick<EventOutcomeDocument, 'eventId' | 'finalStageKey' | 'kind'>,
  stageKey: string,
): EventOutcome {
  const inStage = input.contests.filter((c) => c.stageKey === stageKey);
  const finals = inStage.filter((c) => c.roundType === 'FINAL');
  const final = finals[0];
  if (final === undefined || finals.length !== 1)
    return finish(base, 'NOT_SUPPORTED', [{ code: 'STRUCTURE_UNRECOGNIZED' }], [], [], []);
  const byId = new Map(input.contests.map((c) => [c.contestId, c]));
  const fd = decide(final);
  if (fd.state !== 'DECIDED')
    return finish(
      base,
      fd.state,
      [{ code: FINAL_REASON[fd.reason] as EventOutcomeReason, contestIds: [final.contestId] }],
      [],
      [],
      evidenceInput(final),
    );
  const inputs: Input[] = evidenceInput(final);
  const placements: EventOutcomePlacement[] = [
    {
      participantId: fd.winner,
      position: 1,
      tied: false,
      basis: contestBasis(final.contestId, 'WINNER'),
    },
    {
      participantId: fd.loser,
      position: 2,
      tied: false,
      basis: contestBasis(final.contestId, 'LOSER'),
    },
  ];
  const fedBy = final.feeders
    .filter((f) => f.kind === 'WINNER_OF_CONTEST')
    .map((f) => f.contestId)
    .sort(byStr);
  const fedSet = new Set(fedBy);
  // The third-place play-off: a contest of the stage fed only by the losers of the final's feeders.
  const playoff = inStage.find(
    (c) =>
      c.contestId !== final.contestId &&
      c.feeders.length > 0 &&
      c.feeders.every((f) => f.kind === 'LOSER_OF_CONTEST' && fedSet.has(f.contestId)),
  );
  if (playoff !== undefined && playoff.status !== 'CANCELLED' && playoff.status !== 'VOID') {
    const pd = decide(playoff);
    inputs.push(...evidenceInput(playoff));
    if (pd.state !== 'DECIDED')
      return finish(
        base,
        pd.state === 'PENDING' ? 'PENDING' : 'UNDECIDED',
        [
          {
            code: pd.state === 'PENDING' ? 'THIRD_PLACE_NOT_OFFICIAL' : 'THIRD_PLACE_NO_WINNER',
            contestIds: [playoff.contestId],
          },
        ],
        [],
        [],
        inputs,
      );
    placements.push(
      {
        participantId: pd.winner,
        position: 3,
        tied: false,
        basis: contestBasis(playoff.contestId, 'WINNER'),
      },
      {
        participantId: pd.loser,
        position: 4,
        tied: false,
        basis: contestBasis(playoff.contestId, 'LOSER'),
      },
    );
    return finish(base, 'DECIDED', [], placements, [], inputs);
  }
  // No play-off (or it was not played): the losers of the contests that fed the final share third.
  const thirds: EventOutcomePlacement[] = [];
  const pending: string[] = [];
  for (const id of fedBy) {
    const feeder = byId.get(id);
    if (feeder === undefined) continue;
    const d = decide(feeder);
    inputs.push(...evidenceInput(feeder));
    if (d.state === 'DECIDED')
      thirds.push({
        participantId: d.loser,
        position: 3,
        tied: false,
        basis: contestBasis(feeder.contestId, 'LOSER'),
      });
    else if (d.state === 'PENDING') pending.push(feeder.contestId);
  }
  if (pending.length > 0)
    return finish(
      base,
      'PENDING',
      [{ code: 'SEMIFINAL_NOT_OFFICIAL', contestIds: pending }],
      [],
      [],
      inputs,
    );
  const tied = thirds.length > 1;
  placements.push(...thirds.map((t) => ({ ...t, tied })));
  return finish(base, 'DECIDED', [], placements, [], inputs);
}

/** The policy decides ties by an organizer lot as its last resort. */
function lotPolicy(policy: ClassificationPolicyV2Spec): boolean {
  const last =
    policy.family === 'STANDINGS'
      ? policy.criteria[policy.criteria.length - 1]
      : policy.tieBreak[policy.tieBreak.length - 1];
  return last?.kind === 'ORGANIZER_LOT';
}

function classified(
  input: EventOutcomeInput,
  base: Pick<EventOutcomeDocument, 'eventId' | 'finalStageKey' | 'kind'>,
  stageKey: string,
  groups: readonly string[],
): EventOutcome {
  const grouped = groups.length > 1;
  const wanted = grouped ? groups : [undefined];
  const tables = wanted.map((g) => input.classifications.find((c) => c.groupKey === g));
  if (tables.some((t) => t === undefined) || tables.length === 0)
    return finish(base, 'NOT_SUPPORTED', [{ code: 'CLASSIFICATION_UNAVAILABLE' }], [], [], []);
  const present = tables as NonNullable<(typeof tables)[number]>[];
  const standings = present.map((t) => ({
    ...(t.groupKey === undefined ? {} : { groupKey: t.groupKey }),
    document: t.document,
  }));
  const inputs: Input[] = present.flatMap((t) =>
    t.document.inputs.flatMap((i) =>
      i.resultVersionId === undefined || i.contentHash === undefined
        ? []
        : [
            {
              contestId: i.contestId,
              resultVersionId: i.resultVersionId,
              contentHash: i.contentHash,
            },
          ],
    ),
  );
  const reasons: Reason[] = [];
  // A dynamic round (after a cut) not materialized yet is invisible to the classification.
  const contestsByRound = new Set(
    input.contests.filter((c) => c.stageKey === stageKey).map((c) => c.roundKey),
  );
  const unmaterialized = input.rounds.filter(
    (r) => r.stageKey === stageKey && r.dynamic && !contestsByRound.has(r.key),
  );
  if (unmaterialized.length > 0) reasons.push({ code: 'DYNAMIC_ROUND_PENDING' });
  // Complete = every contest of the stage that can still decide something is an official input.
  // CANCELLED and VOID contests decide nothing (ADR-0066), and a contest whose every place was
  // decided vacant is not part of the stage — none of them keeps the outcome pending.
  const counted = new Set(
    present.flatMap((t) =>
      t.document.inputs.flatMap((i) => (i.resultVersionId === undefined ? [] : [i.contestId])),
    ),
  );
  const outstanding = input.contests.filter(
    (c) =>
      c.stageKey === stageKey &&
      c.status !== 'CANCELLED' &&
      c.status !== 'VOID' &&
      !(c.vacant && c.occupants.every((o) => o === null)) &&
      !counted.has(c.contestId),
  );
  if (outstanding.length > 0)
    reasons.push({
      code: 'CLASSIFICATION_INCOMPLETE',
      contestIds: outstanding.map((c) => c.contestId),
    });
  if (reasons.length > 0) return finish(base, 'PENDING', reasons, [], standings, inputs);
  if (present.some((t) => lotPolicy(t.policy) && t.document.entries.some((e) => e.tied)))
    reasons.push({ code: 'TIE_UNBROKEN_LOT' });
  if (grouped) {
    reasons.push({ code: 'GROUPS_NO_CHAMPION' });
    return finish(base, 'DECIDED', reasons, [], standings, inputs);
  }
  const table = present[0] as (typeof present)[number];
  const placements: EventOutcomePlacement[] = table.document.entries
    .filter((e) => e.status === 'CLASSIFIED')
    .map((e) => ({
      participantId: e.participantId,
      position: e.position,
      tied: e.tied,
      basis: { kind: 'CLASSIFICATION', stageKey },
    }));
  return finish(base, 'DECIDED', reasons, placements, standings, inputs);
}

export function eventOutcome(input: EventOutcomeInput): EventOutcome {
  const finalStage = [...input.stages].sort((a, b) => b.sequence - a.sequence)[0];
  if (finalStage === undefined)
    return finish({ eventId: input.eventId }, 'NOT_SUPPORTED', [{ code: 'ENGINE_V1' }], [], [], []);
  const groups = [
    ...new Set(
      input.rounds.flatMap((r) =>
        r.stageKey === finalStage.key && r.groupKey !== undefined ? [r.groupKey] : [],
      ),
    ),
  ].sort(byStr);
  const kind: EventOutcomeKind =
    finalStage.primitive === 'KNOCKOUT'
      ? input.transitions.some((t) => t.toStage === finalStage.key && t.kind === 'STEPLADDER')
        ? 'STEPLADDER'
        : 'KNOCKOUT'
      : finalStage.primitive === 'ROUND_ROBIN'
        ? groups.length > 1
          ? 'GROUPS'
          : 'STANDINGS'
        : 'METRIC';
  const base = { eventId: input.eventId, finalStageKey: finalStage.key, kind };
  return kind === 'KNOCKOUT' || kind === 'STEPLADDER'
    ? knockout(input, base, finalStage.key)
    : classified(input, base, finalStage.key, groups);
}
