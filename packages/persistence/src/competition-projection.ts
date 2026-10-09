import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * Competition read models (competition_read, class B). Each refresh is a pure function of the
 * canonical `competition` / `sports` facts (timestamps come from facts, never from the clock),
 * so incremental maintenance and a full rebuild produce identical rows. No identity_private
 * access; athlete names are resolved by the public reader from the Passport card at read time.
 */

export async function refreshCompetitionCard(ctx: TxContext, competitionId: string): Promise<void> {
  await sql`DELETE FROM competition_read.competition_slug WHERE competition_id = ${competitionId}`.execute(
    ctx.trx,
  );
  await sql`DELETE FROM competition_read.competition_card WHERE competition_id = ${competitionId}`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO competition_read.competition_card
      (competition_id, slug, name, description, status, timezone, starts_at, ends_at, location_label, organizer_organization_id)
    SELECT c.id, sl.slug, p.name, p.description, st.status, p.timezone, p.starts_at, p.ends_at, p.location_label, c.organizer_organization_id
    FROM competition.competition c
    JOIN competition.competition_profile p ON p.competition_id = c.id
    JOIN competition.v_competition_current st ON st.competition_id = c.id
    JOIN competition.v_competition_slug_current sl ON sl.competition_id = c.id
    WHERE c.id = ${competitionId}`.execute(ctx.trx);
  await sql`INSERT INTO competition_read.competition_slug (slug, competition_id)
    SELECT slug, competition_id FROM competition.competition_slug WHERE competition_id = ${competitionId}`.execute(
    ctx.trx,
  );
}

export async function refreshEventReadModels(ctx: TxContext, eventId: string): Promise<void> {
  for (const t of ['event_summary', 'event_slug', 'event_entry', 'round_card', 'contest_card']) {
    await sql`DELETE FROM ${sql.raw(`competition_read.${t}`)} WHERE event_id = ${eventId}`.execute(
      ctx.trx,
    );
  }
  await sql`
    INSERT INTO competition_read.event_summary
      (event_id, competition_id, slug, name, status, entrant_kind, sport_code, sport_name, discipline_code, discipline_name,
       discipline_version, format_code, format_name, format_version, engine, category, capacity, confirmed_count, waitlist_count,
       participant_count, registration_opens_at, registration_closes_at, starts_at, ends_at, timezone, field_hash, seeding_method,
       draw_algorithm, draw_seed, seeding_hash, plan_engine, plan_input_hash, plan_hash, plan_generated_at)
    SELECT e.id, e.competition_id, sl.slug, p.name, st.status, e.entrant_kind, s.code, s.name, d.code, d.name, dv.version,
           ft.code, ft.name, fv.version, fv.engine_id || '/' || fv.engine_version, p.category, p.capacity,
           (SELECT count(*) FROM competition.v_registration_current r WHERE r.event_id = e.id AND r.status = 'CONFIRMED')::int,
           (SELECT count(*) FROM competition.v_registration_current r WHERE r.event_id = e.id AND r.status = 'WAITLISTED')::int,
           (SELECT count(*) FROM competition.participant pa WHERE pa.event_id = e.id)::int,
           p.registration_opens_at, p.registration_closes_at, p.starts_at, p.ends_at, p.timezone,
           f.field_hash, sd.method, sd.draw_algorithm, sd.draw_seed, sd.seeding_hash,
           CASE WHEN pl.event_id IS NULL THEN NULL ELSE pl.engine_id || '/' || pl.engine_version END, pl.input_hash, pl.plan_hash, pl.recorded_at
    FROM competition.event e
    JOIN competition.event_profile p ON p.event_id = e.id
    JOIN competition.v_event_current st ON st.event_id = e.id
    JOIN competition.v_event_slug_current sl ON sl.event_id = e.id
    JOIN sports.discipline_version dv ON dv.id = e.discipline_version_id
    JOIN sports.discipline d ON d.id = dv.discipline_id
    JOIN sports.sport s ON s.id = d.sport_id
    JOIN sports.format_version fv ON fv.id = e.format_version_id
    JOIN sports.format_template ft ON ft.id = fv.template_id
    LEFT JOIN competition.event_field f ON f.event_id = e.id
    LEFT JOIN competition.event_seeding sd ON sd.event_id = e.id
    LEFT JOIN competition.event_plan pl ON pl.event_id = e.id
    WHERE e.id = ${eventId}`.execute(ctx.trx);
  await sql`INSERT INTO competition_read.event_slug (competition_id, slug, event_id)
    SELECT competition_id, slug, event_id FROM competition.event_slug WHERE event_id = ${eventId}`.execute(
    ctx.trx,
  );
  // Public entries: CONFIRMED registrations, plus every materialized Participant (whatever its
  // later status). Waitlisted/pending entries are counted, never listed.
  await sql`
    INSERT INTO competition_read.event_entry
      (registration_id, event_id, entrant_type, athlete_id, team_id, team_name, registration_status, confirmed_at,
       participant_id, participant_status, seed)
    SELECT r.id, r.event_id, r.entrant_type, r.athlete_id, r.team_id, tp.display_name, v.status,
           (SELECT max(c.recorded_at) FROM competition.registration_status_change c WHERE c.registration_id = r.id AND c.status = 'CONFIRMED'),
           pa.id, pv.status,
           (SELECT array_position(sd.seed_order, pa.id) FROM competition.event_seeding sd WHERE sd.event_id = r.event_id)
    FROM competition.registration r
    JOIN competition.v_registration_current v ON v.registration_id = r.id
    LEFT JOIN competition.team_profile tp ON tp.team_id = r.team_id
    LEFT JOIN competition.participant pa ON pa.registration_id = r.id
    LEFT JOIN competition.v_participant_current pv ON pv.participant_id = pa.id
    WHERE r.event_id = ${eventId} AND (v.status = 'CONFIRMED' OR pa.id IS NOT NULL)`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO competition_read.round_card (round_id, event_id, sequence, round_type, label, byes)
    SELECT id, event_id, sequence, round_type, label, byes FROM competition.round WHERE event_id = ${eventId}`.execute(
    ctx.trx,
  );
  await sql`
    INSERT INTO competition_read.contest_card
      (contest_id, event_id, round_id, sequence, contest_type, status, scheduled_start, scheduled_end, venue_organization_id,
       location_label, court_label, slots)
    SELECT c.id, c.event_id, c.round_id, c.sequence, c.contest_type, st.status, sc.scheduled_start, sc.scheduled_end,
           sc.venue_organization_id, sc.location_label, sc.court_label,
           coalesce((
             SELECT jsonb_agg(
                      CASE WHEN ct.source_kind = 'PARTICIPANT'
                        THEN jsonb_build_object('slot', ct.slot, 'kind', 'PARTICIPANT', 'participantId', ct.participant_id)
                        ELSE jsonb_build_object('slot', ct.slot, 'kind', ct.source_kind, 'contestId', ct.source_contest_id,
                                                'contestSequence', (SELECT src.sequence FROM competition.contest src WHERE src.id = ct.source_contest_id))
                      END ORDER BY ct.slot)
             FROM competition.contestant ct WHERE ct.contest_id = c.id), '[]'::jsonb)
    FROM competition.contest c
    JOIN competition.v_contest_current st ON st.contest_id = c.id
    LEFT JOIN competition.contest_schedule sc ON sc.contest_id = c.id
    WHERE c.event_id = ${eventId}`.execute(ctx.trx);
}

/** Refreshes every event of a competition (after a competition-level status cascade). */
export async function refreshCompetitionEvents(
  ctx: TxContext,
  competitionId: string,
): Promise<void> {
  const { rows } = await sql<{
    id: string;
  }>`SELECT id FROM competition.event WHERE competition_id = ${competitionId} ORDER BY id`.execute(
    ctx.trx,
  );
  for (const r of rows) await refreshEventReadModels(ctx, r.id);
}

const READ_TABLES = [
  'competition_card',
  'competition_slug',
  'event_summary',
  'event_slug',
  'event_entry',
  'round_card',
  'contest_card',
];

/** Full rebuild from canonical facts. Maintenance login only (br_rebuild); no PII access needed. */
export function rebuildCompetitionReadModels(
  maintenanceDb: Db,
): Promise<{ competitions: number; events: number }> {
  return inTransaction(maintenanceDb, ModuleRole.rebuild, async (ctx) => {
    await sql`TRUNCATE ${sql.raw(READ_TABLES.map((t) => `competition_read.${t}`).join(', '))}`.execute(
      ctx.trx,
    );
    const { rows: comps } = await sql<{
      id: string;
    }>`SELECT id FROM competition.competition ORDER BY id`.execute(ctx.trx);
    for (const c of comps) await refreshCompetitionCard(ctx, c.id);
    const { rows: events } = await sql<{
      id: string;
    }>`SELECT id FROM competition.event ORDER BY id`.execute(ctx.trx);
    for (const e of events) await refreshEventReadModels(ctx, e.id);
    return { competitions: comps.length, events: events.length };
  });
}

/** Deterministic snapshot of every read-model row (rebuild equivalence checks). */
export function snapshotCompetitionReadModels(db: Db, role: ModuleRole = ModuleRole.publicRead) {
  const order: Record<string, string> = {
    competition_card: 'competition_id',
    competition_slug: 'slug',
    event_summary: 'event_id',
    event_slug: 'competition_id, slug',
    event_entry: 'registration_id',
    round_card: 'round_id',
    contest_card: 'contest_id',
  };
  return inTransaction(db, role, async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const t of READ_TABLES) {
      out[t] = (
        await sql`SELECT * FROM ${sql.raw(`competition_read.${t}`)} ORDER BY ${sql.raw(order[t] as string)}`.execute(
          ctx.trx,
        )
      ).rows;
    }
    return out;
  });
}
