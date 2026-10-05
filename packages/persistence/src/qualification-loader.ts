import {
  sealDerivationSnapshot,
  type QualificationDerivationSnapshot,
  type SealedDerivationSnapshot,
  type SnapshotQualification,
} from '@br/achievements';
import {
  DomainError,
  DomainErrorCode,
  PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS,
  type ResultVersionStatus,
} from '@br/domain';
import {
  validateRankingSnapshot,
  type ClassificationContent,
  type RankingEntry,
} from '@br/rankings';
import { DomainTag, SchemaRef } from '@br/schemas';
import { sql } from 'kysely';
import {
  applicableRules,
  disciplineFacts,
  supersedingVersion,
  verificationSummary,
  type ApplicableRule,
} from './achievement-loader';
import { readClassificationIn } from './classification-staleness';
import { canonicalHash } from './hashing';
import { snapshotStalenessIn } from './ranking-history';
import type { TxContext } from './tx';

/**
 * BRT-10 Step 9 — canonical assembly of a QUALIFIED derivation snapshot (ADR-0050). Loads ONLY the
 * canonical class-A facts the qualification pins, re-verifying every hash, and consumes the Step 7
 * read-time staleness instead of re-implementing it:
 *
 *   ranking source         ranking.run + its published ranking.snapshot (content re-hashed), the
 *                          lineage it declares, whether a correction replaces it, and its STALE state
 *   classification source  the `@2` classification ResultVersion (content re-hashed), its derivation
 *                          header, append-only status, supersession, BRT-07 verification, STALE state
 *
 * It declares exactly the production-supported kinds: HOLD_STATE and TARGET_QUALIFICATION_AUTHORITY
 * have NO producer, so every canonical evaluation is BLOCKED (fail closed) — it never infers a hold's
 * absence and never manufactures the target authority's adoption. It never reads `ranking_read.*`
 * (a projection) and never consumes a REFERENCE_FIXTURE row. Runs under br_achievements (0027 grants,
 * SELECT only) with br_verification_reader for run currency.
 */
export const QUALIFICATION_ASSEMBLER_VERSION = 'qualification-assembler/1';

const integrity = (reason: string, message: string) =>
  new DomainError(DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE, message, { reason });

export type QualifyingSourceRef =
  | { readonly kind: 'RANKING_SNAPSHOT'; readonly snapshotId: string }
  | { readonly kind: 'RANKING_RUN'; readonly runId: string }
  | { readonly kind: 'CLASSIFICATION'; readonly resultVersionId: string };

/** The canonical qualifying-source facts + what selects the QUALIFIED rules that name it. */
export interface QualifyingSourceFacts {
  readonly disciplineVersionId: string;
  /** Rule applicability instant (no retroactivity): publication / run / classification submission. */
  readonly ruleTime: Date;
  readonly competitionId?: string;
  readonly eventId?: string;
  readonly qualification: Omit<SnapshotQualification, 'hold' | 'targetAuthority'>;
  /** Selection keys: the rule's pinned source must name this exact source. */
  readonly select:
    | { readonly kind: 'RANKING_SNAPSHOT_POSITION'; readonly systemId: string }
    | {
        readonly kind: 'CLASSIFICATION_POSITION';
        readonly scopeType: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
        readonly scopeId: string;
      };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pinsOf = (entries: readonly RankingEntry[]) =>
  entries.map((e) => ({
    holder: e.holder,
    rank: e.rank,
    tied: e.tied,
    basis: e.basis.map((b) => ({
      resultVersionId: b.resultVersionId,
      contentHash: b.contentHash,
      participantId: b.participantId,
      verificationRunId: b.verificationRunId,
      verificationSnapshotHash: b.verificationSnapshotHash,
      verificationOutcomeHash: b.verificationOutcomeHash,
      verificationLevel: b.verificationLevel,
      evidenceBundleHash: b.evidenceBundleHash,
      evidenceBundleAsOf: b.evidenceBundleAsOf,
    })),
  }));

async function rankingSource(
  ctx: TxContext,
  ref: { readonly snapshotId?: string; readonly runId?: string },
): Promise<QualifyingSourceFacts | undefined> {
  const { rows: snaps } = await sql<{
    id: string;
    run_id: string;
    snapshot_hash: string;
    content: unknown;
    lineage_kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
    prior_id: string | null;
    prior_snapshot_hash: string | null;
    provenance: string;
    recorded_at: Date;
  }>`
    SELECT id::text AS id, run_id::text AS run_id, snapshot_hash, content, lineage_kind,
           COALESCE(previous_snapshot_id, corrects_snapshot_id)::text AS prior_id, prior_snapshot_hash,
           provenance, recorded_at
    FROM ranking.snapshot
    WHERE (${ref.snapshotId ?? null}::uuid IS NOT NULL AND id = ${ref.snapshotId ?? null}::uuid)
       OR (${ref.runId ?? null}::uuid IS NOT NULL AND run_id = ${ref.runId ?? null}::uuid)`.execute(
    ctx.trx,
  );
  const snap = snaps[0];
  const runId = snap?.run_id ?? ref.runId;
  if (runId === undefined) return undefined;
  const { rows: runs } = await sql<{
    id: string;
    system_id: string;
    system_version_id: string;
    spec_hash: string;
    outcome_hash: string;
    outcome: { entries: RankingEntry[] };
    provenance: string;
    recorded_at: Date;
    discipline_version_id: string;
  }>`
    SELECT r.id::text AS id, r.system_id::text AS system_id, r.system_version_id::text AS system_version_id,
           r.spec_hash, r.outcome_hash, r.outcome, r.provenance, r.recorded_at,
           v.discipline_version_id::text AS discipline_version_id
    FROM ranking.run r JOIN ranking.system_version v ON v.id = r.system_version_id
    WHERE r.id = ${runId}`.execute(ctx.trx);
  const run = runs[0];
  if (run === undefined) return undefined;
  // The canonical lane never consumes a fixture row (overlay databases only).
  if (
    run.provenance !== 'CANONICAL_ASSEMBLY' ||
    (snap !== undefined && snap.provenance !== run.provenance)
  )
    throw integrity('FIXTURE_SOURCE_REFUSED', 'the canonical lane consumes canonical sources only');
  let entries: readonly RankingEntry[] = run.outcome.entries;
  let published: NonNullable<SnapshotQualification['ranking']>['published'];
  let correctedBy: string | undefined;
  if (snap !== undefined) {
    const v = validateRankingSnapshot(snap.content);
    if (!v.ok || v.hash !== snap.snapshot_hash)
      throw integrity('SNAPSHOT_HASH_MISMATCH', 'stored snapshot content does not match its hash');
    entries = v.value.entries;
    published = {
      snapshotId: snap.id,
      snapshotHash: snap.snapshot_hash,
      lineageKind: snap.lineage_kind,
      ...(snap.prior_id === null ? {} : { priorSnapshotId: snap.prior_id }),
      ...(snap.prior_snapshot_hash === null ? {} : { priorSnapshotHash: snap.prior_snapshot_hash }),
    };
    const { rows: by } = await sql<{ id: string }>`
      SELECT id::text AS id FROM ranking.snapshot WHERE corrects_snapshot_id = ${snap.id}`.execute(
      ctx.trx,
    );
    correctedBy = by[0]?.id;
  }
  const staleness = await snapshotStalenessIn(ctx, { entries });
  return {
    disciplineVersionId: run.discipline_version_id,
    ruleTime: snap?.recorded_at ?? run.recorded_at,
    select: { kind: 'RANKING_SNAPSHOT_POSITION', systemId: run.system_id },
    qualification: {
      ranking: {
        systemId: run.system_id,
        systemVersionId: run.system_version_id,
        specHash: run.spec_hash,
        runId: run.id,
        runOutcomeHash: run.outcome_hash,
        ...(published === undefined ? {} : { published }),
        ...(correctedBy === undefined ? {} : { correctedBySnapshotId: correctedBy }),
        staleness:
          staleness.state === 'CURRENT'
            ? { state: 'CURRENT' }
            : { state: 'STALE', reasons: staleness.reasons },
        entries: pinsOf(entries),
      },
    },
  };
}

async function classificationSource(
  ctx: TxContext,
  resultVersionId: string,
): Promise<QualifyingSourceFacts | undefined> {
  const read = await readClassificationIn(ctx, resultVersionId);
  if (read.scopeType !== 'EVENT_CLASSIFICATION' && read.scopeType !== 'COMPETITION_CLASSIFICATION')
    return undefined;
  const scopeType = read.scopeType;
  const { rows } = await sql<{
    content: unknown;
    content_hash: string;
    recorded_at: Date;
    supersedes_version_id: string | null;
    event_competition_id: string | null;
    event_dv: string | null;
  }>`
    SELECT v.content, v.content_hash, v.recorded_at, v.supersedes_version_id::text AS supersedes_version_id,
           e.competition_id::text AS event_competition_id, e.discipline_version_id::text AS event_dv
    FROM results.result_version v LEFT JOIN competition.event e ON e.id = ${read.scopeTargetId}::uuid
    WHERE v.id = ${resultVersionId}`.execute(ctx.trx);
  const row = rows[0];
  if (row === undefined) return undefined;
  const scope =
    scopeType === 'EVENT_CLASSIFICATION'
      ? {
          ...(row.event_competition_id === null ? {} : { competitionId: row.event_competition_id }),
          eventId: read.scopeTargetId,
        }
      : { competitionId: read.scopeTargetId };
  const select = {
    kind: 'CLASSIFICATION_POSITION' as const,
    scopeType,
    scopeId: read.scopeTargetId,
  };
  const d = read.derivation;
  // `@1` content: no derivation provenance ⇒ no classification member (CLASSIFICATION_PROVENANCE_
  // UNAVAILABLE at the gate). Its DisciplineVersion is the event's, when there is one.
  if (d === undefined || read.staleness.state === 'PROVENANCE_UNAVAILABLE') {
    if (row.event_dv === null) return undefined;
    return {
      disciplineVersionId: row.event_dv,
      ruleTime: row.recorded_at,
      ...scope,
      select,
      qualification: {},
    };
  }
  const rehash = canonicalHash(
    DomainTag.resultVersionContent,
    SchemaRef.resultVersionContentV2,
    row.content,
  );
  if (rehash.contentHash !== row.content_hash)
    throw integrity(
      'CONTENT_HASH_MISMATCH',
      'stored classification content does not match its hash',
    );
  const content = rehash.normalized as unknown as ClassificationContent;
  const participantIds = content.entries.map((e) => e.participantId);
  const { rows: parts } = await sql<{
    id: string;
    participant_kind: 'INDIVIDUAL' | 'TEAM';
    athlete_id: string | null;
    team_id: string | null;
  }>`
    SELECT id::text AS id, participant_kind, athlete_id::text AS athlete_id, team_id::text AS team_id
    FROM competition.participant WHERE id = ANY(${participantIds}::uuid[])`.execute(ctx.trx);
  const superseded = await supersedingVersion(ctx, resultVersionId);
  const staleness = read.staleness;
  return {
    disciplineVersionId: d.disciplineVersionId,
    ruleTime: row.recorded_at,
    ...scope,
    select,
    qualification: {
      classification: {
        resultId: read.resultId,
        resultVersionId,
        contentHash: read.contentHash,
        scopeType,
        scopeTargetId: read.scopeTargetId,
        status: read.status as Exclude<ResultVersionStatus, 'DRAFT'>,
        ...(row.supersedes_version_id === null
          ? {}
          : { supersedesVersionId: row.supersedes_version_id }),
        ...(superseded === undefined ? {} : { supersededByVersionId: superseded }),
        policyId: d.policy.policyId,
        policyVersionId: d.policy.policyVersionId,
        policySpecHash: d.policy.specHash,
        disciplineVersionId: d.disciplineVersionId,
        inputsDigest: d.inputsDigest,
        staleness:
          staleness.state === 'STALE'
            ? { state: 'STALE', reasons: staleness.document.reasons }
            : { state: 'CURRENT' },
        verification: await verificationSummary(ctx, resultVersionId),
        entries: content.entries.map((e) => ({
          participantId: e.participantId,
          rank: e.rank,
          tied: e.tied,
        })),
        participants: parts.map((p) => ({
          participantId: p.id,
          kind: p.participant_kind,
          ...(p.athlete_id === null ? {} : { athleteId: p.athlete_id }),
          ...(p.team_id === null ? {} : { teamId: p.team_id }),
        })),
      },
    },
  };
}

/** The canonical facts of one qualifying source (undefined: no such source). */
export async function loadQualifyingSource(
  ctx: TxContext,
  ref: QualifyingSourceRef,
): Promise<QualifyingSourceFacts | undefined> {
  const id =
    ref.kind === 'RANKING_SNAPSHOT'
      ? ref.snapshotId
      : ref.kind === 'RANKING_RUN'
        ? ref.runId
        : ref.resultVersionId;
  if (!UUID.test(id)) return undefined;
  if (ref.kind === 'CLASSIFICATION') {
    try {
      return await classificationSource(ctx, ref.resultVersionId);
    } catch (err) {
      // Not a classification ResultVersion / not found: there is no qualifying source.
      if (
        err instanceof DomainError &&
        (err.code === DomainErrorCode.NOT_FOUND || err.code === DomainErrorCode.INVALID_INPUT)
      )
        return undefined;
      throw err;
    }
  }
  return rankingSource(ctx, ref.kind === 'RANKING_SNAPSHOT' ? { snapshotId: id } : { runId: id });
}

/**
 * The QUALIFIED rules that name this exact source (bound, no retroactivity, at the source's own
 * instant): a ranking source selects rules pinning its ranking SYSTEM (the system VERSION is checked by
 * the engine: QUALIFYING_SOURCE_MISMATCH), a classification selects rules pinning its scope (the
 * policy version is checked by the engine). Never a fallback rule.
 */
export async function qualificationRules(
  ctx: TxContext,
  facts: QualifyingSourceFacts,
): Promise<ApplicableRule[]> {
  return (
    await applicableRules(ctx, {
      disciplineVersionId: facts.disciplineVersionId,
      competitionId: facts.competitionId,
      eventId: facts.eventId,
      submittedAt: facts.ruleTime,
    })
  ).filter((r) => {
    const src = r.spec.criterion.qualification?.source;
    if (
      r.spec.achievementType !== 'QUALIFIED' ||
      src === undefined ||
      src.kind !== facts.select.kind
    )
      return false;
    return facts.select.kind === 'RANKING_SNAPSHOT_POSITION'
      ? src.rankingSystemId === facts.select.systemId
      : src.scopeType === facts.select.scopeType && src.scopeId === facts.select.scopeId;
  });
}

/** The canonical QUALIFIED derivation snapshot of (source, rule). */
export function assembleCanonicalQualificationSnapshot(
  ctx: TxContext,
  facts: QualifyingSourceFacts,
  rule: ApplicableRule,
): Promise<SealedDerivationSnapshot> {
  return disciplineFacts(ctx, facts.disciplineVersionId).then((discipline) => {
    const snapshot: QualificationDerivationSnapshot = {
      provenance: 'CANONICAL_ASSEMBLY',
      assembler: QUALIFICATION_ASSEMBLER_VERSION,
      rule: {
        ruleId: rule.ruleId,
        ruleVersionId: rule.ruleVersionId,
        code: rule.code,
        version: rule.version,
        specHash: rule.specHash,
        spec: rule.spec,
        bindingId: rule.bindingId,
      },
      // HOLD_STATE and TARGET_QUALIFICATION_AUTHORITY are NOT produced: the gates fail closed.
      supportedFactKinds: PRODUCTION_SUPPORTED_DERIVATION_FACT_KINDS,
      discipline,
      qualification: facts.qualification,
    };
    return sealDerivationSnapshot(snapshot);
  });
}
