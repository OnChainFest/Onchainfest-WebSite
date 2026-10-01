import { recordLabel, type RecordCategorySpec } from '@br/records';
import type { Mark, RecordMarkStatus, RecordScopeType } from '@br/domain';
import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-09 read models (class B, ADR-0046). Maintained by the record transaction (br_records) and fully
 * rebuildable by the maintenance login (br_rebuild) with the SAME functions, from record.* facts +
 * category identity + catalog codes only — never PII, evidence, attestations, authority topology or
 * verification traces. The Record Hall of Fame holds ONLY legitimate record history (RATIFIED /
 * CANONICAL current, SUPERSEDED former) of marks that actually held the record; PENDING and RESCINDED
 * marks stay in mark_card (explicitly labelled) and in the canonical history.
 */
export async function refreshMarkCard(ctx: TxContext, recordMarkId: string): Promise<void> {
  await sql`DELETE FROM record_read.athlete_record WHERE record_mark_id = ${recordMarkId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM record_read.hall_of_fame_entry WHERE record_mark_id = ${recordMarkId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM record_read.mark_card WHERE record_mark_id = ${recordMarkId}`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{
    id: string;
    category_id: string;
    category_code: string;
    category_version_id: string;
    category_version: number;
    scope_type: RecordScopeType;
    spec: RecordCategorySpec;
    holder_type: 'ATHLETE' | 'TEAM';
    holder_id: string;
    member_athlete_ids: string[];
    value: Mark;
    mark_metric_id: string;
    comparator: string;
    tie_policy: string;
    effective_from: Date;
    status: RecordMarkStatus;
    reasons: string[];
    effective_to: Date | null;
    superseded_by: string | null;
    status_since: Date;
    last_effective_to: Date | null;
    standing: string | null;
    ratified_at: Date | null;
    ratification_level: string | null;
    sport_code: string | null;
    discipline_code: string | null;
    basis_level: string;
    competition_id: string;
    event_id: string | null;
    result_version_id: string;
    provenance: string;
    recorded_at: Date;
  }>`
    SELECT m.id, m.category_id, c.code AS category_code, m.category_version_id, v.version AS category_version,
           m.scope_type, v.spec, m.holder_type, m.holder_id,
           COALESCE((SELECT array_agg(x.athlete_id ORDER BY x.athlete_id) FROM record.mark_member_credit x WHERE x.record_mark_id = m.id), '{}') AS member_athlete_ids,
           m.value, m.mark_metric_id, m.comparator, m.tie_policy, m.effective_from,
           l.status, l.reasons, l.effective_to, l.superseded_by_mark_id AS superseded_by, l.recorded_at AS status_since,
           (SELECT s.effective_to FROM record.mark_status_entry s WHERE s.record_mark_id = m.id AND s.status = 'SUPERSEDED'
            ORDER BY s.seq DESC LIMIT 1) AS last_effective_to,
           r.status AS standing, r.recorded_at AS ratified_at, r.ratification_run_level AS ratification_level,
           sp.code AS sport_code, d.code AS discipline_code, m.basis_level, m.competition_id, m.event_id,
           m.result_version_id, m.provenance, m.recorded_at
    FROM record.record_mark m
    JOIN record.category c ON c.id = m.category_id
    JOIN record.category_version v ON v.id = m.category_version_id
    JOIN LATERAL (SELECT * FROM record.mark_status_entry s WHERE s.record_mark_id = m.id ORDER BY s.seq DESC LIMIT 1) l ON true
    LEFT JOIN record.mark_status_entry r ON r.record_mark_id = m.id AND r.ratification_ref IS NOT NULL
    LEFT JOIN sports.discipline_version dv ON dv.id = m.discipline_version_id
    LEFT JOIN sports.discipline d ON d.id = dv.discipline_id
    LEFT JOIN sports.sport sp ON sp.id = d.sport_id
    WHERE m.id = ${recordMarkId}`.execute(ctx.trx);
  const m = rows[0];
  if (m === undefined) return;
  const isCurrent = m.status === 'RATIFIED' || m.status === 'CANONICAL';
  const everHeld = m.standing !== null && !m.reasons.includes('NEVER_HELD');
  const effectiveTo =
    m.status === 'SUPERSEDED'
      ? m.effective_to
      : m.status === 'RESCINDED'
        ? m.last_effective_to
        : null;
  const region = m.spec.scope.region ?? null;
  const label = recordLabel({
    scopeType: m.scope_type,
    displayName: m.spec.displayName,
    ...(region === null ? {} : { region }),
    status: m.status,
  });
  await sql`
    INSERT INTO record_read.mark_card
      (record_mark_id, category_id, category_code, category_version_id, category_version, scope_type, display_name,
       record_label, holder_type, holder_id, member_athlete_ids, value, mark_metric_id, comparator, tie_policy,
       effective_from, effective_to, status, standing, status_reasons, status_since, is_current, ever_held, ratified_at,
       superseded_by_mark_id, region, recognition_level, sport_code, discipline_code, basis_level, ratification_level,
       competition_id, event_id, result_version_id, provenance, recorded_at)
    VALUES (${m.id}, ${m.category_id}, ${m.category_code}, ${m.category_version_id}, ${m.category_version}, ${m.scope_type},
            ${m.spec.displayName}, ${label}, ${m.holder_type}, ${m.holder_id}, ${m.member_athlete_ids},
            ${JSON.stringify(m.value)}, ${m.mark_metric_id}, ${m.comparator}, ${m.tie_policy}, ${m.effective_from},
            ${effectiveTo}, ${m.status}, ${m.standing}, ${m.reasons}, ${m.status_since}, ${isCurrent}, ${everHeld},
            ${m.ratified_at}, ${m.superseded_by}, ${region === null ? null : [...region]}, ${m.spec.recognition.level},
            ${m.sport_code}, ${m.discipline_code}, ${m.basis_level}, ${m.ratification_level}, ${m.competition_id},
            ${m.event_id}, ${m.result_version_id}, ${m.provenance}, ${m.recorded_at})`.execute(
    ctx.trx,
  );
  // Record Hall of Fame: legitimate honours only (never PENDING, never RESCINDED, never PERSONAL,
  // never a mark that did not actually hold the record).
  if ((isCurrent || m.status === 'SUPERSEDED') && everHeld && m.scope_type !== 'PERSONAL') {
    const sortKey = `${m.category_code}|${m.effective_from.toISOString()}|${m.id}`;
    await sql`
      INSERT INTO record_read.hall_of_fame_entry
        (record_mark_id, category_id, category_code, scope_type, record_label, holder_type, holder_id,
         member_athlete_ids, value, effective_from, effective_to, holding, status, sport_code, discipline_code,
         region, recognition_level, provenance, sort_key)
      VALUES (${m.id}, ${m.category_id}, ${m.category_code}, ${m.scope_type}, ${label}, ${m.holder_type}, ${m.holder_id},
              ${m.member_athlete_ids}, ${JSON.stringify(m.value)}, ${m.effective_from},
              ${isCurrent ? null : effectiveTo}, ${isCurrent ? 'CURRENT' : 'FORMER'}, ${m.status}, ${m.sport_code},
              ${m.discipline_code}, ${region === null ? null : [...region]}, ${m.spec.recognition.level},
              ${m.provenance}, ${sortKey})`.execute(ctx.trx);
  }
  if (m.holder_type === 'ATHLETE')
    await sql`INSERT INTO record_read.athlete_record (athlete_id, record_mark_id, credit_type)
      VALUES (${m.holder_id}, ${m.id}, 'HOLDER')`.execute(ctx.trx);
  for (const athleteId of m.member_athlete_ids)
    await sql`INSERT INTO record_read.athlete_record (athlete_id, record_mark_id, credit_type)
      VALUES (${athleteId}, ${m.id}, 'TEAM_MEMBER')`.execute(ctx.trx);
}

/** The category card: latest version's public-safe policy + the current record (RC-1). */
export async function refreshCategoryCard(ctx: TxContext, categoryId: string): Promise<void> {
  await sql`DELETE FROM record_read.category_card WHERE category_id = ${categoryId}`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{
    id: string;
    code: string;
    name: string;
    scope_type: string;
    category_version_id: string;
    version: number;
    lifecycle: string;
    spec: RecordCategorySpec;
    sport_code: string | null;
    discipline_code: string | null;
    comparator: string | null;
    last_fact_at: Date;
  }>`
    SELECT c.id, c.code, c.name, c.scope_type, v.id AS category_version_id, v.version, s.status AS lifecycle, v.spec,
           sp.code AS sport_code, d.code AS discipline_code,
           (SELECT k->>'order' FROM jsonb_array_elements(dv.spec->'comparator'->'keys') k
            WHERE k->>'metric' = v.metric_key LIMIT 1) AS comparator,
           GREATEST(c.recorded_at, v.recorded_at,
                    COALESCE((SELECT max(x.recorded_at) FROM record.category_version_status_change x
                              JOIN record.category_version xv ON xv.id = x.category_version_id WHERE xv.category_id = c.id), c.recorded_at),
                    COALESCE((SELECT max(e.recorded_at) FROM record.mark_status_entry e
                              JOIN record.record_mark em ON em.id = e.record_mark_id WHERE em.category_id = c.id), c.recorded_at)) AS last_fact_at
    FROM record.category c
    JOIN LATERAL (SELECT * FROM record.category_version cv WHERE cv.category_id = c.id ORDER BY cv.version DESC LIMIT 1) v ON true
    JOIN record.v_category_version_current s ON s.category_version_id = v.id
    LEFT JOIN sports.discipline_version dv ON dv.id = v.discipline_version_id
    LEFT JOIN sports.discipline d ON d.id = dv.discipline_id
    LEFT JOIN sports.sport sp ON sp.id = d.sport_id
    WHERE c.id = ${categoryId}`.execute(ctx.trx);
  const c = rows[0];
  if (c === undefined) return;
  const { rows: current } = await sql<{ id: string; value: Mark; provenance: string }>`
    SELECT m.id, m.value, m.provenance FROM record.record_mark m
    JOIN record.v_mark_status st ON st.record_mark_id = m.id
    WHERE m.category_id = ${categoryId} AND st.status IN ('RATIFIED', 'CANONICAL')
    ORDER BY m.id`.execute(ctx.trx);
  const { rows: prov } = await sql<{ provenance: string }>`
    SELECT DISTINCT provenance FROM record.record_mark WHERE category_id = ${categoryId} ORDER BY provenance`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO record_read.category_card
      (category_id, code, name, scope_type, category_version_id, version, lifecycle, display_name, sport_code,
       discipline_code, metric_key, mark_metric_id, comparator, tie_policy, region, recognition_level,
       minimum_verification_level, platform_review, canonical_keeper, population, conditions, effective_from,
       current_value, current_mark_ids, provenance_mix, last_fact_at)
    VALUES (${c.id}, ${c.code}, ${c.name}, ${c.scope_type}, ${c.category_version_id}, ${c.version}, ${c.lifecycle},
            ${c.spec.displayName}, ${c.sport_code}, ${c.discipline_code}, ${c.spec.universe.metric.key},
            ${c.spec.universe.metric.markMetricId}, ${c.comparator}, ${c.spec.tiePolicy},
            ${c.spec.scope.region === undefined ? null : [...c.spec.scope.region]}, ${c.spec.recognition.level},
            ${c.spec.requirements.minimumVerificationLevel}, ${c.spec.platformReview === true},
            ${c.spec.canonicalKeeper !== undefined}, ${JSON.stringify(c.spec.population)},
            ${JSON.stringify(c.spec.conditions)}, ${c.spec.effectiveFrom},
            ${current[0] === undefined ? null : JSON.stringify(current[0].value)}, ${current.map((r) => r.id)},
            ${prov.map((r) => r.provenance)}, ${c.last_fact_at})`.execute(ctx.trx);
}

/** Full rebuild through the maintenance login (br_rebuild). Idempotent. */
export function rebuildRecordReadModels(
  maintenanceDb: Db,
): Promise<{ categories: number; marks: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE record_read.category_card, record_read.mark_card, record_read.hall_of_fame_entry,
      record_read.athlete_record`.execute(ctx.trx);
    const { rows: marks } = await sql<{ id: string }>`
      SELECT id FROM record.record_mark ORDER BY recorded_at, id`.execute(ctx.trx);
    for (const r of marks) await refreshMarkCard(ctx, r.id);
    const { rows: cats } = await sql<{ id: string }>`
      SELECT id FROM record.category ORDER BY recorded_at, id`.execute(ctx.trx);
    for (const r of cats) await refreshCategoryCard(ctx, r.id);
    return { categories: cats.length, marks: marks.length };
  });
}

/** Deterministic snapshot of every record read model (incremental-vs-rebuild comparisons). */
export function snapshotRecordReadModels(
  db: Db,
  role: ModuleRole = ModuleRole.records,
): Promise<unknown> {
  return inTransaction(db, role, async (ctx) => ({
    categories: (
      await sql`SELECT * FROM record_read.category_card ORDER BY category_id`.execute(ctx.trx)
    ).rows,
    marks: (await sql`SELECT * FROM record_read.mark_card ORDER BY record_mark_id`.execute(ctx.trx))
      .rows,
    hallOfFame: (
      await sql`SELECT * FROM record_read.hall_of_fame_entry ORDER BY sort_key`.execute(ctx.trx)
    ).rows,
    athletes: (
      await sql`SELECT * FROM record_read.athlete_record ORDER BY athlete_id, record_mark_id`.execute(
        ctx.trx,
      )
    ).rows,
  }));
}
