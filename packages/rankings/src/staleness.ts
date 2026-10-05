import { CanonicalError, type ContentHash } from '@br/canonical';
import type { ClassificationStaleReason, RankingSnapshotStaleReason } from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  classificationCorrectionImpact,
  type ClassificationDerivation,
} from './classification-engine';
import type { RankingSnapshotContent } from './documents';

/**
 * BRT-10 staleness (ADR-0047 §5, ADR-0048 §8) — computed, NEVER stored. Pure: the caller observes the
 * current canonical state (persistence) and these functions decide, deterministically, from the
 * immutable pins alone. Nothing here creates a correction, a replacement or a new version: a stale
 * classification stays current and visibly STALE until a T7 producer exists (ADR-0047 §6), and a stale
 * snapshot stays published until a correcting run exists (no producer).
 */

/** One exact input a classification pins (statuses are not part of identity: upgrades are not impact). */
export interface ClassificationPin {
  readonly resultVersionId: string;
  readonly contentHash: string;
}

/** What the caller observed of the current canonical state, at one point in time. */
export interface ClassificationObservation {
  /**
   * Pinned resultVersionId → whether it is still the current (not superseded / revoked / rejected)
   * version of its Result. Absent ⇒ unknown ⇒ affected: unknown never counts as fresh.
   */
  readonly current: ReadonlyMap<string, boolean>;
  /**
   * The scope's current admissible inputs under the classification's PINNED policy version and
   * DisciplineVersion. `undefined` ⇒ the scope could not be re-assembled ⇒ ADMISSIBLE_INPUT_SET_UNKNOWN.
   */
  readonly admissible: readonly ClassificationPin[] | undefined;
}

/** `br:classification-staleness@1`: why one classification version is STALE (hash = staleDigest). */
export interface ClassificationStalenessDocument {
  readonly classificationVersionId: string;
  readonly contentHash: string;
  readonly inputsDigest: string;
  readonly reasons: readonly ClassificationStaleReason[];
  readonly notCurrent: readonly ClassificationPin[];
  readonly added: readonly ClassificationPin[];
  readonly removed: readonly ClassificationPin[];
}

export type ClassificationStaleness =
  | { readonly state: 'CURRENT' }
  | {
      readonly state: 'STALE';
      readonly document: ClassificationStalenessDocument;
      /** H(classification-staleness, …): the ClassificationStale idempotency key with the version id. */
      readonly staleDigest: ContentHash;
    };

const byVersionId = (a: ClassificationPin, b: ClassificationPin) =>
  a.resultVersionId < b.resultVersionId ? -1 : a.resultVersionId > b.resultVersionId ? 1 : 0;

/** Distinct pins by resultVersionId, sorted (repeated references never produce repeated entries). */
function pinSet(pins: Iterable<ClassificationPin>): ClassificationPin[] {
  const out = new Map<string, ClassificationPin>();
  for (const p of pins)
    if (!out.has(p.resultVersionId))
      out.set(p.resultVersionId, {
        resultVersionId: p.resultVersionId,
        contentHash: p.contentHash,
      });
  return [...out.values()].sort(byVersionId);
}

export type HashedClassificationStaleness =
  | {
      readonly ok: true;
      readonly value: ClassificationStalenessDocument;
      readonly hash: ContentHash;
    }
  | { readonly ok: false; readonly code: string };

/** H(classification-staleness, br:classification-staleness@1, …) — the staleDigest. */
export function hashClassificationStaleness(doc: unknown): HashedClassificationStaleness {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.classificationStaleness,
      SchemaRef.classificationStaleness.id,
      SchemaRef.classificationStaleness.version,
      doc,
    );
    return {
      ok: true,
      value: r.normalized as unknown as ClassificationStalenessDocument,
      hash: r.contentHash,
    };
  } catch (err) {
    if (err instanceof CanonicalError) return { ok: false, code: err.code };
    throw err;
  }
}

/**
 * Whether a classification version is STALE (ADR-0047 §5):
 *   A. any pinned input is no longer current (or its state is unknown) — exactly the correction impact;
 *   B. the scope's current admissible input set differs from the pinned set (or is unknown).
 * The exact pins are authoritative; statuses are ignored (a status upgrade of the same version is
 * neither impact nor a set change). Pins that are not current are reported once, under A, and never
 * again as `removed`.
 */
export function classificationStaleness(
  version: { readonly resultVersionId: string; readonly contentHash: string },
  derivation: ClassificationDerivation,
  observed: ClassificationObservation,
): ClassificationStaleness {
  const notCurrent = pinSet(classificationCorrectionImpact(derivation, observed.current));
  const pinned = pinSet(derivation.derivedFrom);
  const reasons: ClassificationStaleReason[] = [];
  let added: ClassificationPin[] = [];
  let removed: ClassificationPin[] = [];
  if (observed.admissible === undefined) reasons.push('ADMISSIBLE_INPUT_SET_UNKNOWN');
  else {
    const admissible = pinSet(observed.admissible);
    const pinnedIds = new Set(pinned.map((p) => p.resultVersionId));
    const admissibleIds = new Set(admissible.map((p) => p.resultVersionId));
    const notCurrentIds = new Set(notCurrent.map((p) => p.resultVersionId));
    added = admissible.filter((p) => !pinnedIds.has(p.resultVersionId));
    removed = pinned.filter(
      (p) => !admissibleIds.has(p.resultVersionId) && !notCurrentIds.has(p.resultVersionId),
    );
    if (added.length > 0 || removed.length > 0) reasons.push('ADMISSIBLE_INPUT_SET_CHANGED');
  }
  if (notCurrent.length > 0) reasons.push('PINNED_INPUT_NOT_CURRENT');
  if (reasons.length === 0) return { state: 'CURRENT' };
  const h = hashClassificationStaleness({
    classificationVersionId: version.resultVersionId,
    contentHash: version.contentHash,
    inputsDigest: derivation.inputsDigest,
    reasons,
    notCurrent,
    added,
    removed,
  });
  if (!h.ok) throw new Error(`staleness invariant: document not canonical (${h.code})`);
  return { state: 'STALE', document: h.value, staleDigest: h.hash };
}

/**
 * The `ClassificationStale` outbox payload (ids, hashes and reason codes only — never PII, never
 * content). Deterministic: the same version in the same stale state yields the same payload.
 */
export function classificationStalePayload(
  resultId: string,
  stale: Extract<ClassificationStaleness, { state: 'STALE' }>,
) {
  const d = stale.document;
  return {
    resultId,
    classificationVersionId: d.classificationVersionId,
    contentHash: d.contentHash,
    inputsDigest: d.inputsDigest,
    staleDigest: stale.staleDigest,
    reasons: [...d.reasons],
    notCurrent: d.notCurrent.map((p) => p.resultVersionId),
    added: d.added.map((p) => p.resultVersionId),
    removed: d.removed.map((p) => p.resultVersionId),
  };
}

// ───────────────────────────── ranking snapshots (read-time STALE) ─────────────────────────────

/** One exact basis a snapshot pins: the Performance's ResultVersion and its VerificationRun. */
export interface RankingSnapshotPin {
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly verificationRunId: string;
}

/** The distinct basis pins of a snapshot, sorted (resultVersionId, verificationRunId). */
export function rankingSnapshotDependencies(
  content: Pick<RankingSnapshotContent, 'entries'>,
): readonly RankingSnapshotPin[] {
  const out = new Map<string, RankingSnapshotPin>();
  for (const e of content.entries)
    for (const b of e.basis)
      out.set(`${b.resultVersionId}\u0000${b.verificationRunId}`, {
        resultVersionId: b.resultVersionId,
        contentHash: b.contentHash,
        verificationRunId: b.verificationRunId,
      });
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
}

export interface RankingSnapshotObservation {
  /** resultVersionId → still the current FINAL version of its Result (absent ⇒ unknown ⇒ affected). */
  readonly result: ReadonlyMap<string, boolean>;
  /** resultVersionId → the id of its CURRENT VerificationRun (absent / undefined ⇒ none ⇒ affected). */
  readonly verification: ReadonlyMap<string, string | undefined>;
}

export type RankingSnapshotStaleness =
  | { readonly state: 'CURRENT' }
  | {
      readonly state: 'STALE';
      readonly reasons: readonly RankingSnapshotStaleReason[];
      readonly affected: readonly (RankingSnapshotPin & {
        readonly reasons: readonly RankingSnapshotStaleReason[];
      })[];
    };

/**
 * ADR-0048 §8: a snapshot whose pins are no longer current reads STALE (never stored). Hold state is
 * not a pin: there is no hold producer, so no hold fact can appear after publication (it joins the
 * pin set when a producer exists).
 */
export function rankingSnapshotStaleness(
  content: Pick<RankingSnapshotContent, 'entries'>,
  observed: RankingSnapshotObservation,
): RankingSnapshotStaleness {
  const affected: (RankingSnapshotPin & { reasons: RankingSnapshotStaleReason[] })[] = [];
  for (const p of rankingSnapshotDependencies(content)) {
    const reasons: RankingSnapshotStaleReason[] = [];
    if (observed.result.get(p.resultVersionId) !== true) reasons.push('BASIS_RESULT_NOT_CURRENT');
    const run = observed.verification.get(p.resultVersionId);
    if (run === undefined || run !== p.verificationRunId)
      reasons.push('BASIS_VERIFICATION_NOT_CURRENT');
    if (reasons.length > 0) affected.push({ ...p, reasons });
  }
  if (affected.length === 0) return { state: 'CURRENT' };
  const all = new Set(affected.flatMap((a) => a.reasons));
  return {
    state: 'STALE',
    reasons: (['BASIS_RESULT_NOT_CURRENT', 'BASIS_VERIFICATION_NOT_CURRENT'] as const).filter((r) =>
      all.has(r),
    ),
    affected,
  };
}
