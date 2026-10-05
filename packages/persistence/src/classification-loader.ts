import type { DisciplineVersionSpec } from '@br/competition';
import type { ResultScopeType, ResultVersionContent, ResultVersionStatus } from '@br/domain';
import type { ClassificationDerivationInput, ClassificationPolicySpec } from '@br/rankings';
import { sql } from 'kysely';
import type { TxContext } from './tx';

/**
 * BRT-10 canonical classification assembly (ADR-0047 §3–4). Runs INSIDE the ResultLedger's T2
 * transaction under br_results (read-only on everything it loads) and re-assembles, from canonical
 * facts only, the exact `br:classification-derivation-input@1` a classification of one Result must be
 * derived from:
 *
 *   scope        the classification Result's round / event / competition and EVERY contest the explicit
 *                hierarchy (ADR-0025) resolves into it — no contest is filtered by status; a contest
 *                without a current result blocks the derivation (CLASSIFICATION_INPUT_MISSING)
 *   discipline   the ONE DisciplineVersion of the scope's events (a competition whose events differ
 *                fails closed: DISCIPLINE_VERSION_MISMATCH — never a silent filter)
 *   policy       the UNIQUE PUBLISHED, not-RETIRED ClassificationPolicy version for (scope type, that
 *                exact DisciplineVersion). None ⇒ POLICY_UNAVAILABLE; more than one ⇒
 *                CLASSIFICATION_POLICY_AMBIGUOUS. There is no precedence rule, no "latest" and no
 *                submitter choice.
 *   inputs       per contest Result, every version whose latest append-only status is PROVISIONAL /
 *                OFFICIAL / FINAL (the current version), with its exact `@1` content and hash. The
 *                engine re-hashes each and re-checks admissibility.
 *
 * Nothing is defaulted or inferred: anything missing makes the assembly fail closed with a code.
 */
export const CLASSIFICATION_ASSEMBLER_VERSION = 'classification-assembler/1';

const CLASSIFICATION_SCOPES = [
  'ROUND_CLASSIFICATION',
  'EVENT_CLASSIFICATION',
  'COMPETITION_CLASSIFICATION',
] as const;
type ClassificationScope = (typeof CLASSIFICATION_SCOPES)[number];

export const isClassificationScope = (s: string): s is ClassificationScope =>
  (CLASSIFICATION_SCOPES as readonly string[]).includes(s);

export type ClassificationAssembly =
  | { readonly ok: true; readonly input: ClassificationDerivationInput }
  | {
      readonly ok: false;
      readonly reason:
        | 'NOT_A_CLASSIFICATION_RESULT'
        | 'SCOPE_TARGET_UNKNOWN'
        | 'CLASSIFICATION_INPUT_MISSING'
        | 'DISCIPLINE_VERSION_MISMATCH'
        | 'POLICY_UNAVAILABLE'
        | 'CLASSIFICATION_POLICY_AMBIGUOUS';
      readonly details?: Readonly<Record<string, unknown>>;
    };

interface ScopeFacts {
  readonly contestIds: readonly string[];
  /** Distinct DisciplineVersions of the scope's events. */
  readonly disciplineVersionIds: readonly string[];
}

async function scopeFacts(
  ctx: TxContext,
  scopeType: ClassificationScope,
  scopeId: string,
): Promise<ScopeFacts | undefined> {
  const dvs =
    scopeType === 'ROUND_CLASSIFICATION'
      ? sql<{ dv: string }>`SELECT e.discipline_version_id AS dv FROM competition.round r
          JOIN competition.event e ON e.id = r.event_id WHERE r.id = ${scopeId}`
      : scopeType === 'EVENT_CLASSIFICATION'
        ? sql<{ dv: string }>`SELECT e.discipline_version_id AS dv FROM competition.event e
            WHERE e.id = ${scopeId}`
        : sql<{ dv: string }>`SELECT DISTINCT e.discipline_version_id AS dv FROM competition.event e
            WHERE e.competition_id = ${scopeId} ORDER BY 1`;
  const { rows: dvRows } = await dvs.execute(ctx.trx);
  if (dvRows.length === 0) return undefined;
  const contests =
    scopeType === 'ROUND_CLASSIFICATION'
      ? sql<{
          id: string;
        }>`SELECT c.id FROM competition.contest c WHERE c.round_id = ${scopeId} ORDER BY c.id`
      : scopeType === 'EVENT_CLASSIFICATION'
        ? sql<{
            id: string;
          }>`SELECT c.id FROM competition.contest c WHERE c.event_id = ${scopeId} ORDER BY c.id`
        : sql<{
            id: string;
          }>`SELECT c.id FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
            WHERE e.competition_id = ${scopeId} ORDER BY c.id`;
  const { rows } = await contests.execute(ctx.trx);
  return { contestIds: rows.map((r) => r.id), disciplineVersionIds: dvRows.map((r) => r.dv) };
}

/** The unique PUBLISHED (not RETIRED) policy version for (scope type, exact DisciplineVersion). */
export async function applicableClassificationPolicies(
  ctx: TxContext,
  scopeType: ClassificationScope,
  disciplineVersionId: string,
) {
  const { rows } = await sql<{
    policy_id: string;
    policy_version_id: string;
    spec: ClassificationPolicySpec;
    spec_hash: string;
  }>`
    SELECT v.policy_id, v.id AS policy_version_id, v.spec, v.spec_hash
    FROM ranking.classification_policy_version v
    JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
    WHERE v.scope_type = ${scopeType} AND v.discipline_version_id = ${disciplineVersionId}
      AND s.status = 'PUBLISHED'
    ORDER BY v.id`.execute(ctx.trx);
  return rows;
}

/** Re-assembles the canonical derivation input of the classification Result `resultId`. */
export async function assembleClassificationInput(
  ctx: TxContext,
  resultId: string,
): Promise<ClassificationAssembly> {
  const { rows: res } = await sql<{ scope_type: ResultScopeType; scope_target_id: string }>`
    SELECT scope_type, scope_target_id FROM results.result WHERE id = ${resultId}`.execute(ctx.trx);
  const result = res[0];
  if (result === undefined || !isClassificationScope(result.scope_type))
    return { ok: false, reason: 'NOT_A_CLASSIFICATION_RESULT' };
  const scopeType = result.scope_type;
  const scopeId = result.scope_target_id;

  const scope = await scopeFacts(ctx, scopeType, scopeId);
  if (scope === undefined) return { ok: false, reason: 'SCOPE_TARGET_UNKNOWN' };
  // Definition before inputs (the engine's own precedence): one DisciplineVersion, then contests.
  const [disciplineVersionId] = scope.disciplineVersionIds;
  if (disciplineVersionId === undefined || scope.disciplineVersionIds.length !== 1)
    return {
      ok: false,
      reason: 'DISCIPLINE_VERSION_MISMATCH',
      details: { disciplineVersionIds: scope.disciplineVersionIds },
    };
  if (scope.contestIds.length === 0) return { ok: false, reason: 'CLASSIFICATION_INPUT_MISSING' };

  const policies = await applicableClassificationPolicies(ctx, scopeType, disciplineVersionId);
  const [policy] = policies;
  if (policy === undefined) return { ok: false, reason: 'POLICY_UNAVAILABLE' };
  if (policies.length > 1)
    return {
      ok: false,
      reason: 'CLASSIFICATION_POLICY_AMBIGUOUS',
      details: { policyVersionIds: policies.map((p) => p.policy_version_id) },
    };

  return assembleWithPolicy(ctx, scopeType, scopeId, scope.contestIds, disciplineVersionId, policy);
}

type PolicyRow = Awaited<ReturnType<typeof applicableClassificationPolicies>>[number];

/** The DisciplineVersion facts and the current versions of every contest Result in scope. */
async function assembleWithPolicy(
  ctx: TxContext,
  scopeType: ClassificationScope,
  scopeId: string,
  contestIds: readonly string[],
  disciplineVersionId: string,
  policy: PolicyRow,
): Promise<ClassificationAssembly> {
  const { rows: dvRows } = await sql<{ spec: DisciplineVersionSpec; spec_hash: string }>`
    SELECT spec, spec_hash FROM sports.discipline_version WHERE id = ${disciplineVersionId}`.execute(
    ctx.trx,
  );
  const dv = dvRows[0];
  if (dv === undefined) return { ok: false, reason: 'DISCIPLINE_VERSION_MISMATCH' };

  // Current versions of the contest Results, from append-only transitions (never a projection).
  const { rows: versions } = await sql<{
    result_id: string;
    result_version_id: string;
    content: ResultVersionContent;
    content_hash: string;
    contest_id: string;
    status: Exclude<ResultVersionStatus, 'DRAFT'>;
    superseded_by: string | null;
  }>`
    SELECT r.id AS result_id, v.id AS result_version_id, v.content, v.content_hash,
           r.scope_target_id AS contest_id, t.to_status AS status,
           (SELECT s.id FROM results.result_version s WHERE s.supersedes_version_id = v.id
            ORDER BY s.recorded_at, s.id LIMIT 1) AS superseded_by
    FROM results.result r
    JOIN results.result_version v ON v.result_id = r.id
    JOIN LATERAL (SELECT x.to_status FROM results.result_status_transition x
                  WHERE x.result_version_id = v.id ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) t ON true
    WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ANY(${contestIds}::uuid[])
      AND t.to_status IN ('PROVISIONAL', 'OFFICIAL', 'FINAL')
    ORDER BY v.id`.execute(ctx.trx);

  const input: ClassificationDerivationInput = {
    provenance: 'CANONICAL_ASSEMBLY',
    assembler: CLASSIFICATION_ASSEMBLER_VERSION,
    policy: {
      policyId: policy.policy_id,
      policyVersionId: policy.policy_version_id,
      specHash: policy.spec_hash,
      spec: policy.spec,
    },
    discipline: {
      disciplineVersionId,
      specHash: dv.spec_hash,
      metrics: dv.spec.metrics.map((m) => ({ key: m.key, valueType: m.valueType, unit: m.unit })),
      comparator: {
        outcomeModel: dv.spec.comparator.outcomeModel,
        primary: dv.spec.comparator.primary,
        keys: dv.spec.comparator.keys.map((k) => ({ metric: k.metric, order: k.order })),
      },
    },
    scope: { scopeType, scopeId, contestIds: [...contestIds] },
    inputs: versions.map((v) => ({
      resultId: v.result_id,
      resultVersionId: v.result_version_id,
      contentHash: v.content_hash,
      scopeType: 'CONTEST',
      contestId: v.contest_id,
      status: v.status,
      ...(v.superseded_by === null ? {} : { supersededByVersionId: v.superseded_by }),
      content: v.content,
    })),
  };
  return { ok: true, input };
}

/**
 * BRT-10 Step 7 (ADR-0047 §5): re-assembles the CURRENT scope of an existing classification under its
 * own PINNED policy version and DisciplineVersion — the basis of its admissible input set at read time.
 * The current policy binding is deliberately not consulted: rebinding a policy is not a stale
 * condition. Read-only; a scope that cannot be re-assembled fails closed with a code (the caller
 * treats it as ADMISSIBLE_INPUT_SET_UNKNOWN).
 */
export async function assemblePinnedClassificationInput(
  ctx: TxContext,
  resultId: string,
  pinned: { readonly policyVersionId: string; readonly disciplineVersionId: string },
): Promise<ClassificationAssembly> {
  const { rows: res } = await sql<{ scope_type: ResultScopeType; scope_target_id: string }>`
    SELECT scope_type, scope_target_id FROM results.result WHERE id = ${resultId}`.execute(ctx.trx);
  const result = res[0];
  if (result === undefined || !isClassificationScope(result.scope_type))
    return { ok: false, reason: 'NOT_A_CLASSIFICATION_RESULT' };
  const scope = await scopeFacts(ctx, result.scope_type, result.scope_target_id);
  if (scope === undefined) return { ok: false, reason: 'SCOPE_TARGET_UNKNOWN' };
  if (
    scope.disciplineVersionIds.length !== 1 ||
    scope.disciplineVersionIds[0] !== pinned.disciplineVersionId
  )
    return {
      ok: false,
      reason: 'DISCIPLINE_VERSION_MISMATCH',
      details: { disciplineVersionIds: scope.disciplineVersionIds },
    };
  if (scope.contestIds.length === 0) return { ok: false, reason: 'CLASSIFICATION_INPUT_MISSING' };
  const { rows } = await sql<PolicyRow>`
    SELECT v.policy_id, v.id AS policy_version_id, v.spec, v.spec_hash
    FROM ranking.classification_policy_version v
    WHERE v.id = ${pinned.policyVersionId} AND v.scope_type = ${result.scope_type}
      AND v.discipline_version_id = ${pinned.disciplineVersionId}`.execute(ctx.trx);
  const policy = rows[0];
  if (policy === undefined) return { ok: false, reason: 'POLICY_UNAVAILABLE' };
  return assembleWithPolicy(
    ctx,
    result.scope_type,
    result.scope_target_id,
    scope.contestIds,
    pinned.disciplineVersionId,
    policy,
  );
}
