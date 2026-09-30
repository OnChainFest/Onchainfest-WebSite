import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-08 read models (class B). Maintained by the deriving / assessing transaction (br_achievements)
 * and fully rebuildable by the maintenance login (br_rebuild) with the SAME function, from
 * achievement.* facts + rule identity + catalog codes only — never PII, evidence, attestations or
 * verification traces. The Athlete Passport rows reference the canonical Achievement (TEAM
 * Achievements reach credited athletes through their immutable memberCredits — no copies).
 */
export async function refreshAchievementCard(ctx: TxContext, achievementId: string): Promise<void> {
  await sql`DELETE FROM achievement_read.athlete_achievement WHERE achievement_id = ${achievementId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM achievement_read.achievement_card WHERE achievement_id = ${achievementId}`.execute(
    ctx.trx,
  );
  const { rows } = await sql<{
    id: string;
    achievement_type: string;
    display_name: string;
    rule_code: string;
    rule_version: number;
    engine_version: string;
    holder_type: 'ATHLETE' | 'TEAM';
    holder_id: string;
    member_athlete_ids: string[];
    scope_type: string;
    scope_id: string;
    competition_id: string;
    event_id: string | null;
    contest_id: string | null;
    discipline_version_id: string;
    sport_code: string | null;
    discipline_code: string | null;
    basis_level: string;
    basis_result_version_ids: string[];
    qualifying_value: unknown;
    governing_recognition_level: string | null;
    governing_recognition_region: string[] | null;
    governing_recognition_sport: string[] | null;
    evidence_commitment: string;
    status: string;
    status_reasons: string[];
    superseded_by: string | null;
    supersedes: string[];
    status_since: Date;
    provenance: string;
    recorded_at: Date;
  }>`
    SELECT a.id, a.achievement_type, v.spec->>'displayName' AS display_name, r.code AS rule_code, v.version AS rule_version,
           a.engine_version, a.holder_type, a.holder_id,
           COALESCE((SELECT array_agg(m.athlete_id ORDER BY m.athlete_id) FROM achievement.member_credit m WHERE m.achievement_id = a.id), '{}') AS member_athlete_ids,
           a.scope_type, a.scope_id, a.competition_id, a.event_id, (a.candidate->'context'->>'contestId')::uuid AS contest_id,
           a.discipline_version_id, sp.code AS sport_code, d.code AS discipline_code, a.basis_level,
           (SELECT array_agg(DISTINCT b.result_version_id) FROM achievement.basis_item b WHERE b.achievement_id = a.id) AS basis_result_version_ids,
           a.qualifying_value, a.governing_recognition_level,
           CASE WHEN a.candidate->'governingAuthority'->'recognitionScope' ? 'region' THEN
             ARRAY(SELECT jsonb_array_elements_text(a.candidate->'governingAuthority'->'recognitionScope'->'region')) END
             AS governing_recognition_region,
           CASE WHEN a.candidate->'governingAuthority'->'recognitionScope' ? 'sport' THEN
             ARRAY(SELECT jsonb_array_elements_text(a.candidate->'governingAuthority'->'recognitionScope'->'sport')) END
             AS governing_recognition_sport,
           a.evidence_commitment, s.status, s.reasons AS status_reasons, s.superseded_by, s.recorded_at AS status_since,
           COALESCE((SELECT array_agg(x.superseded_id ORDER BY x.superseded_id) FROM achievement.supersession x WHERE x.superseding_id = a.id), '{}') AS supersedes,
           a.snapshot_provenance AS provenance, a.recorded_at
    FROM achievement.achievement a
    JOIN achievement.rule r ON r.id = a.rule_id
    JOIN achievement.rule_version v ON v.id = a.rule_version_id
    JOIN LATERAL (SELECT * FROM achievement.status_entry e WHERE e.achievement_id = a.id ORDER BY e.seq DESC LIMIT 1) s ON true
    LEFT JOIN sports.discipline_version dv ON dv.id = a.discipline_version_id
    LEFT JOIN sports.discipline d ON d.id = dv.discipline_id
    LEFT JOIN sports.sport sp ON sp.id = d.sport_id
    WHERE a.id = ${achievementId}`.execute(ctx.trx);
  const a = rows[0];
  if (a === undefined) return;
  await sql`
    INSERT INTO achievement_read.achievement_card
      (achievement_id, achievement_type, display_name, rule_code, rule_version, engine_version, holder_type, holder_id,
       member_athlete_ids, scope_type, scope_id, competition_id, event_id, contest_id, discipline_version_id, sport_code,
       discipline_code, basis_level, basis_result_version_ids, qualifying_value, governing_recognition_level,
       governing_recognition_region, governing_recognition_sport,
       evidence_commitment, status, status_reasons, superseded_by,
       supersedes, status_since, provenance, recorded_at)
    VALUES (${a.id}, ${a.achievement_type}, ${a.display_name}, ${a.rule_code}, ${a.rule_version}, ${a.engine_version},
            ${a.holder_type}, ${a.holder_id}, ${a.member_athlete_ids}, ${a.scope_type}, ${a.scope_id}, ${a.competition_id},
            ${a.event_id}, ${a.contest_id}, ${a.discipline_version_id}, ${a.sport_code}, ${a.discipline_code}, ${a.basis_level},
            ${a.basis_result_version_ids}, ${a.qualifying_value === null ? null : JSON.stringify(a.qualifying_value)},
            ${a.governing_recognition_level}, ${a.governing_recognition_region}, ${a.governing_recognition_sport},
            ${a.evidence_commitment},
            ${a.status}, ${a.status_reasons}, ${a.superseded_by}, ${a.supersedes}, ${a.status_since}, ${a.provenance},
            ${a.recorded_at})`.execute(ctx.trx);
  if (a.holder_type === 'ATHLETE')
    await sql`INSERT INTO achievement_read.athlete_achievement (athlete_id, achievement_id, credit_type)
      VALUES (${a.holder_id}, ${a.id}, 'HOLDER')`.execute(ctx.trx);
  for (const athleteId of a.member_athlete_ids)
    await sql`INSERT INTO achievement_read.athlete_achievement (athlete_id, achievement_id, credit_type)
      VALUES (${athleteId}, ${a.id}, 'TEAM_MEMBER')`.execute(ctx.trx);
}

/** Full rebuild through the maintenance login (br_rebuild). Idempotent. */
export function rebuildAchievementReadModels(maintenanceDb: Db): Promise<{ achievements: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE achievement_read.achievement_card, achievement_read.athlete_achievement`.execute(
      ctx.trx,
    );
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM achievement.achievement ORDER BY recorded_at, id`.execute(ctx.trx);
    for (const r of rows) await refreshAchievementCard(ctx, r.id);
    return { achievements: rows.length };
  });
}

/** Deterministic snapshot of both read models (incremental-vs-rebuild comparisons). */
export function snapshotAchievementReadModels(
  db: Db,
  role: ModuleRole = ModuleRole.achievements,
): Promise<unknown> {
  return inTransaction(db, role, async (ctx) => ({
    cards: (
      await sql`SELECT * FROM achievement_read.achievement_card ORDER BY achievement_id`.execute(
        ctx.trx,
      )
    ).rows,
    athletes: (
      await sql`SELECT * FROM achievement_read.athlete_achievement ORDER BY athlete_id, achievement_id`.execute(
        ctx.trx,
      )
    ).rows,
  }));
}
