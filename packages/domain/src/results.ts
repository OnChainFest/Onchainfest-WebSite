import type { Uuid } from './ids';
import type { Instant } from './time';

/** BRT-01 result domain §7. DRAFT lives in the mutable draft table (BRT-02 persistence §3.2). */
export const ResultVersionStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  PROVISIONAL: 'PROVISIONAL',
  OFFICIAL: 'OFFICIAL',
  FINAL: 'FINAL',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
  REVOKED: 'REVOKED',
} as const;
export type ResultVersionStatus = (typeof ResultVersionStatus)[keyof typeof ResultVersionStatus];

/** Statuses in which a version may be the Result's current version (invariant R-2). */
export const CURRENT_ELIGIBLE_STATUSES: readonly ResultVersionStatus[] = [
  'PROVISIONAL',
  'OFFICIAL',
  'FINAL',
];

export const TransitionCode = {
  T2: 'T2', // DRAFT → SUBMITTED
  T3: 'T3', // SUBMITTED → PROVISIONAL
  T4: 'T4', // SUBMITTED → REJECTED
  T5: 'T5', // PROVISIONAL → OFFICIAL      (ONCF-05D, capability DECLARE_OFFICIAL)
  T6: 'T6', // OFFICIAL → FINAL            (not implemented)
  T7: 'T7', // → SUPERSEDED                (ONCF-05D, only inside an atomic correction)
  T8: 'T8', // → REVOKED                   (not implemented)
} as const;
export type TransitionCode = (typeof TransitionCode)[keyof typeof TransitionCode];

export interface TransitionRule {
  readonly code: TransitionCode;
  readonly from: ResultVersionStatus;
  readonly to: ResultVersionStatus;
}

/**
 * Transitions implemented (BRT-03: T2–T4; ONCF-05D: T5 and T7, ADR-0064). No transition ever goes
 * backwards (R-3). T7 is never requested on its own: it is recorded only by an atomic correction,
 * in the same transaction that makes the correcting version current (`CORRECTION_TRANSITIONS`).
 */
export const IMPLEMENTED_TRANSITIONS: readonly TransitionRule[] = [
  { code: 'T2', from: 'DRAFT', to: 'SUBMITTED' },
  { code: 'T3', from: 'SUBMITTED', to: 'PROVISIONAL' },
  { code: 'T4', from: 'SUBMITTED', to: 'REJECTED' },
  { code: 'T5', from: 'PROVISIONAL', to: 'OFFICIAL' },
];

/** T7: the current version a correction replaces (PROVISIONAL or OFFICIAL) becomes SUPERSEDED. */
export const CORRECTION_TRANSITIONS: readonly TransitionRule[] = [
  { code: 'T7', from: 'PROVISIONAL', to: 'SUPERSEDED' },
  { code: 'T7', from: 'OFFICIAL', to: 'SUPERSEDED' },
];

export function findTransition(
  from: ResultVersionStatus,
  to: ResultVersionStatus,
): TransitionRule | undefined {
  return IMPLEMENTED_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export const ResultScopeType = {
  CONTEST: 'CONTEST',
  ROUND_CLASSIFICATION: 'ROUND_CLASSIFICATION',
  EVENT_CLASSIFICATION: 'EVENT_CLASSIFICATION',
  COMPETITION_CLASSIFICATION: 'COMPETITION_CLASSIFICATION',
} as const;
export type ResultScopeType = (typeof ResultScopeType)[keyof typeof ResultScopeType];

export const ResultOutcome = {
  WIN: 'WIN',
  LOSS: 'LOSS',
  DRAW: 'DRAW',
  RANKED: 'RANKED',
  DNS: 'DNS',
  DNF: 'DNF',
  DQ: 'DQ',
  WALKOVER_WIN: 'WALKOVER_WIN',
  WALKOVER_LOSS: 'WALKOVER_LOSS',
  RETIRED: 'RETIRED',
  NO_CONTEST: 'NO_CONTEST',
  // ONCF-05C (ADR-0062): field statuses. NOT_PLACED = finished but not placed (e.g. outside a time
  // limit relative to the winner); PULLED = taken out of a lapped race (classified by laps down).
  NOT_PLACED: 'NOT_PLACED',
  PULLED: 'PULLED',
} as const;
export type ResultOutcome = (typeof ResultOutcome)[keyof typeof ResultOutcome];

/** BRT-01 §4.1 — value is a canonical decimal string with exactly `precision` fraction digits. */
export interface Mark {
  readonly metricId: string;
  readonly value: string;
  readonly unit: string;
  readonly precision: number;
}

export interface ResultEntry {
  readonly participantId: Uuid;
  readonly outcome: ResultOutcome;
  readonly rank?: number;
  readonly primaryMark?: Mark;
}

export interface Performance {
  readonly participantId: Uuid;
  readonly athleteId?: Uuid;
  readonly ordinal: number;
  readonly mark: Mark;
  readonly valid?: boolean;
}

/**
 * Sport-neutral content envelope for BRT-03 (schema `br:result-version-content@1`).
 * Discipline-specific `components` arrive with the Sports Catalog (future phase).
 */
export interface ResultVersionContent {
  readonly entries: readonly ResultEntry[];
  readonly performances?: readonly Performance[];
}

export interface Result {
  readonly id: Uuid;
  readonly scopeType: ResultScopeType;
  readonly scopeTargetId: Uuid;
  readonly recordedAt: Instant;
}

export interface ResultVersion {
  readonly id: Uuid;
  readonly resultId: Uuid;
  readonly versionNumber: number;
  readonly disciplineVersionRef: string;
  readonly content: ResultVersionContent;
  readonly contentHash: string;
  readonly contentSchema: string;
  readonly submittedByPrincipalId: Uuid;
  readonly recordedAt: Instant;
  readonly supersedesVersionId?: Uuid;
}
