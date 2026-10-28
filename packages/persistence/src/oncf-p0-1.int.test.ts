import {
  ADVANCEMENT_POLICY_TEMPLATES,
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
import { AdvancementStore } from './advancement-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
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
import { ResultLedger } from './result-ledger';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF WP-P0-1 (D-14): a result is submitted, accepted, declared OFFICIAL or corrected only while
 * its match is IN_PROGRESS or COMPLETED. PLANNED / SCHEDULED (never played), CANCELLED and VOID
 * matches refuse those writes (409 INVALID_TRANSITION, reason CONTEST_NOT_PLAYABLE) inside the
 * result transaction, under the match's lifecycle lock; advancement and classification never use
 * a result whose match was not played. Rejecting a pending candidate stays possible (it decides
 * nothing). Results that already exist are never rewritten.
 *
 * "Legacy" results — written before this rule existed — are reproduced with a bare ResultLedger
 * (no competition scope validator: the composition every result route used before the fix still
 * had the validator, so this is the only way to reach that state now).
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
const structure = new StructureStore(db);
const structure2 = new StructureStore(db2);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const advancement = new AdvancementStore(db, scoring);
const outcomes = new EventOutcomeStore(db, scoring);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const ledger2 = createCompetitionResultLedger(db2, { conflictChecker: declaredNoParticipation });
/** Writes the way results could be written before WP-P0-1 (no scope precondition at all). */
const legacy = new ResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const k = () => `k-${newId()}`;

/** Race repetitions (`ONCF_P01_RACE_RUNS=50` for the release evidence run). */
const RUNS = Number(process.env['ONCF_P01_RACE_RUNS'] ?? '2');
/** About 20 s per run (three fresh categories) on the local database, with a wide margin. */
const RACE_TIMEOUT = 300_000 + RUNS * 60_000;

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
          code: `p${tag}`,
          name: 'WP-P0-1 test sport',
          disciplines: [{ code: `p${tag}.tennis`, name: 'tennis', specs: [tennis] }],
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
        code: `s${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.filter(
        (t) => t.code === 'official-confirmed',
      ).map((t) => ({
        code: `a${tag}-${t.code}`,
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
    if (x.discipline.code === `p${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code === `se-${tag}`) ids['se'] = fv.formatVersionId;
    else if (fv.format.code === `rr-${tag}`) ids['rr'] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `r${tag}-sets-bo3-tiebreak`) ids['rs'] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code === `t${tag}_itf_rr`) ids['tp'] = t.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) ids['sp'] = p.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code === `a${tag}-official-confirmed`) ids['ap'] = a.versionId;
  expect(Object.keys(ids).sort()).toEqual(['ap', 'rr', 'rs', 'se', 'sp', 'tennis', 'tp']);
}, 240_000);

// ───────────────────────────── fixtures (as in the ONCF-L6 suite) ─────────────────────────────

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
    slug: uniqueSlug('p01'),
    profile: { name: 'WP-P0-1 Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
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
    label: 'platform (P0-1)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (P0-1)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'] as never,
    scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  // Authority is read as of the transaction time; the local database clock has been measured
  // stepping back by up to ~1.5 s (see the L6 suite). A fixture-time margin, no assertion relaxed.
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > greatest(p.recorded_at, max(g.recorded_at), max(g.effective_from)) + interval '2 seconds' AS ok
      FROM authority.principal p LEFT JOIN authority.authority_grant g ON g.grantee_principal_id = p.id
      WHERE p.id = ${ref.id} GROUP BY p.recorded_at`.execute(owner);
    if (rows[0]?.ok === true) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return ref.id as Uuid;
}

interface Cat {
  eventId: string;
  /** Contests in plan order with their entrants in slot order. */
  contests: { id: string; places: string[] }[];
}

/**
 * A started tennis category: knockout ('se', advancement `official-confirmed` pinned before the
 * lock) or one round-robin group ('rr').
 */
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
    ...(format === 'rr'
      ? { classificationTemplateVersionId: ids['tp'] as string }
      : { advancementPolicyVersionId: ids['ap'] as string }),
    schedulingProfileVersionId: ids['sp'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < entrants; i++) {
    const a = await newAthlete(identity, `p01p${i}`, `Player ${i}`);
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
    const d = new Date(Date.UTC(2027, 7, 1) + day * 86_400_000).toISOString().slice(0, 10);
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

const start = (comp: Comp, contestId: string) =>
  structure.startContest({ actorAccountId: comp.actor, contestId });

/** Scheduled, started and (unless `keepRunning`) completed. */
async function played(comp: Comp, contestIds: readonly string[], keepRunning = false) {
  await publish(comp, contestIds);
  for (const contestId of contestIds) {
    await start(comp, contestId);
    if (!keepRunning) await structure.completeContest({ actorAccountId: comp.actor, contestId });
  }
}

/** Slot 1 wins in straight sets (or slot 2 when `firstWins` is false). */
const sets = (firstWins = true): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: [{ games: firstWins ? [6, 2] : [2, 6] }, { games: firstWins ? [6, 3] : [3, 6] }],
});

const scopeOf = (contestId: string) =>
  resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });

async function draftFor(
  comp: Comp,
  contestId: string,
  sheet: ScoreSheet,
  resultId?: string,
  via: ResultLedger = ledger,
) {
  const v = await scoring.validateScoreSheet({ actorAccountId: comp.actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const rid =
    resultId ??
    (await via.createResult({ scopeType: 'CONTEST', scopeTargetId: contestId as Uuid })).id;
  const { draftId } = await via.saveDraft({
    resultId: rid as Uuid,
    authorPrincipalId: comp.ref,
    disciplineVersionRef: 'oncf-p0-1@1',
    content: v.content,
  });
  return { resultId: rid, draftId };
}

type Step = 'SUBMITTED' | 'PROVISIONAL' | 'OFFICIAL';

/** A result through `via` (the competition ledger, or `legacy`), up to `upTo`. */
async function result(
  comp: Comp,
  contestId: string,
  upTo: Step = 'OFFICIAL',
  firstWins = true,
  via: ResultLedger = ledger,
) {
  const { resultId, draftId } = await draftFor(comp, contestId, sets(firstWins), undefined, via);
  const scope = await scopeOf(contestId);
  const submitKey = k();
  const sub = await via.submitDraft({
    draftId,
    actorPrincipalId: comp.ref,
    scope,
    idempotencyKey: submitKey,
  });
  for (const toStatus of ['PROVISIONAL', 'OFFICIAL'] as const) {
    if (upTo === 'SUBMITTED' || (upTo === 'PROVISIONAL' && toStatus === 'OFFICIAL')) break;
    await via.transition({
      resultVersionId: sub.resultVersionId,
      toStatus,
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: k(),
    });
  }
  return { resultId, versionId: sub.resultVersionId, draftId, submitKey, scope };
}

const contestStatus = async (contestId: string) =>
  (
    await sql<{ status: string }>`
      SELECT status FROM competition.contest_status_change WHERE contest_id = ${contestId} ORDER BY seq`.execute(
      owner,
    )
  ).rows.at(-1)?.status;

/** Every result fact of a contest: versions (with status) and transitions — the "nothing moved" probe. */
const ledgerFacts = async (contestId: string) =>
  (
    await sql<{ versions: number; transitions: number; states: string | null }>`
      SELECT (SELECT count(*)::int FROM results.result_version v JOIN results.result r ON r.id = v.result_id
              WHERE r.scope_target_id = ${contestId}) AS versions,
             (SELECT count(*)::int FROM results.result_status_transition t
              JOIN results.result_version v ON v.id = t.result_version_id JOIN results.result r ON r.id = v.result_id
              WHERE r.scope_target_id = ${contestId}) AS transitions,
             (SELECT string_agg(s.current_status, ',' ORDER BY v.version_number)
              FROM results.result_version v JOIN results.result r ON r.id = v.result_id
              JOIN results.result_version_state s ON s.result_version_id = v.id
              WHERE r.scope_target_id = ${contestId}) AS states`.execute(owner)
  ).rows[0];

const outboxFor = async (contestId: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.outbox_event o
      WHERE o.aggregate_id IN (SELECT r.id FROM results.result r WHERE r.scope_target_id = ${contestId})`.execute(
      owner,
    )
  ).rows[0]?.n ?? 0;

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

/** The D-14 refusal, with the match status it names. */
async function notPlayable(p: Promise<unknown>, contestStatus: string) {
  const err = await refusal(p, DomainErrorCode.INVALID_TRANSITION, 'CONTEST_NOT_PLAYABLE');
  expect(err.details['contestStatus']).toBe(contestStatus);
}

/** Every result write of WP-P0-1 against `contestId`, each refused, nothing recorded. */
async function allWritesRefused(
  comp: Comp,
  contestId: string,
  status: string,
  existing: { submitted?: string; provisional?: string; official?: string; resultId?: string },
) {
  const scope = await scopeOf(contestId);
  // submit (a fresh draft; the Result identity is created idempotently per target, which is not a
  // result write and emits its own creation event — the probe starts after it)
  const d = await draftFor(comp, contestId, sets(), existing.resultId);
  const c =
    existing.official === undefined
      ? undefined
      : await draftFor(comp, contestId, sets(false), d.resultId);
  const before = await ledgerFacts(contestId);
  const beforeOutbox = await outboxFor(contestId);
  await notPlayable(
    ledger.submitDraft({
      draftId: d.draftId as Uuid,
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: k(),
    }),
    status,
  );
  if (existing.submitted !== undefined)
    await notPlayable(
      ledger.transition({
        resultVersionId: existing.submitted as Uuid,
        toStatus: 'PROVISIONAL',
        actorPrincipalId: comp.ref,
        scope,
        idempotencyKey: k(),
      }),
      status,
    );
  if (existing.provisional !== undefined)
    await notPlayable(
      ledger.transition({
        resultVersionId: existing.provisional as Uuid,
        toStatus: 'OFFICIAL',
        actorPrincipalId: comp.ref,
        scope,
        idempotencyKey: k(),
      }),
      status,
    );
  if (existing.official !== undefined && c !== undefined) {
    await notPlayable(
      ledger.correct({
        draftId: c.draftId as Uuid,
        supersedesVersionId: existing.official as Uuid,
        actorPrincipalId: comp.ref,
        scope,
        reason: 'scorer error',
        idempotencyKey: k(),
      }),
      status,
    );
  }
  expect(await ledgerFacts(contestId)).toEqual(before);
  expect(await outboxFor(contestId)).toBe(beforeOutbox);
}

// ───────────────────────────── barrier (H-2 pattern, ordered) ─────────────────────────────

const lockId = (key: string) => sql`hashtextextended(${key}, 0)`;
const waitingOn = async (trx: Transaction<Database>, key: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = ${lockId(key)}`.execute(trx)
  ).rows[0]?.n ?? 0;

/**
 * A third connection holds the advisory lock `key`; `first` is launched and must queue on it, then
 * `second`, then the lock is released — the lock queue grants them in that order, so the race is
 * forced into one serialization. If a writer settles before queueing it did not take the lock, and
 * the wait ends (the assertions then fail instead of hanging).
 */
async function ordered<A, B>(key: string, first: () => Promise<A>, second: () => Promise<B>) {
  let out: Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> | undefined;
  await owner.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${lockId(key)})`.execute(trx);
    let done = false;
    const a = Promise.allSettled([first()]).then(([r]) => {
      done = true;
      return r as PromiseSettledResult<A>;
    });
    for (let i = 0; i < 400 && !done && (await waitingOn(trx, key)) < 1; i++)
      await new Promise((r) => setTimeout(r, 25));
    const b = Promise.allSettled([second()]).then(([r]) => {
      done = true;
      return r as PromiseSettledResult<B>;
    });
    for (let i = 0; i < 400 && !done && (await waitingOn(trx, key)) < 2; i++)
      await new Promise((r) => setTimeout(r, 25));
    out = Promise.all([a, b]);
  });
  return out as Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]>;
}
const reasonOf = (r: PromiseSettledResult<unknown>) =>
  r.status === 'rejected'
    ? ((r.reason as { details?: { reason?: string } }).details?.reason ??
      String((r.reason as Error).message))
    : 'fulfilled';

// ───────────────────────────── refusals ─────────────────────────────

describe('WP-P0-1 · result writes need a played match (D-14)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('1. submit on a PLANNED and on a SCHEDULED match is refused; nothing is recorded', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    expect(await contestStatus(final)).toBe('PLANNED');
    await allWritesRefused(comp, final, 'PLANNED', {});
    await publish(comp, [final]);
    expect(await contestStatus(final)).toBe('SCHEDULED');
    await allWritesRefused(comp, final, 'SCHEDULED', {});
    expect(await ledgerFacts(final)).toMatchObject({ versions: 0, transitions: 0 });
  }, 300_000);

  it('2. accept, declare official and correct on an unstarted match are refused (legacy results untouched)', async () => {
    const cat = await category(comp, 'se', 4);
    const [sf1, sf2] = cat.contests.map((c) => c.id) as [string, string];
    await publish(comp, [sf1, sf2]);
    const submitted = await result(comp, sf1, 'SUBMITTED', true, legacy);
    const provisional = await result(comp, sf2, 'PROVISIONAL', true, legacy);
    const other = await category(comp, 'se', 2);
    const final = other.contests[0]?.id as string;
    await publish(comp, [final]);
    const official = await result(comp, final, 'OFFICIAL', true, legacy);
    await allWritesRefused(comp, sf1, 'SCHEDULED', {
      submitted: submitted.versionId,
      resultId: submitted.resultId,
    });
    await allWritesRefused(comp, sf2, 'SCHEDULED', {
      provisional: provisional.versionId,
      resultId: provisional.resultId,
    });
    await allWritesRefused(comp, final, 'SCHEDULED', {
      official: official.versionId,
      resultId: official.resultId,
    });
    // Rejecting a pending candidate decides nothing and stays possible (clean-up).
    await ledger.transition({
      resultVersionId: submitted.versionId,
      toStatus: 'REJECTED',
      actorPrincipalId: comp.ref,
      scope: submitted.scope,
      idempotencyKey: k(),
    });
    expect((await ledgerFacts(sf1))?.states).toBe('REJECTED');
    // Legacy facts are never rewritten.
    expect((await ledgerFacts(sf2))?.states).toBe('PROVISIONAL');
    expect((await ledgerFacts(final))?.states).toBe('OFFICIAL');
  }, 300_000);

  it('3. a CANCELLED match refuses submit, accept, declare official and correct', async () => {
    const cat = await category(comp, 'se', 4);
    const [sf1, sf2] = cat.contests.map((c) => c.id) as [string, string];
    await publish(comp, [sf1]);
    const submitted = await result(comp, sf1, 'SUBMITTED', true, legacy);
    const provisional = await result(comp, sf2, 'PROVISIONAL', true, legacy);
    for (const id of [sf1, sf2])
      await structure.cancelContest({ actorAccountId: comp.actor, contestId: id, reason: 'rain' });
    const other = await category(comp, 'se', 2);
    const final = other.contests[0]?.id as string;
    const official = await result(comp, final, 'OFFICIAL', true, legacy);
    await structure.cancelContest({ actorAccountId: comp.actor, contestId: final, reason: 'rain' });
    await allWritesRefused(comp, sf1, 'CANCELLED', {
      submitted: submitted.versionId,
      resultId: submitted.resultId,
    });
    await allWritesRefused(comp, sf2, 'CANCELLED', {
      provisional: provisional.versionId,
      resultId: provisional.resultId,
    });
    await allWritesRefused(comp, final, 'CANCELLED', {
      official: official.versionId,
      resultId: official.resultId,
    });
  }, 300_000);

  it('4. a VOID match refuses submit, accept, declare official and correct', async () => {
    const cat = await category(comp, 'se', 4);
    const [sf1, sf2] = cat.contests.map((c) => c.id) as [string, string];
    await played(comp, [sf1]);
    await played(comp, [sf2], true);
    const official = await result(comp, sf1);
    const candidate = await draftFor(comp, sf1, sets(false), official.resultId);
    const submitted = await ledger.submitDraft({
      draftId: candidate.draftId as Uuid,
      actorPrincipalId: comp.ref,
      scope: official.scope,
      idempotencyKey: k(),
    });
    const provisional = await result(comp, sf2, 'PROVISIONAL');
    await structure.voidContest({ actorAccountId: comp.actor, contestId: sf1, reason: 'appeal' });
    await structure.voidContest({ actorAccountId: comp.actor, contestId: sf2, reason: 'appeal' });
    await allWritesRefused(comp, sf1, 'VOID', {
      submitted: submitted.resultVersionId,
      official: official.versionId,
      resultId: official.resultId,
    });
    await allWritesRefused(comp, sf2, 'VOID', {
      provisional: provisional.versionId,
      resultId: provisional.resultId,
    });
  }, 300_000);
});

// ───────────────────────────── what keeps working ─────────────────────────────

describe('WP-P0-1 · played matches keep the whole result workflow', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('5. IN_PROGRESS: submit → accept → declare official; COMPLETED: correct → accept → declare', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await played(comp, [final], true);
    expect(await contestStatus(final)).toBe('IN_PROGRESS');
    const r = await result(comp, final);
    expect((await ledgerFacts(final))?.states).toBe('OFFICIAL');
    await structure.completeContest({ actorAccountId: comp.actor, contestId: final });
    const c = await draftFor(comp, final, sets(false), r.resultId);
    const corrected = await ledger.correct({
      draftId: c.draftId as Uuid,
      supersedesVersionId: r.versionId as Uuid,
      actorPrincipalId: comp.ref,
      scope: r.scope,
      reason: 'scorer error',
      idempotencyKey: k(),
    });
    await ledger.transition({
      resultVersionId: corrected.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: comp.ref,
      scope: r.scope,
      idempotencyKey: k(),
    });
    expect((await ledgerFacts(final))?.states).toBe('SUPERSEDED,OFFICIAL');
    // A competing candidate on a COMPLETED match can still be entered and accepted later.
    const second = await category(comp, 'se', 2);
    const f2 = second.contests[0]?.id as string;
    await played(comp, [f2]);
    expect(await contestStatus(f2)).toBe('COMPLETED');
    await result(comp, f2);
    expect((await ledgerFacts(f2))?.states).toBe('OFFICIAL');
  }, 300_000);

  it('6. an idempotent replay of a success still answers after the match became VOID', async () => {
    const cat = await category(comp, 'se', 2);
    const final = cat.contests[0]?.id as string;
    await played(comp, [final], true);
    const { resultId, draftId } = await draftFor(comp, final, sets());
    const scope = await scopeOf(final);
    const submitKey = k();
    const sub = await ledger.submitDraft({
      draftId: draftId as Uuid,
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: submitKey,
    });
    const acceptKey = k();
    const accepted = await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: acceptKey,
    });
    await structure.voidContest({ actorAccountId: comp.actor, contestId: final, reason: 'appeal' });
    const facts = await ledgerFacts(final);
    const replaySubmit = await ledger.submitDraft({
      draftId: draftId as Uuid,
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: submitKey,
    });
    expect(replaySubmit).toMatchObject({ resultVersionId: sub.resultVersionId, created: false });
    const replayAccept = await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: comp.ref,
      scope,
      idempotencyKey: acceptKey,
    });
    expect(replayAccept).toMatchObject({ ...accepted, created: false, ledgerEntries: [] });
    expect(await ledgerFacts(final)).toEqual(facts);
    // A new command (new key) on the VOID match is refused.
    await allWritesRefused(comp, final, 'VOID', { provisional: sub.resultVersionId, resultId });
  }, 300_000);
});

// ───────────────────────────── advancement and classification ─────────────────────────────

describe('WP-P0-1 · advancement and classification never use an unplayed match', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  const unit = async (eventId: string, contestId: string) => {
    const s = await advancement.state({ actorAccountId: comp.actor, eventId });
    const u = s.units.find((x) => x.unitKey === `contest:${contestId}`);
    if (u === undefined) throw new Error(`no unit for ${contestId}`);
    return u;
  };
  const finalOccupants = async (finalId: string) =>
    (
      await sql<{ p: string | null }>`
        SELECT participant_id AS p FROM competition.v_contest_occupant WHERE contest_id = ${finalId} ORDER BY place`.execute(
        owner,
      )
    ).rows.map((r) => r.p);

  it('7. a legacy OFFICIAL result on an unplayed semifinal does not advance its "winner"', async () => {
    const cat = await category(comp, 'se', 4);
    const [sf1, sf2, final] = cat.contests.map((c) => c.id) as [string, string, string];
    await publish(comp, [sf1, sf2]);
    await result(comp, sf1, 'OFFICIAL', true, legacy);
    const u = await unit(cat.eventId, sf1);
    expect(u.targets.map((t) => [t.proposed.state, t.proposed.reason])).toEqual([
      ['PENDING', 'SOURCE_NOT_PLAYED'],
    ]);
    // Committing the unit places nobody (refused or a no-op, never a placement).
    await advancement
      .commit({
        actorAccountId: comp.actor,
        eventId: cat.eventId,
        units: [{ unitKey: u.unitKey, previewHash: u.previewHash }],
        idempotencyKey: k(),
      })
      .catch(() => undefined);
    expect((await finalOccupants(final)).filter((p) => p !== null)).toEqual([]);
    // Once played and decided officially, the same unit resolves and commits as before.
    await start(comp, sf2);
    const r2 = await result(comp, sf2);
    expect(r2.versionId).toBeDefined();
    const u2 = await unit(cat.eventId, sf2);
    expect(u2.targets[0]?.proposed.state).toBe('RESOLVED');
    await advancement.commit({
      actorAccountId: comp.actor,
      eventId: cat.eventId,
      units: [{ unitKey: u2.unitKey, previewHash: u2.previewHash }],
      idempotencyKey: k(),
    });
    expect((await finalOccupants(final)).filter((p) => p !== null)).toHaveLength(1);
  }, 300_000);

  it('8. classification counts a legacy result on an unplayed round-robin match as pending', async () => {
    const cat = await category(comp, 'rr', 3);
    const [m1, m2] = cat.contests.map((c) => c.id) as [string, string];
    await publish(comp, [m1]);
    await result(comp, m1, 'OFFICIAL', true, legacy);
    await played(comp, [m2]);
    await result(comp, m2);
    const { rows } = await sql<{ key: string; g: string | null }>`
      SELECT st.plan_key AS key, min(r.group_key) AS g FROM competition.stage st
      JOIN competition.round r ON r.stage_id = st.id WHERE st.event_id = ${cat.eventId}
      GROUP BY st.plan_key ORDER BY st.plan_key`.execute(owner);
    const s = rows[0] as { key: string; g: string | null };
    const out = await scoring.classify({
      actorAccountId: comp.actor,
      eventId: cat.eventId,
      stageKey: s.key,
      ...(s.g === null ? {} : { groupKey: s.g }),
    });
    expect(out.pendingContests).toContain(m1);
    expect(out.pendingContests).not.toContain(m2);
  }, 300_000);

  it('11. the public outcome never shows a legacy OFFICIAL result of an unplayed match', async () => {
    const cat = await category(comp, 'se', 4);
    const [sf1, sf2] = cat.contests.map((c) => c.id) as [string, string];
    await publish(comp, [sf1, sf2]);
    await result(comp, sf1, 'OFFICIAL', true, legacy);
    await start(comp, sf2);
    await result(comp, sf2);
    expect(await contestStatus(sf1)).toBe('SCHEDULED');
    const pub = await outcomes.publicEvent(cat.eventId, new Map());
    const shown = pub.matches.find((m) => m.contestId === sf1);
    expect(shown).toMatchObject({ official: false });
    expect(shown?.entrants.every((e) => e.outcome === null && e.score.length === 0)).toBe(true);
    expect(pub.matches.find((m) => m.contestId === sf2)).toMatchObject({ official: true });
    // D-P4: the official result carries its marks for the public score line; nothing else does.
    expect(shown).not.toHaveProperty('scoring');
    const scoring = pub.matches.find((m) => m.contestId === sf2)?.scoring;
    expect(scoring?.family).toBe('SETS_OF_GAMES');
    expect(scoring?.content.entries).toHaveLength(2);
    expect(scoring?.content.performances.some((p) => p.mark.metricId === 'sog.set_games')).toBe(
      true,
    );
    expect(JSON.stringify(scoring)).not.toContain('athleteId');
  }, 300_000);
});

// ───────────────────────────── races ─────────────────────────────

describe(`WP-P0-1 · lifecycle races serialize on the match lock (${RUNS} runs each)`, () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it(
    '9. void, then correction: the correction is refused; correction, then void: both land',
    async () => {
      for (let i = 0; i < RUNS; i++) {
        // void first
        const a = await category(comp, 'se', 2);
        const fa = a.contests[0]?.id as string;
        await played(comp, [fa]);
        const ra = await result(comp, fa);
        const ca = await draftFor(comp, fa, sets(false), ra.resultId);
        const before = await ledgerFacts(fa);
        const [voided, corrected] = await ordered(
          `contest:${fa}`,
          () =>
            structure2.voidContest({ actorAccountId: comp.actor, contestId: fa, reason: 'race' }),
          () =>
            ledger.correct({
              draftId: ca.draftId as Uuid,
              supersedesVersionId: ra.versionId as Uuid,
              actorPrincipalId: comp.ref,
              scope: ra.scope,
              reason: 'race',
              idempotencyKey: k(),
            }),
        );
        expect([reasonOf(voided), reasonOf(corrected)]).toEqual([
          'fulfilled',
          'CONTEST_NOT_PLAYABLE',
        ]);
        expect(await contestStatus(fa)).toBe('VOID');
        expect(await ledgerFacts(fa)).toEqual(before);

        // correction first
        const b = await category(comp, 'se', 2);
        const fb = b.contests[0]?.id as string;
        await played(comp, [fb]);
        const rb = await result(comp, fb);
        const cb = await draftFor(comp, fb, sets(false), rb.resultId);
        const [corrected2, voided2] = await ordered(
          `contest:${fb}`,
          () =>
            ledger2.correct({
              draftId: cb.draftId as Uuid,
              supersedesVersionId: rb.versionId as Uuid,
              actorPrincipalId: comp.ref,
              scope: rb.scope,
              reason: 'race',
              idempotencyKey: k(),
            }),
          () =>
            structure.voidContest({ actorAccountId: comp.actor, contestId: fb, reason: 'race' }),
        );
        expect([reasonOf(corrected2), reasonOf(voided2)]).toEqual(['fulfilled', 'fulfilled']);
        expect(await contestStatus(fb)).toBe('VOID');
        expect((await ledgerFacts(fb))?.states).toBe('SUPERSEDED,PROVISIONAL');
      }
    },
    RACE_TIMEOUT,
  );

  it(
    '10. cancellation, then submission: refused as CANCELLED; submission, then cancellation: refused as SCHEDULED, cancel lands; start, then submission: accepted',
    async () => {
      for (let i = 0; i < RUNS; i++) {
        const a = await category(comp, 'se', 2);
        const fa = a.contests[0]?.id as string;
        await publish(comp, [fa]);
        const da = await draftFor(comp, fa, sets());
        const scopeA = await scopeOf(fa);
        const [cancelled, submitted] = await ordered(
          `contest:${fa}`,
          () =>
            structure2.cancelContest({ actorAccountId: comp.actor, contestId: fa, reason: 'race' }),
          () =>
            ledger.submitDraft({
              draftId: da.draftId as Uuid,
              actorPrincipalId: comp.ref,
              scope: scopeA,
              idempotencyKey: k(),
            }),
        );
        expect([reasonOf(cancelled), reasonOf(submitted)]).toEqual([
          'fulfilled',
          'CONTEST_NOT_PLAYABLE',
        ]);
        expect(
          ((submitted as PromiseRejectedResult).reason as { details: Record<string, unknown> })
            .details['contestStatus'],
        ).toBe('CANCELLED');
        expect(await ledgerFacts(fa)).toMatchObject({ versions: 0, transitions: 0 });

        const b = await category(comp, 'se', 2);
        const fb = b.contests[0]?.id as string;
        await publish(comp, [fb]);
        const db_ = await draftFor(comp, fb, sets());
        const scopeB = await scopeOf(fb);
        const [submitted2, cancelled2] = await ordered(
          `contest:${fb}`,
          () =>
            ledger2.submitDraft({
              draftId: db_.draftId as Uuid,
              actorPrincipalId: comp.ref,
              scope: scopeB,
              idempotencyKey: k(),
            }),
          () =>
            structure.cancelContest({ actorAccountId: comp.actor, contestId: fb, reason: 'race' }),
        );
        expect([reasonOf(submitted2), reasonOf(cancelled2)]).toEqual([
          'CONTEST_NOT_PLAYABLE',
          'fulfilled',
        ]);
        expect(await contestStatus(fb)).toBe('CANCELLED');
        expect(await ledgerFacts(fb)).toMatchObject({ versions: 0, transitions: 0 });

        const c = await category(comp, 'se', 2);
        const fc = c.contests[0]?.id as string;
        await publish(comp, [fc]);
        const dc = await draftFor(comp, fc, sets());
        const scopeC = await scopeOf(fc);
        const [started, submitted3] = await ordered(
          `contest:${fc}`,
          () => structure2.startContest({ actorAccountId: comp.actor, contestId: fc }),
          () =>
            ledger.submitDraft({
              draftId: dc.draftId as Uuid,
              actorPrincipalId: comp.ref,
              scope: scopeC,
              idempotencyKey: k(),
            }),
        );
        expect([reasonOf(started), reasonOf(submitted3)]).toEqual(['fulfilled', 'fulfilled']);
        expect(await ledgerFacts(fc)).toMatchObject({ versions: 1, states: 'SUBMITTED' });
      }
    },
    RACE_TIMEOUT,
  );
});
