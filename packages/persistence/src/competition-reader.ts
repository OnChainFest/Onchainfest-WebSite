import {
  providedCapabilities,
  engineRequirements,
  capabilityIssues,
  formatEngine,
  schedulingProfileCompatibility,
  type SchedulingProfileSpec,
  PUBLIC_COMPETITION_SCHEMA,
  PUBLIC_EVENT_SCHEMA,
  type DisciplineVersionSpec,
  type NotAvailable,
  type PublicCompetitionV1,
  type PublicContest,
  type PublicEntrantDisplay,
  type PublicEntry,
  type PublicEventSummary,
  type PublicEventV1,
  type PublicSlot,
  type PublicStructureRound,
} from '@br/competition';
import { slugLookupKey } from '@br/identity';
import { sql } from 'kysely';
import type { Db } from './db';
import { inTransaction, ModuleRole, type TxContext } from './tx';

type SchedulingProfileRow = {
  id: string;
  code: string;
  name: string;
  version: number;
  spec_version: number;
  spec_hash: string;
  spec: SchedulingProfileSpec;
  basis: Record<string, unknown>;
};

/** PUBLISHED profile versions only: a DRAFT or RETIRED row is never offered or served. */
async function publishedSchedulingProfiles(
  ctx: TxContext,
  versionId?: string,
): Promise<SchedulingProfileRow[]> {
  const { rows } = await sql<SchedulingProfileRow>`
    SELECT v.id, p.code, p.name, v.version, v.spec_version, v.spec_hash, v.spec, v.basis
    FROM sports.scheduling_profile_version v JOIN sports.scheduling_profile p ON p.id = v.profile_id
    JOIN sports.v_scheduling_profile_version_current c ON c.scheduling_profile_version_id = v.id
    WHERE c.status = 'PUBLISHED' AND (${versionId ?? null}::uuid IS NULL OR v.id = ${versionId ?? null}::uuid)
    ORDER BY p.code, v.version`.execute(ctx.trx);
  return rows;
}

const schedulingProfileView = (r: SchedulingProfileRow) => ({
  versionId: r.id,
  code: r.code,
  name: r.name,
  version: r.version,
  specVersion: r.spec_version,
  specHash: r.spec_hash,
  spec: r.spec,
  basis: r.basis,
});

const NOT_AVAILABLE: NotAvailable = { status: 'NOT_AVAILABLE', reason: 'SOURCE_NOT_IMPLEMENTED' };
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

type EventSummaryRow = {
  event_id: string;
  competition_id: string;
  slug: string;
  name: string;
  status: PublicEventSummary['status'];
  entrant_kind: PublicEventSummary['entrantKind'];
  sport_code: string;
  sport_name: string;
  discipline_code: string;
  discipline_name: string;
  discipline_version: number;
  format_code: string;
  format_name: string;
  format_version: number;
  engine: string;
  category: PublicEventSummary['category'];
  capacity: number | null;
  confirmed_count: number;
  waitlist_count: number;
  participant_count: number;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
  field_hash: string | null;
  seeding_method: 'MANUAL' | 'DETERMINISTIC_DRAW' | null;
  draw_algorithm: string | null;
  draw_seed: string | null;
  seeding_hash: string | null;
  plan_engine: string | null;
  plan_input_hash: string | null;
  plan_hash: string | null;
  plan_generated_at: Date | null;
};

function summary(r: EventSummaryRow): PublicEventSummary {
  return {
    id: r.event_id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    entrantKind: r.entrant_kind,
    sport: { code: r.sport_code, name: r.sport_name },
    discipline: { code: r.discipline_code, name: r.discipline_name, version: r.discipline_version },
    format: {
      code: r.format_code,
      name: r.format_name,
      version: r.format_version,
      engine: r.engine,
    },
    category: r.category,
    capacity: r.capacity,
    confirmedCount: r.confirmed_count,
    waitlistCount: r.waitlist_count,
    participantCount: r.participant_count,
    registration: {
      opensAt: iso(r.registration_opens_at),
      closesAt: iso(r.registration_closes_at),
    },
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    timezone: r.timezone,
  };
}

/**
 * Public competition read path (br_public_read): projections + public Passport cards +
 * public organization profiles only. DRAFT competitions and events are never served (404);
 * CANCELLED ones are served and marked. Private, restricted (e.g. minor) or inactive athletes are
 * shown as PRIVATE_ENTRANT — no name, slug or reason.
 */
export class CompetitionReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.publicRead, fn);
  }

  /**
   * Published catalog (what organizers can pin). ONCF-03A: each discipline version carries the
   * participation and contest-type facts of its spec, and each format version its contest type and
   * configuration schema, so a client can offer only valid combinations. `compatibleFormatVersionIds`
   * applies exactly the createEvent rule — since ONCF-05B the generic capability rule (ADR-0053):
   * every capability the format requires is provided by the discipline. A format whose engine is
   * not registered in this build has `contestType: null` / `requires: null` and fits nothing.
   */
  catalog() {
    return this.tx(async (ctx) => {
      const { rows: disciplines } = await sql<{
        id: string;
        sport_code: string;
        sport_name: string;
        code: string;
        name: string;
        version: number;
        spec_hash: string;
        spec: DisciplineVersionSpec;
      }>`
        SELECT dv.id, s.code AS sport_code, s.name AS sport_name, d.code, d.name, dv.version, dv.spec_hash, dv.spec
        FROM sports.discipline_version dv JOIN sports.v_discipline_version_current c ON c.discipline_version_id = dv.id
        JOIN sports.discipline d ON d.id = dv.discipline_id JOIN sports.sport s ON s.id = d.sport_id
        WHERE c.status = 'PUBLISHED' ORDER BY d.code, dv.version`.execute(ctx.trx);
      const { rows: formats } = await sql<{
        id: string;
        code: string;
        name: string;
        version: number;
        engine_id: string;
        engine_version: number;
        configuration_schema: Record<string, unknown>;
      }>`
        SELECT fv.id, t.code, t.name, fv.version, fv.engine_id, fv.engine_version, fv.configuration_schema
        FROM sports.format_version fv JOIN sports.v_format_version_current c ON c.format_version_id = fv.id
        JOIN sports.format_template t ON t.id = fv.template_id
        WHERE c.status = 'PUBLISHED' ORDER BY t.code, fv.version`.execute(ctx.trx);
      const formatVersions = formats.map((f) => {
        const engine = formatEngine(f.engine_id, f.engine_version);
        return {
          formatVersionId: f.id,
          format: { code: f.code, name: f.name },
          version: f.version,
          engine: `${f.engine_id}/${f.engine_version}`,
          contestType: engine?.contestType ?? null,
          configurationSchema: f.configuration_schema,
          /** ONCF-05B: the capabilities this format requires (null: engine not in this build). */
          requires: engine === undefined ? null : engineRequirements(engine),
        };
      });
      // ONCF-05C: the scoring catalog (published versions only), with each version's basis.
      const { rows: rulesets } = await sql<{
        id: string;
        code: string;
        name: string;
        version: number;
        family: string;
        spec_hash: string;
        spec: Record<string, unknown>;
        basis: Record<string, unknown>;
      }>`
        SELECT v.id, r.code, r.name, v.version, v.family, v.spec_hash, v.spec, v.basis
        FROM sports.ruleset_version v JOIN sports.ruleset r ON r.id = v.ruleset_id
        JOIN sports.v_ruleset_version_current c ON c.ruleset_version_id = v.id
        WHERE c.status = 'PUBLISHED' ORDER BY r.code, v.version`.execute(ctx.trx);
      const { rows: templates } = await sql<{
        id: string;
        code: string;
        name: string;
        version: number;
        family: string;
        spec_hash: string;
        spec: Record<string, unknown>;
        basis: Record<string, unknown>;
      }>`
        SELECT v.id, t.code, t.name, v.version, v.family, v.spec_hash, v.spec, v.basis
        FROM sports.classification_template_version v JOIN sports.classification_template t ON t.id = v.template_id
        JOIN sports.v_classification_template_version_current c ON c.classification_template_version_id = v.id
        WHERE c.status = 'PUBLISHED' ORDER BY t.code, v.version`.execute(ctx.trx);
      const { rows: policies } = await sql<(typeof templates)[number]>`
        SELECT v.id, p.code, p.name, v.version, v.family, v.spec_hash, v.spec, v.basis
        FROM sports.advancement_policy_version v JOIN sports.advancement_policy p ON p.id = v.policy_id
        JOIN sports.v_advancement_policy_version_current c ON c.advancement_policy_version_id = v.id
        WHERE c.status = 'PUBLISHED' ORDER BY p.code, v.version`.execute(ctx.trx);
      // ONCF-05E-B: published SchedulingProfile versions (catalog templates; ADR-0072 §2).
      const profiles = await publishedSchedulingProfiles(ctx);
      const scoringVersion = (r: (typeof rulesets)[number]) => ({
        versionId: r.id,
        code: r.code,
        name: r.name,
        version: r.version,
        family: r.family,
        specHash: r.spec_hash,
        spec: r.spec,
        basis: r.basis,
      });
      return {
        rulesetVersions: rulesets.map(scoringVersion),
        classificationTemplateVersions: templates.map(scoringVersion),
        advancementPolicyVersions: policies.map(scoringVersion),
        schedulingProfileVersions: profiles.map(schedulingProfileView),
        disciplineVersions: disciplines.map((d) => ({
          disciplineVersionId: d.id,
          sport: { code: d.sport_code, name: d.sport_name },
          discipline: { code: d.code, name: d.name },
          version: d.version,
          specHash: d.spec_hash,
          participantKinds: [...d.spec.participation.participantKinds],
          lineupSize: { ...d.spec.participation.lineupSize },
          allowedContestTypes: [...d.spec.allowedContestTypes],
          // ONCF-05B: capabilities, roster and declared entry attributes (v1 specs derive theirs).
          capabilities: providedCapabilities(d.spec),
          roster: d.spec.participation.roster ?? null,
          entryAttributes: [...(d.spec.entryAttributes ?? [])],
          // ONCF-05C: rulesets whose family the discipline provides (v1 disciplines provide none).
          compatibleRulesetVersionIds: rulesets
            .filter((r) => providedCapabilities(d.spec).rulesetFamilies.includes(r.family as never))
            .map((r) => r.id),
          // ONCF-05E-B: profiles whose every resource type the discipline declares (v1: none). The
          // format's contest types are always covered by a valid profile's default requirement.
          compatibleSchedulingProfileVersionIds: profiles
            .filter(
              (p) =>
                schedulingProfileCompatibility(p.spec, providedCapabilities(d.spec), []).length ===
                0,
            )
            .map((p) => p.id),
          compatibleFormatVersionIds: formatVersions
            .filter(
              (f) =>
                f.requires !== null &&
                capabilityIssues(providedCapabilities(d.spec), f.requires).length === 0,
            )
            .map((f) => f.formatVersionId),
        })),
        formatVersions,
      };
    });
  }

  /** ONCF-05E-B: one PUBLISHED SchedulingProfile version (undefined when unknown or not published). */
  schedulingProfileVersion(versionId: string) {
    return this.tx(async (ctx) => {
      const rows = await publishedSchedulingProfiles(ctx, versionId);
      return rows[0] === undefined ? undefined : schedulingProfileView(rows[0]);
    });
  }

  /**
   * ONCF-02: an organizer's competitions (by any of its slugs) as public cards; DRAFT is never
   * served; newest first. undefined when the organization is unknown or CLOSED.
   * Used by the public organization page and the organization dashboard.
   */
  competitionsByOrganizerSlug(organizationSlug: string): Promise<
    | {
        id: string;
        slug: string;
        name: string;
        status: PublicCompetitionV1['competition']['status'];
        startsAt: string | null;
        endsAt: string | null;
        locationLabel: string | null;
      }[]
    | undefined
  > {
    const key = slugLookupKey(organizationSlug);
    if (key === undefined) return Promise.resolve(undefined);
    return this.tx(async (ctx) => {
      const { rows: org } = await sql<{ organization_id: string }>`
        SELECT s.organization_id FROM organizations.organization_slug s
        JOIN organizations.v_organization_current st ON st.organization_id = s.organization_id
        WHERE s.slug = ${key} AND st.status <> 'CLOSED'`.execute(ctx.trx);
      const organizationId = org[0]?.organization_id;
      if (organizationId === undefined) return undefined;
      const { rows } = await sql<{
        competition_id: string;
        slug: string;
        name: string;
        status: PublicCompetitionV1['competition']['status'];
        starts_at: Date | null;
        ends_at: Date | null;
        location_label: string | null;
      }>`
        SELECT competition_id, slug, name, status, starts_at, ends_at, location_label
        FROM competition_read.competition_card
        WHERE organizer_organization_id = ${organizationId} AND status <> 'DRAFT'
        ORDER BY starts_at DESC NULLS LAST, name, competition_id
        LIMIT 100`.execute(ctx.trx);
      return rows.map((c) => ({
        id: c.competition_id,
        slug: c.slug,
        name: c.name,
        status: c.status,
        startsAt: iso(c.starts_at),
        endsAt: iso(c.ends_at),
        locationLabel: c.location_label,
      }));
    });
  }

  private async resolveCompetition(ctx: TxContext, slug: string) {
    const key = slugLookupKey(slug);
    if (key === undefined) return undefined;
    const { rows } = await sql<{
      competition_id: string;
      slug: string;
      name: string;
      description: string | null;
      status: PublicCompetitionV1['competition']['status'];
      timezone: string;
      starts_at: Date | null;
      ends_at: Date | null;
      location_label: string | null;
      organizer_organization_id: string;
    }>`
      SELECT c.* FROM competition_read.competition_slug s JOIN competition_read.competition_card c ON c.competition_id = s.competition_id
      WHERE s.slug = ${key}`.execute(ctx.trx);
    const c = rows[0];
    if (c === undefined || c.status === 'DRAFT') return undefined;
    return { card: c, redirected: c.slug !== key };
  }

  private async org(ctx: TxContext, organizationId: string) {
    const { rows } = await sql<{ slug: string | null; display_name: string | null }>`
      SELECT s.slug, p.display_name FROM organizations.organization o
      LEFT JOIN organizations.organization_profile p ON p.organization_id = o.id
      LEFT JOIN organizations.v_organization_slug_current s ON s.organization_id = o.id
      WHERE o.id = ${organizationId}`.execute(ctx.trx);
    return {
      organizationId,
      slug: rows[0]?.slug ?? null,
      displayName: rows[0]?.display_name ?? null,
    };
  }

  competitionBySlug(
    slug: string,
  ): Promise<
    { competition: PublicCompetitionV1; canonicalSlug: string; redirected: boolean } | undefined
  > {
    return this.tx(async (ctx) => {
      const r = await this.resolveCompetition(ctx, slug);
      if (r === undefined) return undefined;
      const c = r.card;
      const { rows: events } = await sql<EventSummaryRow>`
        SELECT * FROM competition_read.event_summary WHERE competition_id = ${c.competition_id} AND status <> 'DRAFT'
        ORDER BY starts_at NULLS LAST, name, event_id`.execute(ctx.trx);
      return {
        competition: {
          schema: PUBLIC_COMPETITION_SCHEMA,
          competition: {
            id: c.competition_id,
            slug: c.slug,
            name: c.name,
            description: c.description,
            status: c.status,
            timezone: c.timezone,
            startsAt: iso(c.starts_at),
            endsAt: iso(c.ends_at),
            locationLabel: c.location_label,
            organizer: await this.org(ctx, c.organizer_organization_id),
          },
          events: events.map(summary),
          authority: NOT_AVAILABLE,
        },
        canonicalSlug: c.slug,
        redirected: r.redirected,
      };
    });
  }

  private async resolveEvent(ctx: TxContext, competitionSlug: string, eventSlug: string) {
    const comp = await this.resolveCompetition(ctx, competitionSlug);
    const key = slugLookupKey(eventSlug);
    if (comp === undefined || key === undefined) return undefined;
    const { rows } = await sql<EventSummaryRow>`
      SELECT e.* FROM competition_read.event_slug s JOIN competition_read.event_summary e ON e.event_id = s.event_id
      WHERE s.competition_id = ${comp.card.competition_id} AND s.slug = ${key}`.execute(ctx.trx);
    const e = rows[0];
    if (e === undefined || e.status === 'DRAFT') return undefined;
    return { comp: comp.card, event: e, redirected: comp.redirected || e.slug !== key };
  }

  eventBySlugs(
    competitionSlug: string,
    eventSlug: string,
  ): Promise<
    | {
        event: PublicEventV1;
        canonical: { competitionSlug: string; eventSlug: string };
        redirected: boolean;
      }
    | undefined
  > {
    return this.tx(async (ctx) => {
      const r = await this.resolveEvent(ctx, competitionSlug, eventSlug);
      if (r === undefined) return undefined;
      const e = r.event;
      return {
        event: {
          schema: PUBLIC_EVENT_SCHEMA,
          competition: {
            id: r.comp.competition_id,
            slug: r.comp.slug,
            name: r.comp.name,
            status: r.comp.status,
          },
          event: summary(e),
          field: { locked: e.field_hash !== null, fieldHash: e.field_hash },
          seeding:
            e.seeding_method === null || e.seeding_hash === null
              ? null
              : {
                  method: e.seeding_method,
                  drawAlgorithm: e.draw_algorithm,
                  drawSeed: e.draw_seed,
                  seedingHash: e.seeding_hash,
                },
          plan:
            e.plan_hash === null
              ? null
              : {
                  engine: e.plan_engine as string,
                  inputHash: e.plan_input_hash as string,
                  planHash: e.plan_hash,
                  generatedAt: (e.plan_generated_at as Date).toISOString(),
                },
          results: NOT_AVAILABLE,
          standings: NOT_AVAILABLE,
        },
        canonical: { competitionSlug: r.comp.slug, eventSlug: e.slug },
        redirected: r.redirected,
      };
    });
  }

  /** Public-safe display of participants of an event (athlete names only via the Passport card). */
  private async displays(
    ctx: TxContext,
    eventId: string,
  ): Promise<Map<string, PublicEntrantDisplay>> {
    const { rows } = await sql<{
      participant_id: string | null;
      registration_id: string;
      entrant_type: 'INDIVIDUAL' | 'TEAM';
      team_name: string | null;
      card_slug: string | null;
      card_name: string | null;
      visible: boolean;
    }>`
      SELECT e.participant_id, e.registration_id, e.entrant_type, e.team_name, c.slug AS card_slug, c.display_name AS card_name,
             (c.athlete_id IS NOT NULL AND c.athlete_status = 'ACTIVE' AND NOT c.restricted AND c.profile_visibility = 'PUBLIC') AS visible
      FROM competition_read.event_entry e LEFT JOIN passport.athlete_card c ON c.athlete_id = e.athlete_id
      WHERE e.event_id = ${eventId}`.execute(ctx.trx);
    const out = new Map<string, PublicEntrantDisplay>();
    for (const r of rows) {
      const d: PublicEntrantDisplay =
        r.entrant_type === 'TEAM'
          ? { kind: 'TEAM', teamName: r.team_name ?? 'Team' }
          : r.visible
            ? {
                kind: 'ATHLETE',
                athleteSlug: r.card_slug as string,
                displayName: r.card_name as string,
              }
            : { kind: 'PRIVATE_ENTRANT' };
      out.set(r.participant_id ?? `registration:${r.registration_id}`, d);
    }
    return out;
  }

  entries(competitionSlug: string, eventSlug: string): Promise<PublicEntry[] | undefined> {
    return this.tx(async (ctx) => {
      const r = await this.resolveEvent(ctx, competitionSlug, eventSlug);
      if (r === undefined) return undefined;
      const displays = await this.displays(ctx, r.event.event_id);
      const { rows } = await sql<{
        registration_id: string;
        participant_id: string | null;
        entrant_type: 'INDIVIDUAL' | 'TEAM';
        registration_status: PublicEntry['registrationStatus'];
        participant_status: PublicEntry['participantStatus'];
        seed: number | null;
      }>`
        SELECT registration_id, participant_id, entrant_type, registration_status, participant_status, seed
        FROM competition_read.event_entry WHERE event_id = ${r.event.event_id}
        ORDER BY seed NULLS LAST, confirmed_at, registration_id`.execute(ctx.trx);
      return rows.map((e) => ({
        participantId: e.participant_id,
        kind: e.entrant_type,
        registrationStatus: e.registration_status,
        participantStatus: e.participant_status,
        seed: e.seed,
        display: displays.get(e.participant_id ?? `registration:${e.registration_id}`) ?? {
          kind: 'PRIVATE_ENTRANT',
        },
      }));
    });
  }

  private async contests(
    ctx: TxContext,
    eventId: string,
    displays: Map<string, PublicEntrantDisplay>,
  ): Promise<PublicContest[]> {
    const { rows } = await sql<{
      contest_id: string;
      sequence: number;
      contest_type: PublicContest['contestType'];
      status: PublicContest['status'];
      scheduled_start: Date | null;
      scheduled_end: Date | null;
      venue_organization_id: string | null;
      location_label: string | null;
      court_label: string | null;
      slots: {
        slot: number;
        kind: string;
        participantId?: string;
        contestId?: string;
        contestSequence?: number;
        stageKey?: string;
        groupKey?: string;
        rank?: number;
        ordinal?: number;
        transitionKey?: string;
      }[];
      partition_key: string | null;
      entry_count: number;
      entries: { participantId: string; position: number; startOffsetSeconds?: number }[];
      r_sequence: number;
      r_label: string;
      r_type: PublicContest['round']['roundType'];
    }>`
      SELECT c.*, r.sequence AS r_sequence, r.label AS r_label, r.round_type AS r_type
      FROM competition_read.contest_card c JOIN competition_read.round_card r ON r.round_id = c.round_id
      WHERE c.event_id = ${eventId} ORDER BY c.sequence`.execute(ctx.trx);
    const out: PublicContest[] = [];
    for (const c of rows) {
      out.push({
        contestId: c.contest_id,
        sequence: c.sequence,
        contestType: c.contest_type,
        status: c.status,
        round: { sequence: c.r_sequence, label: c.r_label, roundType: c.r_type },
        scheduledStart: iso(c.scheduled_start),
        scheduledEnd: iso(c.scheduled_end),
        locationLabel: c.location_label,
        courtLabel: c.court_label,
        venue:
          c.venue_organization_id === null ? null : await this.org(ctx, c.venue_organization_id),
        slots: c.slots.map((s): PublicSlot => {
          const occupancy =
            s.participantId === undefined
              ? ({ resolved: false } as const)
              : ({
                  resolved: true,
                  participantId: s.participantId,
                  display: displays.get(s.participantId) ?? { kind: 'PRIVATE_ENTRANT' },
                } as const);
          switch (s.kind) {
            case 'PARTICIPANT':
              return {
                slot: s.slot,
                kind: 'PARTICIPANT',
                participantId: s.participantId as string,
                display: displays.get(s.participantId as string) ?? { kind: 'PRIVATE_ENTRANT' },
              };
            case 'RANK_FROM_STAGE':
              return {
                slot: s.slot,
                kind: 'RANK_FROM_STAGE',
                stageKey: s.stageKey ?? null,
                groupKey: s.groupKey ?? null,
                rank: s.rank as number,
                ...occupancy,
              };
            case 'BEST_RANKED_FROM_STAGE':
              return {
                slot: s.slot,
                kind: 'BEST_RANKED_FROM_STAGE',
                stageKey: s.stageKey as string,
                rank: s.rank as number,
                ordinal: s.ordinal as number,
                ...occupancy,
              };
            case 'QUALIFIER':
              return {
                slot: s.slot,
                kind: 'QUALIFIER',
                transitionKey: s.transitionKey as string,
                ordinal: s.ordinal as number,
                ...occupancy,
              };
            default:
              return {
                slot: s.slot,
                kind: s.kind as 'WINNER_OF_CONTEST' | 'LOSER_OF_CONTEST',
                contestId: s.contestId as string,
                contestSequence: s.contestSequence as number,
                ...occupancy,
              };
          }
        }),
        partitionKey: c.partition_key,
        entryCount: c.entry_count,
        entries: c.entries.map((e) => ({
          participantId: e.participantId,
          position: e.position,
          startOffsetSeconds: e.startOffsetSeconds ?? null,
          display: displays.get(e.participantId) ?? { kind: 'PRIVATE_ENTRANT' as const },
        })),
        result: NOT_AVAILABLE,
      });
    }
    return out;
  }

  /** Scheduled contests first (by time), then unscheduled by sequence. A schedule is not a ranking. */
  schedule(competitionSlug: string, eventSlug: string): Promise<PublicContest[] | undefined> {
    return this.tx(async (ctx) => {
      const r = await this.resolveEvent(ctx, competitionSlug, eventSlug);
      if (r === undefined) return undefined;
      const all = await this.contests(
        ctx,
        r.event.event_id,
        await this.displays(ctx, r.event.event_id),
      );
      return all.sort((a, b) =>
        a.scheduledStart === b.scheduledStart
          ? a.sequence - b.sequence
          : a.scheduledStart === null
            ? 1
            : b.scheduledStart === null
              ? -1
              : a.scheduledStart < b.scheduledStart
                ? -1
                : 1,
      );
    });
  }

  /** Structure/bracket by round. Unresolved slots stay dependencies (presentation shows TBD). */
  structure(
    competitionSlug: string,
    eventSlug: string,
  ): Promise<PublicStructureRound[] | undefined> {
    return this.tx(async (ctx) => {
      const r = await this.resolveEvent(ctx, competitionSlug, eventSlug);
      if (r === undefined) return undefined;
      const displays = await this.displays(ctx, r.event.event_id);
      const contests = await this.contests(ctx, r.event.event_id, displays);
      const { rows: rounds } = await sql<{
        sequence: number;
        label: string;
        round_type: PublicStructureRound['roundType'];
        byes: string[];
        stage_key: string | null;
        stage_label: string | null;
        stage_primitive: 'KNOCKOUT' | 'ROUND_ROBIN' | 'FIELD' | 'HEATS' | null;
        partition_kind: 'LOGISTIC' | 'COMPETITIVE' | null;
        group_key: string | null;
        dynamic_transition_key: string | null;
      }>`
        SELECT sequence, label, round_type, byes, stage_key, stage_label, stage_primitive, partition_kind, group_key, dynamic_transition_key
        FROM competition_read.round_card WHERE event_id = ${r.event.event_id} ORDER BY sequence`.execute(
        ctx.trx,
      );
      return rounds.map((round) => ({
        sequence: round.sequence,
        label: round.label,
        roundType: round.round_type,
        stage:
          round.stage_key === null
            ? null
            : {
                key: round.stage_key,
                label: round.stage_label as string,
                primitive: round.stage_primitive as 'KNOCKOUT' | 'ROUND_ROBIN' | 'FIELD' | 'HEATS',
                partitionKind: round.partition_kind,
              },
        groupKey: round.group_key,
        dynamicEntry:
          round.dynamic_transition_key === null
            ? null
            : { transitionKey: round.dynamic_transition_key },
        byes: round.byes.map((participantId) => ({
          participantId,
          display: displays.get(participantId) ?? { kind: 'PRIVATE_ENTRANT' as const },
        })),
        contests: contests.filter((c) => c.round.sequence === round.sequence),
      }));
    });
  }
}
