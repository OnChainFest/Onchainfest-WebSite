import {
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId, type Uuid } from '@br/domain';
import { CLASSIFICATION_TEMPLATES } from '@br/rankings';
import {
  apiDb,
  declaredNoParticipation,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  uniqueSlug,
} from '@br/testkit';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  competitionResultScopeValidator,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import type { Database } from './db';
import { EventOutcomeStore } from './event-outcome-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * ONCF-L6 (ADR-0078) through the real stores: category completion settles the sporting outcome,
 * a finished category freezes its results and its matches, competition completion needs a
 * completed category, and createEvent cannot race into a finished competition. Every fixture
 * reaches its state legitimately (schedule publication, start, complete, OFFICIAL results through
 * the ResultLedger); races are made provably concurrent with a third connection holding the
 * lifecycle lock until every writer waits on it (the H-2 barrier).
 */

const db = apiDb();
const db2 = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([db, db2, owner, operator].map((d) => d.destroy()));
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(db);
const comps2 = new CompetitionStore(db2);
const structure = new StructureStore(db);
const structure2 = new StructureStore(db2);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const outcomes = new EventOutcomeStore(db, scoring);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const ledger2 = createCompetitionResultLedger(db2, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const tennis = CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === 'tennis.singles')?.specs[1] as DisciplineVersionSpec;
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `l${tag}`,
          name: 'ONCF-L6 test sport',
          disciplines: [{ code: `l${tag}.tennis`, name: 'tennis', specs: [tennis] }],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'se',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
        {
          code: `rr-${tag}`,
          name: 'rr',
          versions: [{ engineId: 'round-robin', engineVersion: 2 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => t.code === 'sets-bo3-tiebreak').map((t) => ({
        code: `r${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.filter(
        (t) => t.code === 'tennis-court-match',
      ).map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
    classificationTemplates: CLASSIFICATION_TEMPLATES.filter((t) => t.code === 'itf_rr').map(
      (t) => ({
        code: `t${tag}_${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      }),
    ),
  });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code === `l${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code === `se-${tag}`) ids['se'] = fv.formatVersionId;
    else if (fv.format.code === `rr-${tag}`) ids['rr'] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `r${tag}-sets-bo3-tiebreak`) ids['rs'] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code === `t${tag}_itf_rr`) ids['tp'] = t.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids['sp'] = p.versionId;
}, 240_000);

// ───────────────────────────── fixtures ─────────────────────────────

interface Comp {
  competitionId: string;
  actor: string;
  court: string;
  ref: Uuid;
}

/** An ACTIVE competition with one open court, declared hours and a results referee. */
async function competition(): Promise<Comp> {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('l6'),
    profile: { name: 'ONCF-L6 Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
  // The referee is recorded first, well before its first use (authority reads are as of the
  // transaction time).
  const ref = await referee(competitionId);
  const { resourceId } = await resources.createResource({
    actorAccountId: actor,
    competitionId,
    typeCode: 'TENNIS_COURT',
    resource: { label: 'Court 1' },
    idempotencyKey: k(),
  });
  for (const weekday of [1, 2, 3, 4, 5, 6, 7])
    await resources.addAvailability({
      actorAccountId: actor,
      competitionId,
      resourceId: null,
      fact: { kind: 'WEEKLY', weekday, start: '00:00', end: '24:00' },
      idempotencyKey: k(),
    });
  return { competitionId, actor, court: resourceId, ref };
}

/** A results-authority referee for the competition (PLATFORM anchor → PERSON grant). */
async function referee(competitionId: string): Promise<Uuid> {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (L6)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (L6)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'] as never,
    scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  await settledAuthority(ref.id);
  return ref.id as Uuid;
}

/**
 * Authority is evaluated as of the transaction time (the database clock). The local Docker clock
 * has been measured stepping back by up to ~1.5 s, so a principal used right after it is recorded
 * can read as not yet known (PRINCIPAL_UNKNOWN). The fixture waits until the database clock is
 * safely past the principal's and its grants' recording — a fixture-time margin, no assertion is relaxed.
 */
async function settledAuthority(principalId: string) {
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > greatest(p.recorded_at, max(g.recorded_at), max(g.effective_from)) + interval '2 seconds' AS ok
      FROM authority.principal p LEFT JOIN authority.authority_grant g ON g.grantee_principal_id = p.id
      WHERE p.id = ${principalId} GROUP BY p.recorded_at`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Cat {
  eventId: string;
  /** Contests in plan order with their entrants in slot order. */
  contests: { id: string; places: string[] }[];
}

/** A started tennis category: knockout ('se') or one round-robin group ('rr'). */
async function category(comp: Comp, format: 'se' | 'rr', entrants: number): Promise<Cat> {
  const { eventId } = await comps.createEvent({
    actorAccountId: comp.actor,
    competitionId: comp.competitionId,
    slug: uniqueSlug('cat'),
    disciplineVersionId: ids['tennis'] as string,
    formatVersionId: ids[format] as string,
    formatConfig: {},
    settings: { name: `Singles ${format}`, capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: comp.actor, eventId });
  await scoring.pinScoring({
    actorAccountId: comp.actor,
    eventId,
    rulesetVersionId: ids['rs'] as string,
    ...(format === 'rr' ? { classificationTemplateVersionId: ids['tp'] as string } : {}),
    schedulingProfileVersionId: ids['sp'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < entrants; i++) {
    const a = await newAthlete(identity, `l6p${i}`, `Player ${i}`);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: comp.actor, eventId });
  await structure.lockField({ actorAccountId: comp.actor, eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: comp.actor,
    eventId,
    idempotencyKey: k(),
    method: 'DETERMINISTIC_DRAW',
  });
  await structure.generatePlan({ actorAccountId: comp.actor, eventId, idempotencyKey: k() });
  await comps.startEvent({ actorAccountId: comp.actor, eventId });
  const { rows } = await sql<{ id: string; places: (string | null)[] | null }>`
    SELECT c.id, (SELECT array_agg(o.participant_id ORDER BY o.place) FROM competition.v_contest_occupant o
                  WHERE o.contest_id = c.id) AS places
    FROM competition.contest c WHERE c.event_id = ${eventId} ORDER BY c.sequence`.execute(owner);
  return {
    eventId,
    contests: rows.map((r) => ({
      id: r.id,
      places: (r.places ?? []).flatMap((p) => (p === null ? [] : [p])),
    })),
  };
}

let day = 0;
/** Publishes a schedule placing each contest on its own day (PLANNED → SCHEDULED). */
async function publish(comp: Comp, contestIds: readonly string[]) {
  const { versionId } = await schedule.openDraft({
    actorAccountId: comp.actor,
    competitionId: comp.competitionId,
    idempotencyKey: k(),
  });
  for (const contestId of contestIds) {
    day += 1;
    const d = new Date(Date.UTC(2027, 5, 1) + day * 86_400_000).toISOString().slice(0, 10);
    await schedule.setAssignment({
      actorAccountId: comp.actor,
      versionId,
      contestId,
      assignment: { resourceId: comp.court, startsAt: `${d}T10:00:00Z` },
      expectedLastFactId: null,
      idempotencyKey: k(),
    });
  }
  const r = await schedule.validate({ actorAccountId: comp.actor, versionId });
  expect(r.conflicts.filter((c) => c.severity === 'HARD')).toEqual([]);
  const base = (
    await sql<{ id: string }>`
      SELECT version_id AS id FROM competition.v_schedule_version_current
      WHERE competition_id = ${comp.competitionId} AND status = 'PUBLISHED'`.execute(owner)
  ).rows[0]?.id;
  await schedule.publish({
    actorAccountId: comp.actor,
    versionId,
    baseVersionId: base ?? null,
    reportHash: r.reportHash,
    acknowledgedConflictKeys: r.conflicts
      .filter((c) => c.severity === 'SOFT')
      .map((c) => c.conflictKey),
    idempotencyKey: k(),
  });
}

/** Scheduled, started and completed (the activity ended; no result is created). */
async function played(comp: Comp, contestIds: readonly string[]) {
  await publish(comp, contestIds);
  for (const contestId of contestIds) {
    await structure.startContest({ actorAccountId: comp.actor, contestId });
    await structure.completeContest({ actorAccountId: comp.actor, contestId });
  }
}

/** Slot 1 wins in straight sets (or slot 2 when `firstWins` is false). */
const sets = (firstWins = true): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: [{ games: firstWins ? [6, 2] : [2, 6] }, { games: firstWins ? [6, 3] : [3, 6] }],
});

const scopeOf = (contestId: string) =>
  resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });

async function draftFor(comp: Comp, contestId: string, sheet: ScoreSheet, resultId?: string) {
  const v = await scoring.validateScoreSheet({ actorAccountId: comp.actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const rid =
    resultId ??
    (await ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: contestId as Uuid })).id;
  const { draftId } = await ledger.saveDraft({
    resultId: rid as Uuid,
    authorPrincipalId: comp.ref,
    disciplineVersionRef: 'oncf-l6@1',
    content: v.content,
  });
  return { resultId: rid, draftId };
}

/** A result through the ResultLedger, up to `upTo` (SUBMITTED, PROVISIONAL or OFFICIAL). */
async function result(
  comp: Comp,
  contestId: string,
  upTo: 'SUBMITTED' | 'PROVISIONAL' | 'OFFICIAL' = 'OFFICIAL',
  firstWins = true,
) {
  const { resultId, draftId } = await draftFor(comp, contestId, sets(firstWins));
  const scope = await scopeOf(contestId);
  const submitKey = k();
  const sub = await ledger.submitDraft({
    draftId,
    actorPrincipalId: comp.ref,
    scope,
    idempotencyKey: submitKey,
  });
  for (const toStatus of ['PROVISIONAL', 'OFFICIAL'] as const) {
    if (upTo === 'SUBMITTED' || (upTo === 'PROVISIONAL' && toStatus === 'OFFICIAL')) break;
    await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus,
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: k(),
    });
  }
  return { resultId, versionId: sub.resultVersionId, draftId, submitKey, scope };
}

const statuses = async (table: string, column: string, id: string) =>
  (
    await sql<{ status: string }>`
      SELECT status FROM ${sql.table(`competition.${table}`)} WHERE ${sql.ref(column)} = ${id} ORDER BY seq`.execute(
      owner,
    )
  ).rows.map((r) => r.status);
const eventStatus = async (eventId: string) =>
  (await statuses('event_status_change', 'event_id', eventId)).at(-1);
const competitionStatus = async (competitionId: string) =>
  (await statuses('competition_status_change', 'competition_id', competitionId)).at(-1);
const contestStatus = async (contestId: string) =>
  (await statuses('contest_status_change', 'contest_id', contestId)).at(-1);
const currentVersion = async (contestId: string) =>
  (
    await sql<{ id: string | null; status: string | null }>`
      SELECT rs.current_version_id AS id, st.current_status AS status FROM results.result r
      JOIN results.result_state rs ON rs.result_id = r.id
      LEFT JOIN results.result_version_state st ON st.result_version_id = rs.current_version_id
      WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ${contestId}`.execute(owner)
  ).rows[0];

const complete = (comp: Comp, cat: Cat, store = comps) =>
  store.completeEvent({ actorAccountId: comp.actor, eventId: cat.eventId });

async function refusal(p: Promise<unknown>, code: DomainErrorCode, reason?: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected a refusal').toBeDefined();
  expect(err).toMatchObject({ code });
  if (reason !== undefined)
    expect((err as { details: { reason?: string } }).details.reason).toBe(reason);
  return err as { details: Record<string, unknown> };
}

/** A settled single-final knockout: the final played and OFFICIAL (slot 1 wins). */
async function settledFinal(comp: Comp) {
  const cat = await category(comp, 'se', 2);
  const final = cat.contests[0]?.id as string;
  await played(comp, [final]);
  const r = await result(comp, final);
  return { cat, final, ...r };
}

// ───────────────────────────── barrier (H-2 pattern) ─────────────────────────────

const lockId = (key: string) => sql`hashtextextended(${key}, 0)`;
const waitingOn = async (trx: Transaction<Database>, key: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = ${lockId(key)}`.execute(trx)
  ).rows[0]?.n ?? 0;

function track<T>(p: Promise<T>) {
  const t = {
    settled: false,
    result: Promise.allSettled([p]).then(([r]) => r as PromiseSettledResult<T>),
  };
  void t.result.then(() => {
    t.settled = true;
  });
  return t;
}

/**
 * A third connection holds the advisory lock `key` while `start` launches the writers, and
 * releases it once `waiters` transactions wait on it (or one writer already finished — which
 * means it did not take the lock, and the assertions then fail instead of the test hanging).
 */
async function underLock<T>(
  key: string,
  waiters: number,
  start: () => Promise<T>[],
): Promise<PromiseSettledResult<T>[]> {
  let settled: Promise<PromiseSettledResult<T>[]> | undefined;
  await owner.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${lockId(key)})`.execute(trx);
    const writers = start().map((p) => track(p));
    settled = Promise.all(writers.map((w) => w.result));
    while (!writers.some((w) => w.settled) && (await waitingOn(trx, key)) < waiters);
  });
  return settled as Promise<PromiseSettledResult<T>[]>;
}
const ok = (r: PromiseSettledResult<unknown> | undefined) => r?.status === 'fulfilled';
const errOf = (r: PromiseSettledResult<unknown> | undefined) =>
  (r as PromiseRejectedResult).reason as { code: string; details: { reason?: string } };

// ───────────────────────────── category completion ─────────────────────────────

describe('L6 category completion settles the outcome (ADR-0078 §2.1)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('1–3. PLANNED, SCHEDULED and IN_PROGRESS matches block completion (CONTESTS_OPEN)', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    const planned = await refusal(
      complete(comp, cat),
      DomainErrorCode.INVALID_TRANSITION,
      'CONTESTS_OPEN',
    );
    expect(planned.details['contests']).toEqual([final]);
    await publish(comp, [final]);
    expect(await contestStatus(final)).toBe('SCHEDULED');
    await refusal(complete(comp, cat), DomainErrorCode.INVALID_TRANSITION, 'CONTESTS_OPEN');
    await structure.startContest({ actorAccountId: comp.actor, contestId: final });
    await refusal(complete(comp, cat), DomainErrorCode.INVALID_TRANSITION, 'CONTESTS_OPEN');
    expect(await eventStatus(cat.eventId)).toBe('IN_PROGRESS');
  }, 300_000);

  it('4–6. a completed match without a result, with only a SUBMITTED or a PROVISIONAL one blocks', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await played(comp, [final]);
    const none = await refusal(
      complete(comp, cat),
      DomainErrorCode.INVALID_TRANSITION,
      'RESULTS_NOT_OFFICIAL',
    );
    expect(none.details['contests']).toEqual([final]);
    const r = await result(comp, final, 'SUBMITTED');
    await refusal(complete(comp, cat), DomainErrorCode.INVALID_TRANSITION, 'RESULTS_NOT_OFFICIAL');
    await ledger.transition({
      resultVersionId: r.versionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: comp.ref,
      scope: r.scope,
      idempotencyKey: k(),
    });
    expect(await currentVersion(final)).toMatchObject({ status: 'PROVISIONAL' });
    await refusal(complete(comp, cat), DomainErrorCode.INVALID_TRANSITION, 'RESULTS_NOT_OFFICIAL');
    expect(await eventStatus(cat.eventId)).toBe('IN_PROGRESS');
  }, 300_000);

  it('7–8. an OFFICIAL final completes; a dangling non-current SUBMITTED version does not block', async () => {
    const s = await settledFinal(comp);
    // A second version submitted after the official one stays SUBMITTED and never current.
    const { draftId } = await draftFor(comp, s.final, sets(false), s.resultId);
    await ledger.submitDraft({
      draftId,
      actorPrincipalId: comp.ref,
      scope: s.scope,
      idempotencyKey: k(),
    });
    expect(await currentVersion(s.final)).toEqual({ id: s.versionId, status: 'OFFICIAL' });
    await complete(comp, s.cat);
    expect(await eventStatus(s.cat.eventId)).toBe('COMPLETED');
    const d = await outcomes.derive(s.cat.eventId);
    expect(d.outcome.document).toMatchObject({ kind: 'KNOCKOUT', status: 'DECIDED' });
    const [winner, loser] = s.cat.contests[0]?.places as [string, string];
    expect(d.outcome.document.placements.map((p) => [p.participantId, p.position])).toEqual([
      [winner, 1],
      [loser, 2],
    ]);
  }, 300_000);

  it('a cancelled knockout final leaves the outcome UNDECIDED: completion is refused (D7)', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await structure.cancelContest({ actorAccountId: comp.actor, contestId: final, reason: 'rain' });
    const err = await refusal(
      complete(comp, cat),
      DomainErrorCode.INVALID_TRANSITION,
      'OUTCOME_UNDECIDED',
    );
    expect(err.details['outcome']).toEqual(['FINAL_CANCELLED']);
    // The organizer's way out: cancel the category.
    await comps.cancelEvent({ actorAccountId: comp.actor, eventId: cat.eventId, reason: 'rain' });
    expect(await eventStatus(cat.eventId)).toBe('CANCELLED');
  }, 300_000);

  it('9–10. a round robin completes with a CANCELLED and a VOID match exempt (no result needed)', async () => {
    const cat = await category(comp, 'rr', 4);
    expect(cat.contests).toHaveLength(6);
    const [c1, c2, c3, c4, c5, c6] = cat.contests.map((c) => c.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await structure.cancelContest({ actorAccountId: comp.actor, contestId: c6, reason: 'rain' });
    await played(comp, [c1, c2, c3, c4]);
    await publish(comp, [c5]);
    await structure.startContest({ actorAccountId: comp.actor, contestId: c5 });
    await structure.voidContest({
      actorAccountId: comp.actor,
      contestId: c5,
      reason: 'walkover dispute',
    });
    for (const c of [c1, c2, c3]) await result(comp, c);
    await refusal(complete(comp, cat), DomainErrorCode.INVALID_TRANSITION, 'RESULTS_NOT_OFFICIAL');
    await result(comp, c4);
    await complete(comp, cat);
    expect(await eventStatus(cat.eventId)).toBe('COMPLETED');
    const d = await outcomes.derive(cat.eventId);
    expect(d.outcome.document).toMatchObject({ kind: 'STANDINGS', status: 'DECIDED' });
    expect(d.outcome.document.standings).toHaveLength(1);
    expect(d.outcome.document.inputs.map((i) => i.contestId).sort()).toEqual(
      [c1, c2, c3, c4].sort(),
    );
  }, 600_000);
});

// ───────────────────────────── V1 hardening ─────────────────────────────

describe('V1 hardening: a CANCELLED or VOID match contributes nothing (ADR-0066)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  /**
   * A 3-player round robin played as a cycle: A beats B, B beats C, C beats A. Counted in full it
   * is a three-way tie; without C–A it is A (beat B head-to-head) 1st, B 2nd, C 3rd.
   */
  async function cycle() {
    const cat = await category(comp, 'rr', 3);
    expect(cat.contests).toHaveLength(3);
    const [a, b] = cat.contests[0]?.places as [string, string];
    const c = cat.contests.flatMap((x) => x.places).find((p) => p !== a && p !== b) as string;
    const between = (x: string, y: string) =>
      cat.contests.find((k) => k.places.includes(x) && k.places.includes(y)) as Cat['contests'][0];
    const won = (k: Cat['contests'][0], winner: string) => k.places[0] === winner;
    return { cat, a, b, c, ab: between(a, b), bc: between(b, c), ca: between(c, a), won };
  }

  const inputIds = async (eventId: string) =>
    (await outcomes.derive(eventId)).outcome.document.inputs.map((i) => i.contestId).sort();

  async function expectExcluded(r: Awaited<ReturnType<typeof cycle>>) {
    const { cat, a, b, c, ab, bc, ca } = r;
    // Only the two counted matches are inputs; C (whose only counted match is a loss) stays listed.
    expect(await inputIds(cat.eventId)).toEqual([ab.id, bc.id].sort());
    const before = await outcomes.derive(cat.eventId);
    const stageKey = before.outcome.document.finalStageKey as string;
    const table = await scoring.classificationAt({
      eventId: cat.eventId,
      stageKey,
      floor: 'OFFICIAL',
    });
    expect(table.pendingContests).toEqual([]);
    expect(table.document.inputs.map((i) => i.contestId).sort()).toEqual([ab.id, bc.id].sort());
    expect(table.document.entries.map((e) => e.participantId).sort()).toEqual([a, b, c].sort());

    await complete(comp, cat);
    expect(await eventStatus(cat.eventId)).toBe('COMPLETED');
    const d = await outcomes.derive(cat.eventId);
    expect(d.outcome.document).toMatchObject({ kind: 'STANDINGS', status: 'DECIDED' });
    expect(d.outcome.document.placements.map((p) => [p.participantId, p.position, p.tied])).toEqual(
      [
        [a, 1, false],
        [b, 2, false],
        [c, 3, false],
      ],
    );

    const pub = await outcomes.publicEvent(cat.eventId, new Map());
    expect(pub.podium).toMatchObject({ status: 'AVAILABLE' });
    expect(
      pub.podium.status === 'AVAILABLE' ? pub.podium.placements.map((p) => p.participantId) : [],
    ).toEqual([a, b, c]);
    const shown = pub.matches.find((m) => m.contestId === ca.id);
    expect(shown).toMatchObject({ official: false });
    expect(shown?.entrants.every((e) => e.outcome === null && e.score.length === 0)).toBe(true);
    expect(pub.matches.find((m) => m.contestId === ab.id)).toMatchObject({ official: true });
  }

  it('B1. a match voided after its result became OFFICIAL leaves standings, podium and public outcome', async () => {
    const r = await cycle();
    const { cat, a, b, c, ab, bc, ca, won } = r;
    await played(comp, [ab.id, bc.id, ca.id]);
    await result(comp, ab.id, 'OFFICIAL', won(ab, a));
    await result(comp, bc.id, 'OFFICIAL', won(bc, b));
    await result(comp, ca.id, 'OFFICIAL', won(ca, c));
    // Counted while it stands: every match is an input.
    expect(await inputIds(cat.eventId)).toEqual([ab.id, bc.id, ca.id].sort());
    await structure.voidContest({
      actorAccountId: comp.actor,
      contestId: ca.id,
      reason: 'wrong player',
    });
    expect(await contestStatus(ca.id)).toBe('VOID');
    expect((await currentVersion(ca.id))?.status).toBe('OFFICIAL');
    await expectExcluded(r);
  }, 600_000);

  it('B1. a match cancelled with an OFFICIAL result on it leaves standings, podium and public outcome', async () => {
    const r = await cycle();
    const { cat, a, b, c, ab, bc, ca, won } = r;
    // The ledger has no contest-lifecycle gate: a result can be declared before the match is played.
    await result(comp, ca.id, 'OFFICIAL', won(ca, c));
    await played(comp, [ab.id, bc.id]);
    await result(comp, ab.id, 'OFFICIAL', won(ab, a));
    await result(comp, bc.id, 'OFFICIAL', won(bc, b));
    expect(await inputIds(cat.eventId)).toEqual([ab.id, bc.id, ca.id].sort());
    await structure.cancelContest({ actorAccountId: comp.actor, contestId: ca.id, reason: 'rain' });
    expect(await contestStatus(ca.id)).toBe('CANCELLED');
    expect((await currentVersion(ca.id))?.status).toBe('OFFICIAL');
    await expectExcluded(r);
  }, 600_000);
});

// ───────────────────────────── freeze ─────────────────────────────

describe('L6 results freeze at COMPLETED and CANCELLED (ADR-0078 §2.2–§2.3)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('12–17. a completed category refuses submit, accept, correct; an idempotent replay still answers', async () => {
    const s = await settledFinal(comp);
    // Before completion: a second version is submitted (not current) — the accept candidate.
    const second = await draftFor(comp, s.final, sets(false), s.resultId);
    const replayKey = k();
    const submitted = await ledger.submitDraft({
      draftId: second.draftId,
      actorPrincipalId: comp.ref,
      scope: s.scope,
      idempotencyKey: replayKey,
    });
    await complete(comp, s.cat);
    const before = await outcomes.derive(s.cat.eventId);

    // 16. submit
    const third = await draftFor(comp, s.final, sets(false), s.resultId);
    const frozen = await refusal(
      ledger.submitDraft({
        draftId: third.draftId,
        actorPrincipalId: comp.ref,
        scope: s.scope,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'RESULTS_FROZEN',
    );
    expect(frozen.details['eventStatus']).toBe('COMPLETED');
    // 14. accept (and reject: the same T3/T4 command)
    for (const toStatus of ['PROVISIONAL', 'REJECTED'] as const)
      await refusal(
        ledger.transition({
          resultVersionId: submitted.resultVersionId,
          toStatus: toStatus as 'PROVISIONAL',
          actorPrincipalId: comp.ref,
          scope: s.scope,
          idempotencyKey: k(),
        }),
        DomainErrorCode.INVALID_TRANSITION,
        'RESULTS_FROZEN',
      );
    // 13. correct
    const corr = await draftFor(comp, s.final, sets(false), s.resultId);
    await refusal(
      ledger.correct({
        draftId: corr.draftId,
        supersedesVersionId: s.versionId as Uuid,
        actorPrincipalId: comp.ref,
        scope: s.scope,
        reason: 'scorer error',
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'RESULTS_FROZEN',
    );
    // 17. the replay of a submit that succeeded before the freeze returns its recorded outcome.
    const replay = await ledger.submitDraft({
      draftId: second.draftId,
      actorPrincipalId: comp.ref,
      scope: s.scope,
      idempotencyKey: replayKey,
    });
    expect(replay).toMatchObject({ resultVersionId: submitted.resultVersionId, created: false });
    // 28. nothing moved: the derived outcome (and its hash) is unchanged.
    expect(await currentVersion(s.final)).toEqual({ id: s.versionId, status: 'OFFICIAL' });
    const after = await outcomes.derive(s.cat.eventId);
    expect(after.outcome.hash).toBe(before.outcome.hash);
    expect(after.outcome.document).toEqual(before.outcome.document);
  }, 300_000);

  it('18. a finished category refuses match complete, void and cancel (EVENT_FINISHED)', async () => {
    const s = await settledFinal(comp);
    await complete(comp, s.cat);
    const err = await refusal(
      structure.voidContest({ actorAccountId: comp.actor, contestId: s.final, reason: 'appeal' }),
      DomainErrorCode.INVALID_TRANSITION,
      'EVENT_FINISHED',
    );
    expect(err.details['eventStatus']).toBe('COMPLETED');
    expect(await contestStatus(s.final)).toBe('COMPLETED');
    // Under a CANCELLED category an IN_PROGRESS match stays as it is (history), never re-moved.
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await publish(comp, [final]);
    await structure.startContest({ actorAccountId: comp.actor, contestId: final });
    await comps.cancelEvent({ actorAccountId: comp.actor, eventId: cat.eventId, reason: 'storm' });
    for (const p of [
      structure.completeContest({ actorAccountId: comp.actor, contestId: final }),
      structure.voidContest({ actorAccountId: comp.actor, contestId: final, reason: 'storm' }),
    ])
      await refusal(p, DomainErrorCode.INVALID_TRANSITION, 'EVENT_FINISHED');
    expect(await contestStatus(final)).toBe('IN_PROGRESS');
  }, 300_000);

  it('11 + 15. a CANCELLED category freezes its results too (declare-official refused)', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await played(comp, [final]);
    const r = await result(comp, final, 'PROVISIONAL');
    await comps.cancelEvent({ actorAccountId: comp.actor, eventId: cat.eventId, reason: 'storm' });
    const err = await refusal(
      ledger.transition({
        resultVersionId: r.versionId,
        toStatus: 'OFFICIAL',
        actorPrincipalId: comp.ref,
        scope: r.scope,
        idempotencyKey: k(),
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'RESULTS_FROZEN',
    );
    expect(err.details['eventStatus']).toBe('CANCELLED');
    expect(await currentVersion(final)).toMatchObject({ status: 'PROVISIONAL' });
  }, 300_000);

  it('31. classification scopes are not frozen; a contest of a running category is not frozen', async () => {
    const s = await settledFinal(comp);
    const running = await category(comp, 'se', 2);
    await complete(comp, s.cat);
    await inTransaction(db, ModuleRole.results, async (ctx) => {
      await competitionResultScopeValidator.assertMutable(
        ctx,
        'EVENT_CLASSIFICATION',
        s.cat.eventId,
      );
      await competitionResultScopeValidator.assertMutable(
        ctx,
        'CONTEST',
        running.contests[0]?.id as string,
      );
    });
    await expect(
      inTransaction(db, ModuleRole.results, (ctx) =>
        competitionResultScopeValidator.assertMutable(ctx, 'CONTEST', s.final),
      ),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      details: { reason: 'RESULTS_FROZEN' },
    });
  }, 300_000);
});

// ───────────────────────────── competition completion ─────────────────────────────

describe('L6 competition completion needs a completed category (ADR-0078 §2.4)', () => {
  it('19–21. open category refused (EVENTS_OPEN); only cancelled refused (NO_COMPLETED_EVENT); settled + cancelled completes', async () => {
    const comp = await competition();
    const s = await settledFinal(comp);
    const other = await category(comp, 'se', 2);
    const complete = () =>
      comps.completeCompetition({ actorAccountId: comp.actor, competitionId: comp.competitionId });
    await refusal(complete(), DomainErrorCode.INVALID_TRANSITION, 'EVENTS_OPEN');
    await comps.completeEvent({ actorAccountId: comp.actor, eventId: s.cat.eventId });
    await refusal(complete(), DomainErrorCode.INVALID_TRANSITION, 'EVENTS_OPEN');
    await comps.cancelEvent({ actorAccountId: comp.actor, eventId: other.eventId, reason: 'rain' });
    await complete();
    expect(await competitionStatus(comp.competitionId)).toBe('COMPLETED');

    const onlyCancelled = await competition();
    const c = await category(onlyCancelled, 'se', 2);
    await comps.cancelEvent({
      actorAccountId: onlyCancelled.actor,
      eventId: c.eventId,
      reason: 'x',
    });
    await refusal(
      comps.completeCompetition({
        actorAccountId: onlyCancelled.actor,
        competitionId: onlyCancelled.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'NO_COMPLETED_EVENT',
    );
    // With no category at all, too.
    const empty = await competition();
    await refusal(
      comps.completeCompetition({
        actorAccountId: empty.actor,
        competitionId: empty.competitionId,
      }),
      DomainErrorCode.INVALID_TRANSITION,
      'NO_COMPLETED_EVENT',
    );
    expect(await competitionStatus(empty.competitionId)).toBe('ACTIVE');
  }, 900_000);
});

// ───────────────────────────── races ─────────────────────────────

describe('L6 races are serialized by the existing lifecycle locks', () => {
  const create = (comp: Comp, store = comps) =>
    store.createEvent({
      actorAccountId: comp.actor,
      competitionId: comp.competitionId,
      slug: uniqueSlug('late'),
      disciplineVersionId: ids['tennis'] as string,
      formatVersionId: ids['se'] as string,
      formatConfig: {},
      settings: { name: 'Late category', capacity: null, registrationMode: 'AUTO_CONFIRM' },
      idempotencyKey: k(),
    });
  const openEvents = async (competitionId: string) =>
    (
      await sql<{ status: string }>`
        SELECT s.status FROM competition.event e JOIN competition.v_event_current s ON s.event_id = e.id
        WHERE e.competition_id = ${competitionId} AND s.status NOT IN ('COMPLETED', 'CANCELLED')`.execute(
        owner,
      )
    ).rows;

  it('22. createEvent vs completeCompetition, provably concurrent: never an event in a completed competition', async () => {
    const comp = await competition();
    const s = await settledFinal(comp);
    await comps.completeEvent({ actorAccountId: comp.actor, eventId: s.cat.eventId });
    const [c, e] = await underLock<unknown>(`competition:${comp.competitionId}`, 2, () => [
      comps.completeCompetition({ actorAccountId: comp.actor, competitionId: comp.competitionId }),
      create(comp, comps2),
    ]);
    // Exactly one wins: completion first refuses the creation; creation first refuses completion.
    expect([ok(c), ok(e)].filter(Boolean)).toHaveLength(1);
    if (ok(c)) {
      expect(errOf(e).code).toBe(DomainErrorCode.INVALID_TRANSITION);
      expect(await competitionStatus(comp.competitionId)).toBe('COMPLETED');
      expect(await openEvents(comp.competitionId)).toEqual([]);
    } else {
      expect(errOf(c).details.reason).toBe('EVENTS_OPEN');
      expect(await competitionStatus(comp.competitionId)).toBe('ACTIVE');
    }
  }, 600_000);

  it('23. createEvent vs cancelCompetition, provably concurrent: never an open event in a cancelled competition', async () => {
    const comp = await competition();
    const [c, e] = await underLock<unknown>(`competition:${comp.competitionId}`, 2, () => [
      comps.cancelCompetition({
        actorAccountId: comp.actor,
        competitionId: comp.competitionId,
        reason: 'storm',
      }),
      create(comp, comps2),
    ]);
    expect(ok(c)).toBe(true);
    if (!ok(e)) expect(errOf(e).code).toBe(DomainErrorCode.INVALID_TRANSITION);
    // Creation first: the cascade cancelled the new event; cancellation first: no event exists.
    expect(await competitionStatus(comp.competitionId)).toBe('CANCELLED');
    expect(await openEvents(comp.competitionId)).toEqual([]);
  }, 600_000);

  it('24. two categories of one competition complete concurrently', async () => {
    const comp = await competition();
    const a = await settledFinal(comp);
    const b = await settledFinal(comp);
    const results = await Promise.allSettled([
      complete(comp, a.cat),
      complete(comp, b.cat, comps2),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect([await eventStatus(a.cat.eventId), await eventStatus(b.cat.eventId)]).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);
  }, 600_000);

  it('25. completeEvent vs declare-official on the final: never completed over a non-official result', async () => {
    const comp = await competition();
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await played(comp, [final]);
    const r = await result(comp, final, 'PROVISIONAL');
    const [d, o] = await underLock<unknown>(`contest:${final}`, 2, () => [
      complete(comp, cat),
      ledger2.transition({
        resultVersionId: r.versionId,
        toStatus: 'OFFICIAL',
        actorPrincipalId: comp.ref,
        scope: r.scope,
        idempotencyKey: k(),
      }),
    ]);
    // Declaration always succeeds; completion either saw PROVISIONAL (RESULTS_NOT_OFFICIAL) or
    // finds the outcome it computed beforehand stale (CONCURRENCY_CONFLICT).
    expect(ok(o)).toBe(true);
    expect(ok(d)).toBe(false);
    expect(['RESULTS_NOT_OFFICIAL', 'OUTCOME_INPUTS_CHANGED']).toContain(errOf(d).details.reason);
    expect(await eventStatus(cat.eventId)).toBe('IN_PROGRESS');
    // Retried, it completes over the official result.
    await complete(comp, cat);
    expect(await eventStatus(cat.eventId)).toBe('COMPLETED');
  }, 600_000);

  it('26. completeEvent vs correction of the official final: exactly one takes effect', async () => {
    const comp = await competition();
    const s = await settledFinal(comp);
    const corr = await draftFor(comp, s.final, sets(false), s.resultId);
    const [d, c] = await underLock<unknown>(`contest:${s.final}`, 2, () => [
      complete(comp, s.cat),
      ledger2.correct({
        draftId: corr.draftId,
        supersedesVersionId: s.versionId as Uuid,
        actorPrincipalId: comp.ref,
        scope: s.scope,
        reason: 'scorer error',
        idempotencyKey: k(),
      }),
    ]);
    expect([ok(d), ok(c)].filter(Boolean)).toHaveLength(1);
    if (ok(d)) {
      // Completion first: the correction met a frozen result.
      expect(errOf(c).details.reason).toBe('RESULTS_FROZEN');
      expect(await currentVersion(s.final)).toEqual({ id: s.versionId, status: 'OFFICIAL' });
      expect(await eventStatus(s.cat.eventId)).toBe('COMPLETED');
    } else {
      // Correction first: its new version is PROVISIONAL, so the category cannot complete.
      expect(['RESULTS_NOT_OFFICIAL', 'OUTCOME_INPUTS_CHANGED']).toContain(errOf(d).details.reason);
      expect(await currentVersion(s.final)).toMatchObject({ status: 'PROVISIONAL' });
      expect(await eventStatus(s.cat.eventId)).toBe('IN_PROGRESS');
    }
  }, 600_000);

  it('27. completeEvent vs voiding the final: exactly one takes effect', async () => {
    const comp = await competition();
    const s = await settledFinal(comp);
    const [d, v] = await underLock<unknown>(`contest:${s.final}`, 2, () => [
      complete(comp, s.cat),
      structure2.voidContest({ actorAccountId: comp.actor, contestId: s.final, reason: 'appeal' }),
    ]);
    expect([ok(d), ok(v)].filter(Boolean)).toHaveLength(1);
    if (ok(d)) {
      expect(errOf(v).details.reason).toBe('EVENT_FINISHED');
      expect(await contestStatus(s.final)).toBe('COMPLETED');
    } else {
      // The void went first: the outcome computed beforehand is stale (and now UNDECIDED).
      expect(['OUTCOME_INPUTS_CHANGED', 'OUTCOME_UNDECIDED']).toContain(errOf(d).details.reason);
      expect(await contestStatus(s.final)).toBe('VOID');
      expect(await eventStatus(s.cat.eventId)).toBe('IN_PROGRESS');
    }
  }, 600_000);
});
