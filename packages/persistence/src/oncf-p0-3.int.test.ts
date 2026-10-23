import {
  ADVANCEMENT_POLICY_TEMPLATES,
  CANONICAL_CATALOG,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
import {
  apiDb,
  newAthlete,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  uniqueSlug,
} from '@br/testkit';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { ContestResultService } from './contest-results';
import type { Database } from './db';
import { EventOutcomeStore } from './event-outcome-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ResultAuthorityGovernance } from './result-authority';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF WP-P0-3 (D-16): a result authority grant is necessary but not sufficient. When a result
 * command (submit T2, accept T3, declare official T5, correct T7) is authorized, the actor must
 * CURRENTLY hold an OWNER or ADMIN role of the contest's competition — the ADR-0077 §2.3 issuance
 * predicate — read inside the result transaction under shared locks that every staff, membership,
 * organization and account change takes exclusively. A grantee demoted to SCHEDULER or
 * REGISTRATION_MANAGER, or whose organization role is demoted, is refused (403 AUTHORITY_DENIED,
 * NOT_RESULT_STAFF) and nothing is written.
 *
 * Everything runs through the production composition: ContestResultService with the DB-backed
 * participation checker, grants issued by the ADR-0077 governance command, staff and membership
 * changes through their stores. Tests marked "(inherited)" pin controls that held before WP-P0-3.
 */

const db = apiDb();
const owner = ownerDb();
const operator = operatorDb();
afterAll(async () => {
  await Promise.all([db, owner, operator].map((d) => d.destroy()));
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(db);
const structure = new StructureStore(db);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const governance = new ResultAuthorityGovernance(db);
const outcomes = new EventOutcomeStore(db, scoring);
const results = new ContestResultService(db, scoring, { participationIndex: true });
const k = () => `k-${newId()}`;

/** Race repetitions per ordering (`ONCF_P03_RACE_RUNS=50` for the release evidence run). */
const RUNS = Number(process.env['ONCF_P03_RACE_RUNS'] ?? '2');
const RACE_TIMEOUT = 300_000 + RUNS * 60_000;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};
let platformPrincipalId: string;

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
          code: `q${tag}`,
          name: 'WP-P0-3 test sport',
          disciplines: [{ code: `q${tag}.tennis`, name: 'tennis', specs: [tennis] }],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'se',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
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
  });
  expect(report.conflicts).toEqual([]);
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code === `q${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code === `se-${tag}`) ids['se'] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code === `r${tag}-sets-bo3-tiebreak`) ids['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`s${tag}-`)) ids['sp'] = p.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code === `a${tag}-official-confirmed`) ids['ap'] = a.versionId;
  expect(Object.keys(ids).sort()).toEqual(['ap', 'rs', 'se', 'sp', 'tennis']);
  platformPrincipalId = (
    await governance.bootstrapPlatformAnchor({
      governanceDecisionRef: `gov:p03:anchor:${tag}`,
      basisRef: 'basis:p03:charter',
    })
  ).platformPrincipalId;
}, 240_000);

// ───────────────────────────── fixtures ─────────────────────────────

interface Comp {
  competitionId: string;
  organizationId: string;
  /** The organizer organization's OWNER account. */
  actor: string;
  court: string;
}

/** An ACTIVE competition with one open court and declared hours. */
async function competition(org?: Awaited<ReturnType<typeof newOrganizer>>): Promise<Comp> {
  const o = org ?? (await newOrganizer(identity, orgs));
  const actor = o.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: o.organizationId,
    slug: uniqueSlug('p03'),
    profile: { name: 'WP-P0-3 Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
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
  return { competitionId, organizationId: o.organizationId, actor, court: resourceId };
}

/** A started two-player knockout: one final, PLANNED. */
async function final(comp: Comp): Promise<{ eventId: string; contestId: string }> {
  const { eventId } = await comps.createEvent({
    actorAccountId: comp.actor,
    competitionId: comp.competitionId,
    slug: uniqueSlug('cat'),
    disciplineVersionId: ids['tennis'] as string,
    formatVersionId: ids['se'] as string,
    formatConfig: {},
    settings: { name: 'Singles', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: comp.actor, eventId });
  await scoring.pinScoring({
    actorAccountId: comp.actor,
    eventId,
    rulesetVersionId: ids['rs'] as string,
    advancementPolicyVersionId: ids['ap'] as string,
    schedulingProfileVersionId: ids['sp'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < 2; i++) {
    const a = await newAthlete(identity, `p03p${i}`, `Player ${i}`);
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
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM competition.contest WHERE event_id = ${eventId} ORDER BY sequence LIMIT 1`.execute(
    owner,
  );
  return { eventId, contestId: rows[0]?.id as string };
}

let day = 0;
/** Scheduled on its own day and started (IN_PROGRESS: it can take results, D-14). */
async function play(comp: Comp, contestId: string) {
  const { versionId } = await schedule.openDraft({
    actorAccountId: comp.actor,
    competitionId: comp.competitionId,
    idempotencyKey: k(),
  });
  day += 1;
  const d = new Date(Date.UTC(2027, 9, 1) + day * 86_400_000).toISOString().slice(0, 10);
  await schedule.setAssignment({
    actorAccountId: comp.actor,
    versionId,
    contestId,
    assignment: { resourceId: comp.court, startsAt: `${d}T10:00:00Z` },
    expectedLastFactId: null,
    idempotencyKey: k(),
  });
  const r = await schedule.validate({ actorAccountId: comp.actor, versionId });
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
  await structure.startContest({ actorAccountId: comp.actor, contestId });
}

/** A played final of a fresh category. */
async function playedFinal(comp: Comp) {
  const f = await final(comp);
  await play(comp, f.contestId);
  return f;
}

interface Staff {
  accountId: string;
  personId: string;
  /** Explicit competition staff assignments by role. */
  staffIds: Partial<Record<'ADMIN' | 'SCHEDULER' | 'REGISTRATION_MANAGER', string>>;
}

async function assign(comp: Comp, s: Staff, role: 'ADMIN' | 'SCHEDULER' | 'REGISTRATION_MANAGER') {
  const { staffId } = await comps.assignStaff({
    actorAccountId: comp.actor,
    competitionId: comp.competitionId,
    personId: s.personId,
    role,
    idempotencyKey: k(),
  });
  s.staffIds[role] = staffId;
}

/** A person with explicit competition staff roles. */
async function staffer(
  comp: Comp,
  roles: readonly ('ADMIN' | 'SCHEDULER' | 'REGISTRATION_MANAGER')[],
): Promise<Staff> {
  const a = await newTestAccount(identity, { label: 'p03-staff' });
  const s: Staff = { accountId: a.accountId, personId: a.personId as string, staffIds: {} };
  for (const role of roles) await assign(comp, s, role);
  return s;
}

/**
 * Waits until the DATABASE clock is past the grantee's latest eligibility change (staff, membership,
 * organization or account status) by a margin: a grant must postdate the eligibility it relies on
 * (ADR-0079 §2.3), and the local database clock has been measured stepping back by up to ~2.6 s.
 */
async function settleEligibility(comp: Comp, accountId: string) {
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      WITH p AS (SELECT person_id FROM identity.account_person_control
                 WHERE account_id = ${accountId} AND control_kind = 'SELF')
      SELECT now() > coalesce(greatest(
        (SELECT max(c.recorded_at) FROM competition.competition_staff s
           JOIN competition.competition_staff_status_change c ON c.staff_id = s.id
          WHERE s.competition_id = ${comp.competitionId} AND s.person_id IN (SELECT person_id FROM p)),
        (SELECT max(c.recorded_at) FROM organizations.membership m
           JOIN organizations.membership_status_change c ON c.membership_id = m.id
          WHERE m.organization_id = ${comp.organizationId} AND m.person_id IN (SELECT person_id FROM p)),
        (SELECT max(recorded_at) FROM organizations.organization_status_change
          WHERE organization_id = ${comp.organizationId}),
        (SELECT max(recorded_at) FROM identity.account_status_change WHERE account_id = ${accountId})
      ), '-infinity') + interval '2 seconds' AS ok`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The ADR-0077 operator act for `accountId` in `comp`, then a clock margin before first use. */
async function grant(comp: Comp, accountId: string, effectiveTo?: Date) {
  await settleEligibility(comp, accountId);
  // The grantee's principal is created by this act, just before its grant; a backwards step of the
  // local database clock can make the grant look older than its principal (GRANT_INVALID,
  // UNKNOWN_PRINCIPAL). Setup only: retried on exactly that symptom, nothing else is.
  const issue = () =>
    governance.grantCompetitionResultAuthority({
      platformPrincipalId,
      competitionId: comp.competitionId,
      granteeAccountId: accountId,
      governanceDecisionRef: `gov:p03:${newId()}`,
      ...(effectiveTo === undefined ? {} : { effectiveTo }),
    });
  let g: Awaited<ReturnType<typeof issue>> | undefined;
  for (let attempt = 1; g === undefined; attempt++) {
    try {
      g = await issue();
    } catch (err) {
      if (attempt >= 3 || !/UNKNOWN_PRINCIPAL/.test(String((err as Error).message))) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  // Authority is read as of the transaction time; the local database clock has been measured
  // stepping back by up to ~1.7 s. A fixture-time margin before first use, no assertion relaxed.
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > recorded_at + interval '2 seconds' AS ok
      FROM authority.authority_grant WHERE id = ${g.grantId}`.execute(owner);
    if (rows[0]?.ok === true) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return g;
}

/**
 * Revokes through the ADR-0077 command, asserts a grant was actually revoked, and waits until the
 * DATABASE clock is past the revocation (authority is read as of the command's transaction time;
 * the local VM clock has been seen stepping back by ~2.6 s, so a host-side sleep is not enough).
 */
async function revoke(comp: Comp, accountId: string, reason: string) {
  const { revokedGrantIds } = await governance.revokeCompetitionResultAuthority({
    platformPrincipalId,
    competitionId: comp.competitionId,
    granteeAccountId: accountId,
    governanceDecisionRef: `gov:p03:revoke:${newId()}`,
    reason,
  });
  expect(revokedGrantIds.length).toBeGreaterThan(0);
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > max(recorded_at) + interval '4 seconds' AS ok
      FROM authority.authority_grant_status_change WHERE grant_id = ANY(${revokedGrantIds}::uuid[])`.execute(
      owner,
    );
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const end = (comp: Comp, staffId: string | undefined) =>
  comps.endStaff({ actorAccountId: comp.actor, staffId: staffId as string });

const LEVEL = 'PLATFORM';
const sheet = (firstWins = true): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: [{ games: firstWins ? [6, 2] : [2, 6] }, { games: firstWins ? [6, 3] : [3, 6] }],
});
const submit = (accountId: string, contestId: string, key = k(), firstWins = true) =>
  results.submit({
    actorAccountId: accountId,
    contestId,
    sheet: sheet(firstWins),
    recognitionLevel: LEVEL,
    idempotencyKey: key,
  });
const transition = (
  accountId: string,
  resultVersionId: string,
  toStatus: 'PROVISIONAL' | 'OFFICIAL',
  key = k(),
) =>
  results.transition({
    actorAccountId: accountId,
    resultVersionId,
    toStatus,
    recognitionLevel: LEVEL,
    idempotencyKey: key,
  });
const correct = (accountId: string, contestId: string, supersedesVersionId: string, key = k()) =>
  results.correct({
    actorAccountId: accountId,
    contestId,
    sheet: sheet(false),
    supersedesVersionId,
    reason: 'scorer error',
    recognitionLevel: LEVEL,
    idempotencyKey: key,
  });

/** An OFFICIAL result written by `accountId` (who must be able to). */
async function official(accountId: string, contestId: string) {
  const sub = await submit(accountId, contestId);
  await transition(accountId, sub.resultVersionId, 'PROVISIONAL');
  await transition(accountId, sub.resultVersionId, 'OFFICIAL');
  return sub.resultVersionId;
}

/**
 * Every result fact of a contest and its outbox events. `ResultCreated` is left out: a refused
 * first submission still creates the contest's stable Result identity (before WP-P0-3 too) — an
 * identity, never a version, transition or decision.
 */
const facts = async (contestId: string) =>
  (
    await sql<{ versions: number; transitions: number; states: string | null; outbox: number }>`
      SELECT (SELECT count(*)::int FROM results.result_version v JOIN results.result r ON r.id = v.result_id
              WHERE r.scope_target_id = ${contestId}) AS versions,
             (SELECT count(*)::int FROM results.result_status_transition t
              JOIN results.result_version v ON v.id = t.result_version_id JOIN results.result r ON r.id = v.result_id
              WHERE r.scope_target_id = ${contestId}) AS transitions,
             (SELECT string_agg(s.current_status, ',' ORDER BY v.version_number)
              FROM results.result_version v JOIN results.result r ON r.id = v.result_id
              JOIN results.result_version_state s ON s.result_version_id = v.id
              WHERE r.scope_target_id = ${contestId}) AS states,
             (SELECT count(*)::int FROM platform.outbox_event o
              WHERE o.event_type <> 'ResultCreated'
                AND o.aggregate_id IN (SELECT r.id FROM results.result r WHERE r.scope_target_id = ${contestId})) AS outbox`.execute(
      owner,
    )
  ).rows[0];

const advancementDecisions = async (eventId: string) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM competition.advancement_decision WHERE event_id = ${eventId}`.execute(
      owner,
    )
  ).rows[0]?.n ?? 0;

/** The person's ACTIVE explicit staff roles in a competition (the read-back of "current role"). */
const activeRoles = async (comp: Comp, s: Staff) =>
  (
    await sql<{ staff_role: string }>`
      SELECT s.staff_role FROM competition.competition_staff s
      JOIN competition.v_staff_current v ON v.staff_id = s.id
      WHERE s.competition_id = ${comp.competitionId} AND s.person_id = ${s.personId} AND v.status = 'ACTIVE'
      ORDER BY 1`.execute(owner)
  ).rows.map((r) => r.staff_role);

/** The grantee's grant statuses for the competition, as the operator lists them. */
async function grantStatuses(comp: Comp, accountId: string) {
  const { rows } = await sql<{ principal_id: string }>`
    SELECT pp.principal_id FROM identity.person_principal pp
    JOIN identity.account_person_control apc ON apc.person_id = pp.person_id
    WHERE apc.account_id = ${accountId} AND apc.control_kind = 'SELF'`.execute(owner);
  return (await governance.listCompetitionResultAuthority(comp.competitionId))
    .filter((g) => g.granteePrincipalId === rows[0]?.principal_id)
    .map((g) => g.status);
}

async function refusal(p: Promise<unknown>, code: DomainErrorCode | string, reason?: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected a refusal').toBeDefined();
  expect(err).toMatchObject({ code });
  if (reason !== undefined)
    expect((err as { details: { reason?: string } }).details.reason).toBe(reason);
  return err as { code: string; details: Record<string, unknown> };
}
const notResultStaff = (p: Promise<unknown>) =>
  refusal(p, DomainErrorCode.AUTHORITY_DENIED, 'NOT_RESULT_STAFF');
/** Q3 (ADR-0079 §2.3): eligible again, but the grant was issued before the current eligibility. */
const predates = (p: Promise<unknown>) =>
  refusal(p, DomainErrorCode.AUTHORITY_DENIED, 'GRANT_PREDATES_ELIGIBILITY');

/** The ACTIVE membership of `personId` in `organizationId`. */
const activeMembership = async (organizationId: string, personId: string) =>
  (
    await sql<{ id: string }>`
      SELECT m.id FROM organizations.membership m JOIN organizations.v_membership_current v ON v.membership_id = m.id
      WHERE m.organization_id = ${organizationId} AND m.person_id = ${personId} AND v.status = 'ACTIVE'`.execute(
      owner,
    )
  ).rows[0]?.id as string;

/** A fresh account made an ADMIN of the organization (invitation accepted). */
async function orgAdmin(comp: Comp, inviter: string): Promise<Staff> {
  const member = await newTestAccount(identity, { label: 'p03-org-admin' });
  const inv = await orgs.invite({
    actorAccountId: inviter,
    organizationId: comp.organizationId,
    personId: member.personId as string,
    role: 'ADMIN',
    visibility: 'PUBLIC',
    idempotencyKey: k(),
  });
  await orgs.respondToInvitation({
    actorAccountId: member.accountId,
    token: inv.token as string,
    accept: true,
  });
  return { accountId: member.accountId, personId: member.personId as string, staffIds: {} };
}

/** Waits until the DATABASE clock is `seconds` past the grant's recording (see `grant`). */
async function pastGrant(grantId: string, seconds: number) {
  for (;;) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT now() > recorded_at + make_interval(secs => ${seconds}) AS ok
      FROM authority.authority_grant WHERE id = ${grantId}`.execute(owner);
    if (rows[0]?.ok === true) return;
    await new Promise((r) => setTimeout(r, 250));
  }
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
 * A third connection holds the advisory lock `key` exclusively; `first` is launched and must queue
 * on it, then `second`, then the lock is released — the queue grants them in that order (a shared
 * request never overtakes a queued exclusive one), so the race is forced into one serialization.
 * If a command settles before queueing it did not take the lock, and the wait ends (the assertions
 * then fail instead of hanging).
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

// ───────────────────────────── authorization at action time ─────────────────────────────

describe('WP-P0-3 · result authority needs a CURRENT OWNER / ADMIN role (D-16)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('AUTH-01 / AUTH-17 an ADMIN with a scoped grant submits, accepts, declares and corrects; so does the organizer OWNER', async () => {
    const admin = await staffer(comp, ['ADMIN']);
    await grant(comp, admin.accountId);
    const f = await playedFinal(comp);
    const rv = await official(admin.accountId, f.contestId);
    const c = await correct(admin.accountId, f.contestId, rv);
    expect(c.status).toBe('PROVISIONAL');
    await transition(admin.accountId, c.resultVersionId, 'OFFICIAL');
    expect((await facts(f.contestId))?.states).toBe('SUPERSEDED,OFFICIAL');

    // The organization OWNER is competition OWNER through the organization (no staff row).
    await grant(comp, comp.actor);
    const g = await playedFinal(comp);
    await official(comp.actor, g.contestId);
    expect((await facts(g.contestId))?.states).toBe('OFFICIAL');
  }, 300_000);

  it('AUTH-02 an ADMIN demoted to SCHEDULER (or REGISTRATION_MANAGER) cannot use the earlier grant for any command', async () => {
    const f = await playedFinal(comp);
    const g = await playedFinal(comp);
    for (const lower of ['SCHEDULER', 'REGISTRATION_MANAGER'] as const) {
      const s = await staffer(comp, ['ADMIN']);
      await grant(comp, s.accountId);
      // A pending version by s on g (accepted) and an official one on f, while still ADMIN.
      const fv = lower === 'SCHEDULER' ? await official(s.accountId, f.contestId) : undefined;
      const pending =
        lower === 'SCHEDULER'
          ? (await submit(s.accountId, g.contestId)).resultVersionId
          : undefined;
      // Demotion: the ADMIN assignment ends; the lower role keeps staff access (COMP_VIEW_PRIVATE).
      await assign(comp, s, lower);
      await end(comp, s.staffIds.ADMIN);
      expect(await activeRoles(comp, s)).toEqual([lower]);
      expect(await grantStatuses(comp, s.accountId)).toContain('ACTIVE');

      const beforeF = await facts(f.contestId);
      const beforeG = await facts(g.contestId);
      if (fv !== undefined) await notResultStaff(correct(s.accountId, f.contestId, fv));
      if (pending !== undefined) {
        await notResultStaff(transition(s.accountId, pending, 'PROVISIONAL'));
        await notResultStaff(transition(s.accountId, pending, 'OFFICIAL'));
      }
      await notResultStaff(submit(s.accountId, g.contestId, k(), false));
      expect(await facts(f.contestId)).toEqual(beforeF);
      expect(await facts(g.contestId)).toEqual(beforeG);
    }
  }, 600_000);

  it('AUTH-02 (organization) an organization ADMIN demoted to MEMBER, who stays competition SCHEDULER, is refused', async () => {
    const org = await newOrganizer(identity, orgs);
    const c = await competition(org);
    const member = await newTestAccount(identity, { label: 'p03-org-admin' });
    const inv = await orgs.invite({
      actorAccountId: org.ownerAccountId,
      organizationId: org.organizationId,
      personId: member.personId as string,
      role: 'ADMIN',
      visibility: 'PUBLIC',
      idempotencyKey: k(),
    });
    await orgs.respondToInvitation({
      actorAccountId: member.accountId,
      token: inv.token as string,
      accept: true,
    });
    const s: Staff = {
      accountId: member.accountId,
      personId: member.personId as string,
      staffIds: {},
    };
    await assign(c, s, 'SCHEDULER');
    await grant(c, member.accountId); // eligible as organization ADMIN → competition ADMIN
    const f = await playedFinal(c);
    const rv = await official(member.accountId, f.contestId);
    const { rows } = await sql<{ id: string }>`
      SELECT m.id FROM organizations.membership m JOIN organizations.v_membership_current v ON v.membership_id = m.id
      WHERE m.organization_id = ${org.organizationId} AND m.person_id = ${member.personId} AND v.status = 'ACTIVE'`.execute(
      owner,
    );
    await orgs.changeRole({
      actorAccountId: org.ownerAccountId,
      membershipId: rows[0]?.id as string,
      role: 'MEMBER',
      idempotencyKey: k(),
    });
    const before = await facts(f.contestId);
    await notResultStaff(correct(member.accountId, f.contestId, rv));
    expect(await facts(f.contestId)).toEqual(before);
  }, 300_000);

  it('AUTH-03 / AUTH-07 (inherited) a grantee with no staff role left is refused at the staff gate; nothing written', async () => {
    const s = await staffer(comp, ['ADMIN']);
    await grant(comp, s.accountId);
    const f = await playedFinal(comp);
    const rv = await official(s.accountId, f.contestId);
    await end(comp, s.staffIds.ADMIN);
    expect(await activeRoles(comp, s)).toEqual([]);
    const before = await facts(f.contestId);
    const err = await refusal(correct(s.accountId, f.contestId, rv), DomainErrorCode.FORBIDDEN);
    expect(err.code).toBe(DomainErrorCode.FORBIDDEN);
    expect(await facts(f.contestId)).toEqual(before);
  }, 300_000);

  it('AUTH-04 / AUTH-13 a grant or a role in another competition never covers this one', async () => {
    const other = await competition();
    const f = await playedFinal(comp);
    // ADMIN here, but granted only for the other competition (inherited: SCOPE_NOT_COVERED).
    const a = await staffer(comp, ['ADMIN']);
    const ao: Staff = { ...a, staffIds: {} };
    await assign(other, ao, 'ADMIN');
    await grant(other, a.accountId);
    await refusal(
      submit(a.accountId, f.contestId),
      DomainErrorCode.AUTHORITY_DENIED,
      'SCOPE_NOT_COVERED',
    );
    // Granted here while ADMIN here, then demoted here to SCHEDULER: being ADMIN of another
    // competition of the same organizer does not count (D-16, role confusion).
    const b = await staffer(comp, ['ADMIN']);
    await grant(comp, b.accountId);
    const bo: Staff = { ...b, staffIds: {} };
    await assign(other, bo, 'ADMIN');
    await assign(comp, b, 'SCHEDULER');
    await end(comp, b.staffIds.ADMIN);
    const before = await facts(f.contestId);
    await notResultStaff(submit(b.accountId, f.contestId));
    expect(await facts(f.contestId)).toEqual(before);
  }, 300_000);

  it('AUTH-05 / AUTH-06 (inherited) a revoked or expired grant refuses even a current ADMIN', async () => {
    const f = await playedFinal(comp);
    const r = await staffer(comp, ['ADMIN']);
    await grant(comp, r.accountId);
    await revoke(comp, r.accountId, 'left the results team');
    await refusal(
      submit(r.accountId, f.contestId),
      DomainErrorCode.AUTHORITY_DENIED,
      'GRANT_REVOKED',
    );

    const e = await staffer(comp, ['ADMIN']);
    const until = new Date(Date.now() + 6_000);
    await grant(comp, e.accountId, until);
    for (;;) {
      const { rows } = await sql<{ ok: boolean }>`
        SELECT now() > ${until.toISOString()}::timestamptz + interval '2 seconds' AS ok`.execute(
        owner,
      );
      if (rows[0]?.ok === true) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    await refusal(
      submit(e.accountId, f.contestId),
      DomainErrorCode.AUTHORITY_DENIED,
      'GRANT_NOT_VALID_AT_TIME',
    );
    expect((await facts(f.contestId))?.versions).toBe(0);
  }, 300_000);

  it('AUTH-08 unrelated staff changes leave an authorized ADMIN untouched', async () => {
    const admin = await staffer(comp, ['ADMIN']);
    await grant(comp, admin.accountId);
    const bystander = await staffer(comp, ['ADMIN', 'SCHEDULER']);
    await end(comp, bystander.staffIds.ADMIN);
    await assign(comp, bystander, 'REGISTRATION_MANAGER');
    const f = await playedFinal(comp);
    await official(admin.accountId, f.contestId);
    expect((await facts(f.contestId))?.states).toBe('OFFICIAL');
  }, 300_000);

  it('AUTH-14 an idempotent replay after demotion answers the earlier success and writes nothing; a new command is refused', async () => {
    const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
    await grant(comp, s.accountId);
    const f = await playedFinal(comp);
    const sub = await submit(s.accountId, f.contestId);
    const acceptKey = k();
    const accepted = await transition(s.accountId, sub.resultVersionId, 'PROVISIONAL', acceptKey);
    await end(comp, s.staffIds.ADMIN);
    const before = await facts(f.contestId);
    // The same accept, same key: the ledger replays its recorded answer (nothing is decided now).
    expect(await transition(s.accountId, sub.resultVersionId, 'PROVISIONAL', acceptKey)).toEqual(
      accepted,
    );
    // A fresh declaration is a new decision: refused.
    await notResultStaff(transition(s.accountId, sub.resultVersionId, 'OFFICIAL'));
    expect(await facts(f.contestId)).toEqual(before);
  }, 300_000);

  it('AUTH-15 denials change no result, outbox, advancement decision or public outcome', async () => {
    const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
    await grant(comp, s.accountId);
    const f = await playedFinal(comp);
    const rv = await official(s.accountId, f.contestId);
    await end(comp, s.staffIds.ADMIN);
    const before = await facts(f.contestId);
    const decisions = await advancementDecisions(f.eventId);
    const outcome = JSON.stringify(await outcomes.publicEvent(f.eventId, new Map()));
    await notResultStaff(correct(s.accountId, f.contestId, rv));
    expect(await facts(f.contestId)).toEqual(before);
    expect(await advancementDecisions(f.eventId)).toBe(decisions);
    expect(JSON.stringify(await outcomes.publicEvent(f.eventId, new Map()))).toBe(outcome);
  }, 300_000);

  it('AUTH-18 (inherited) another organization’s OWNER, granted for its own competition, can neither act nor learn anything', async () => {
    const theirs = await competition();
    await grant(theirs, theirs.actor);
    const f = await playedFinal(comp);
    const err = await refusal(submit(theirs.actor, f.contestId), DomainErrorCode.FORBIDDEN);
    expect(JSON.stringify(err.details)).not.toMatch(/ADMIN|SCHEDULER|grant|status/i);
    expect((await facts(f.contestId))?.versions).toBe(0);
  }, 300_000);
});

// ───────────────────────────── Q3: re-promotion needs a fresh grant ─────────────────────────────

describe('WP-P0-3 · Q3 re-promotion does not revive an earlier grant (ADR-0079 §2.3)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it('Q3-01..04 / 06 ADMIN acts; demoted is refused; re-promoted is still refused; a fresh grant restores; results unchanged', async () => {
    const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
    const first = await grant(comp, s.accountId);
    const f = await playedFinal(comp);
    const g = await playedFinal(comp);
    // Q3-01: the ADMIN with a valid grant acts.
    const rv = await official(s.accountId, f.contestId);
    const sub = await submit(s.accountId, g.contestId);
    const acceptKey = k();
    const accepted = await transition(s.accountId, sub.resultVersionId, 'PROVISIONAL', acceptKey);
    // Q3-02: demoted to SCHEDULER.
    await end(comp, s.staffIds.ADMIN);
    await notResultStaff(correct(s.accountId, f.contestId, rv));
    // Q3-03: ADMIN again; the earlier grant, still ACTIVE, does not come back.
    await assign(comp, s, 'ADMIN');
    expect(await activeRoles(comp, s)).toEqual(['ADMIN', 'SCHEDULER']);
    expect(await grantStatuses(comp, s.accountId)).toEqual(['ACTIVE']);
    const before = { f: await facts(f.contestId), g: await facts(g.contestId) };
    await predates(correct(s.accountId, f.contestId, rv));
    await predates(transition(s.accountId, sub.resultVersionId, 'OFFICIAL'));
    await predates(submit(s.accountId, g.contestId, k(), false));
    // Q3-06: nothing changed; the official result stands. A replay is not a decision.
    expect({ f: await facts(f.contestId), g: await facts(g.contestId) }).toEqual(before);
    expect(before.f?.states).toBe('OFFICIAL');
    expect(await transition(s.accountId, sub.resultVersionId, 'PROVISIONAL', acceptKey)).toEqual(
      accepted,
    );
    // Q3-04: a fresh operator act issues a NEW grant (the stale one is revoked, never reused) and
    // the intended operations work again.
    const fresh = await grant(comp, s.accountId);
    expect(fresh.created).toBe(true);
    expect(fresh.grantId).not.toBe(first.grantId);
    expect(await grantStatuses(comp, s.accountId)).toEqual(['REVOKED', 'ACTIVE']);
    await transition(s.accountId, sub.resultVersionId, 'OFFICIAL');
    const c = await correct(s.accountId, f.contestId, rv);
    expect(c.status).toBe('PROVISIONAL');
    expect((await facts(f.contestId))?.states).toBe('SUPERSEDED,PROVISIONAL');
    expect((await facts(g.contestId))?.states).toBe('OFFICIAL');
  }, 300_000);

  it('Q3-05 staff removal and re-assignment follow the same rule (no role left in between)', async () => {
    const s = await staffer(comp, ['ADMIN']);
    await grant(comp, s.accountId);
    const f = await playedFinal(comp);
    await end(comp, s.staffIds.ADMIN);
    expect(await activeRoles(comp, s)).toEqual([]);
    // No staff role at all: refused before the gate, by the private-view check (AUTH-03 / AUTH-07).
    await refusal(submit(s.accountId, f.contestId), DomainErrorCode.FORBIDDEN);
    await assign(comp, s, 'ADMIN');
    await predates(submit(s.accountId, f.contestId));
    expect((await facts(f.contestId))?.versions).toBe(0);
    expect((await grant(comp, s.accountId)).created).toBe(true);
    expect((await submit(s.accountId, f.contestId)).status).toBe('SUBMITTED');
  }, 300_000);

  it('Q3-05 (organization) role MEMBER then ADMIN again, and a suspended then reactivated organization, need a fresh grant', async () => {
    const org = await newOrganizer(identity, orgs);
    const c = await competition(org);
    const m = await orgAdmin(c, org.ownerAccountId);
    await grant(c, m.accountId);
    const f = await playedFinal(c);
    const rv = await official(m.accountId, f.contestId);
    for (const role of ['MEMBER', 'ADMIN'] as const)
      await orgs.changeRole({
        actorAccountId: org.ownerAccountId,
        membershipId: await activeMembership(org.organizationId, m.personId),
        role,
        idempotencyKey: k(),
      });
    await predates(correct(m.accountId, f.contestId, rv));
    expect((await grant(c, m.accountId)).created).toBe(true);
    const fixed = await correct(m.accountId, f.contestId, rv);
    await transition(m.accountId, fixed.resultVersionId, 'OFFICIAL');

    // The organizer OWNER, eligible through the organization only, across a suspension.
    await grant(c, c.actor);
    const g = await playedFinal(c);
    await submit(c.actor, g.contestId);
    for (const status of ['SUSPENDED', 'ACTIVE'] as const)
      await orgs.setStatus({
        operatorAccountId: org.ownerAccountId,
        organizationId: org.organizationId,
        status,
        reason: 'WP-P0-3 Q3',
      });
    const before = await facts(g.contestId);
    await predates(submit(c.actor, g.contestId, k(), false));
    expect(await facts(g.contestId)).toEqual(before);
    expect((await grant(c, c.actor)).created).toBe(true);
    expect((await submit(c.actor, g.contestId, k(), false)).status).toBe('SUBMITTED');
  }, 300_000);

  it('Q3-07 continuous eligibility is never interrupted: handoffs between bases and unrelated grants keep working', async () => {
    // An explicit ADMIN who also becomes organization ADMIN, then loses the explicit row: eligible
    // without a gap, so the grant issued under the explicit row still works.
    const s = await staffer(comp, ['ADMIN']);
    await grant(comp, s.accountId);
    const inv = await orgs.invite({
      actorAccountId: comp.actor,
      organizationId: comp.organizationId,
      personId: s.personId,
      role: 'ADMIN',
      visibility: 'PUBLIC',
      idempotencyKey: k(),
    });
    await orgs.respondToInvitation({
      actorAccountId: s.accountId,
      token: inv.token as string,
      accept: true,
    });
    await end(comp, s.staffIds.ADMIN);
    // Organization ADMIN → OWNER in one command: touching intervals, still continuous.
    await orgs.changeRole({
      actorAccountId: comp.actor,
      membershipId: await activeMembership(comp.organizationId, s.personId),
      role: 'OWNER',
      idempotencyKey: k(),
    });
    const f = await playedFinal(comp);
    await official(s.accountId, f.contestId);
    // An unrelated ADMIN is untouched by s's history, and by another person's demotion cycle.
    const other = await staffer(comp, ['ADMIN']);
    await grant(comp, other.accountId);
    const cycled = await staffer(comp, ['ADMIN', 'SCHEDULER']);
    await grant(comp, cycled.accountId);
    await end(comp, cycled.staffIds.ADMIN);
    await assign(comp, cycled, 'ADMIN');
    const g = await playedFinal(comp);
    await official(other.accountId, g.contestId);
    expect((await facts(g.contestId))?.states).toBe('OFFICIAL');
    expect(await grantStatuses(comp, other.accountId)).toEqual(['ACTIVE']);
  }, 300_000);
});

// ───────────────────────────── races ─────────────────────────────

describe('WP-P0-3 · a demotion and a result command serialize on the staff key (D-16)', () => {
  let comp: Comp;
  beforeAll(async () => {
    comp = await competition();
  }, 240_000);

  it(
    `AUTH-09 / AUTH-10 / AUTH-11 demotion ‖ correction, both orders (${RUNS} runs each)`,
    async () => {
      for (let run = 0; run < RUNS; run++) {
        for (const demotionFirst of [true, false]) {
          const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
          await grant(comp, s.accountId);
          const f = await playedFinal(comp);
          const rv = await official(s.accountId, f.contestId);
          const key = `competition-staff:${comp.competitionId}:${s.personId}`;
          const demote = () => end(comp, s.staffIds.ADMIN);
          const fix = () => correct(s.accountId, f.contestId, rv);
          const [a, b] = demotionFirst
            ? await ordered(key, demote, fix)
            : await ordered(key, fix, demote);
          const [dem, cor] = demotionFirst ? [a, b] : [b, a];
          expect(reasonOf(dem), `run ${run} demotionFirst=${demotionFirst}`).toBe('fulfilled');
          const after = await facts(f.contestId);
          if (demotionFirst) {
            // AUTH-09: the correction observes the demotion; the official version stands alone.
            expect(reasonOf(cor), `run ${run}`).toBe('NOT_RESULT_STAFF');
            expect(after?.states).toBe('OFFICIAL');
          } else {
            // AUTH-10: the correction committed first and stands; the next command is refused.
            expect(reasonOf(cor), `run ${run}`).toBe('fulfilled');
            expect(after?.states).toBe('SUPERSEDED,PROVISIONAL');
            const corrected = (cor as PromiseFulfilledResult<{ resultVersionId: string }>).value;
            await notResultStaff(transition(s.accountId, corrected.resultVersionId, 'OFFICIAL'));
          }
        }
      }
    },
    RACE_TIMEOUT,
  );

  it(
    `Q3-08 a demotion → re-promotion cycle ‖ a correction, both orders (${RUNS} runs each)`,
    async () => {
      for (let run = 0; run < RUNS; run++) {
        for (const cycleFirst of [true, false]) {
          const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
          await grant(comp, s.accountId);
          const f = await playedFinal(comp);
          const rv = await official(s.accountId, f.contestId);
          const key = `competition-staff:${comp.competitionId}:${s.personId}`;
          const cycle = async () => {
            await end(comp, s.staffIds.ADMIN);
            await assign(comp, s, 'ADMIN');
          };
          const fix = () => correct(s.accountId, f.contestId, rv);
          const [a, b] = cycleFirst
            ? await ordered(key, cycle, fix)
            : await ordered(key, fix, cycle);
          const [cyc, cor] = cycleFirst ? [a, b] : [b, a];
          expect(reasonOf(cyc), `run ${run} cycleFirst=${cycleFirst}`).toBe('fulfilled');
          expect(await activeRoles(comp, s)).toEqual(['ADMIN', 'SCHEDULER']);
          const after = await facts(f.contestId);
          if (cycleFirst) {
            // Queued behind the demotion, the correction sees either the gap or the re-promotion:
            // refused either way; the official version stands alone.
            expect(['NOT_RESULT_STAFF', 'GRANT_PREDATES_ELIGIBILITY'], `run ${run}`).toContain(
              reasonOf(cor),
            );
            expect(after?.states).toBe('OFFICIAL');
          } else {
            expect(reasonOf(cor), `run ${run}`).toBe('fulfilled');
            expect(after?.states).toBe('SUPERSEDED,PROVISIONAL');
            const corrected = (cor as PromiseFulfilledResult<{ resultVersionId: string }>).value;
            await predates(transition(s.accountId, corrected.resultVersionId, 'OFFICIAL'));
          }
        }
      }
    },
    RACE_TIMEOUT,
  );

  it(
    `Q3-08 a grant issuance ‖ a demotion, both orders, then re-promotion (${RUNS} runs each)`,
    async () => {
      for (let run = 0; run < RUNS; run++) {
        for (const issueFirst of [true, false]) {
          const s = await staffer(comp, ['ADMIN', 'SCHEDULER']);
          await settleEligibility(comp, s.accountId);
          const f = await playedFinal(comp);
          const key = `competition-staff:${comp.competitionId}:${s.personId}`;
          const issue = () =>
            governance.grantCompetitionResultAuthority({
              platformPrincipalId,
              competitionId: comp.competitionId,
              granteeAccountId: s.accountId,
              governanceDecisionRef: `gov:p03:race:${newId()}`,
            });
          const demote = () => end(comp, s.staffIds.ADMIN);
          const [a, b] = issueFirst
            ? await ordered(key, issue, demote)
            : await ordered(key, demote, issue);
          const [iss, dem] = issueFirst ? [a, b] : [b, a];
          expect(reasonOf(dem), `run ${run} issueFirst=${issueFirst}`).toBe('fulfilled');
          if (issueFirst) {
            // The grant committed before the demotion could: it predates the re-promotion.
            expect(reasonOf(iss), `run ${run}`).toBe('fulfilled');
            await pastGrant((iss as PromiseFulfilledResult<{ grantId: string }>).value.grantId, 4);
          } else {
            // Checked before the demotion, issued after it: the issuance re-checks under the staff
            // key and refuses; no grant is written.
            expect(reasonOf(iss), `run ${run}`).toBe('NOT_RESULT_STAFF');
            expect(await grantStatuses(comp, s.accountId)).toEqual([]);
          }
          await assign(comp, s, 'ADMIN');
          const err = await refusal(
            submit(s.accountId, f.contestId),
            DomainErrorCode.AUTHORITY_DENIED,
          );
          expect(err.details.reason, `run ${run}`).toBe(
            issueFirst ? 'GRANT_PREDATES_ELIGIBILITY' : 'NO_GRANT_FOR_CAPABILITY',
          );
          expect((await facts(f.contestId))?.versions).toBe(0);
        }
      }
    },
    RACE_TIMEOUT,
  );

  it(
    `AUTH-12 a revocation and a use are decided as of the command's transaction time (${RUNS} runs)`,
    async () => {
      for (let run = 0; run < RUNS; run++) {
        const s = await staffer(comp, ['ADMIN']);
        await grant(comp, s.accountId);
        const f = await playedFinal(comp);
        // Revocation committed (and the database clock past it) before the command begins: refused.
        await revoke(comp, s.accountId, 'race');
        const before = await facts(f.contestId);
        await refusal(
          submit(s.accountId, f.contestId),
          DomainErrorCode.AUTHORITY_DENIED,
          'GRANT_REVOKED',
        );
        expect(await facts(f.contestId)).toEqual(before);
      }
    },
    RACE_TIMEOUT,
  );
});
