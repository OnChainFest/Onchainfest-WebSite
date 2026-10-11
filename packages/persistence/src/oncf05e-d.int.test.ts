import {
  ADVANCEMENT_POLICY_TEMPLATES,
  CANONICAL_CATALOG,
  CONFLICT_ENGINE,
  ENGINE_COVERAGE,
  RULESET_TEMPLATES,
  SCHEDULING_PROFILE_TEMPLATES,
  type DisciplineVersionSpec,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId, type Uuid } from '@br/domain';
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
import { sql } from 'kysely';
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
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';
import { ScheduleStore } from './schedule-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF-05E-D through the real stores: `validate` and `publish` run the conflict / feasibility
 * engine (ADR-0074) over inputs loaded server-side — the only validator in force — and its
 * version-2 report records the competition zone and the 05D place states, so a 05D staleness or a
 * zone change makes a validated report stale. Results are declared OFFICIAL through the
 * ResultLedger and advanced by 05D, exactly as in production.
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
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const advancement = new AdvancementStore(db, scoring);
const structure = new StructureStore(db, { startGuard: (id) => advancement.contestBlockers(id) });
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const resources = new ResourceStore(db);
const schedule = new ScheduleStore(db);
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};
const v2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `x${tag}`,
          name: 'ONCF-05E-D test sport',
          disciplines: [{ code: `x${tag}.tennis`, name: 'tennis', specs: [v2('tennis.singles')] }],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'SE',
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
        code: `p${tag}-${t.code}`,
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
    if (x.discipline.code === `x${tag}.tennis`) ids['tennis'] = x.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `se-${tag}`) ids['se'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids['rs'] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids['sp'] = p.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code.startsWith(`a${tag}-`)) ids['ap'] = a.versionId;
}, 180_000);

/** A four-player tennis knockout with ruleset, advancement policy and scheduling profile pinned. */
async function knockout() {
  const org = await newOrganizer(identity, orgs);
  const actor = org.ownerAccountId;
  const { competitionId } = await comps.createCompetition({
    actorAccountId: actor,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-D Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: actor, competitionId });
  await comps.activateCompetition({ actorAccountId: actor, competitionId });
  const { eventId } = await comps.createEvent({
    actorAccountId: actor,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids['tennis'] as string,
    formatVersionId: ids['se'] as string,
    formatConfig: { drawSize: 4 },
    settings: { name: 'Singles', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: actor, eventId });
  await scoring.pinScoring({
    actorAccountId: actor,
    eventId,
    rulesetVersionId: ids['rs'] as string,
    advancementPolicyVersionId: ids['ap'] as string,
    schedulingProfileVersionId: ids['sp'] as string,
    idempotencyKey: k(),
  });
  for (let i = 0; i < 4; i++) {
    const a = await newAthlete(identity, `p${i}`, `Player ${i}`);
    await comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await comps.closeRegistration({ actorAccountId: actor, eventId });
  await structure.lockField({ actorAccountId: actor, eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: actor,
    eventId,
    idempotencyKey: k(),
    method: 'DETERMINISTIC_DRAW',
  });
  await structure.generatePlan({ actorAccountId: actor, eventId, idempotencyKey: k() });
  const { rows } = await sql<{ id: string; round: number }>`
    SELECT c.id, r.sequence AS round FROM competition.contest c JOIN competition.round r ON r.id = c.round_id
    WHERE c.event_id = ${eventId} ORDER BY r.sequence, c.sequence`.execute(owner);
  const [sf1, sf2, final] = rows.map((r) => r.id) as [string, string, string];
  const court = async (label: string) =>
    (
      await resources.createResource({
        actorAccountId: actor,
        competitionId,
        typeCode: 'TENNIS_COURT',
        resource: { label },
        idempotencyKey: k(),
      })
    ).resourceId;
  return {
    actor,
    competitionId,
    eventId,
    sf1,
    sf2,
    final,
    c1: await court('Court 1'),
    c2: await court('Court 2'),
  };
}

async function referee(competitionId: string) {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (05E-D)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (05E-D)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'] as never,
    scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return ref.id;
}

const sets = (winnerFirst: boolean): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: [{ games: winnerFirst ? [6, 2] : [2, 6] }, { games: winnerFirst ? [6, 3] : [3, 6] }],
});
const scopeOf = (contestId: string) =>
  resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });

async function official(actor: string, ref: Uuid, contestId: string, sheet: ScoreSheet) {
  const v = await scoring.validateScoreSheet({ actorAccountId: actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contestId as Uuid,
  });
  const scope = await scopeOf(contestId);
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: ref,
    disciplineVersionRef: 'oncf05e-d@1',
    content: v.content,
  });
  const sub = await ledger.submitDraft({
    draftId,
    actorPrincipalId: ref,
    scope,
    idempotencyKey: k(),
  });
  for (const toStatus of ['PROVISIONAL', 'OFFICIAL'] as const)
    await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus,
      actorPrincipalId: ref,
      scope,
      idempotencyKey: k(),
    });
  return { resultId: result.id, resultVersionId: sub.resultVersionId };
}

const at = (h: number) => new Date(Date.UTC(2026, 10, 14, h + 6)); // h:00 in Costa Rica (UTC−6)

describe('validate and publish run the 05E-D engine — the only validator in force', () => {
  it('reportVersion 2, engine identity, 19-code coverage, the competition zone; HARD blocks, SOFT is acknowledged', async () => {
    const t = await knockout();
    const { versionId } = await schedule.openDraft({
      actorAccountId: t.actor,
      competitionId: t.competitionId,
      idempotencyKey: k(),
    });
    const put = (contestId: string, resourceId: string, startsAt: Date, reason?: string) =>
      schedule.setAssignment({
        actorAccountId: t.actor,
        versionId,
        contestId,
        assignment: { resourceId, startsAt, ...(reason === undefined ? {} : { reason }) },
        idempotencyKey: k(),
      });
    await put(t.sf1, t.c1, at(9));
    await put(t.sf2, t.c1, at(10)); // overlaps sf1 on court 1 (90-minute slots)
    await put(t.final, t.c2, at(15));

    const v1 = await schedule.validate({ actorAccountId: t.actor, versionId });
    expect(v1.report.reportVersion).toBe(2);
    expect(v1.report.validator).toEqual(CONFLICT_ENGINE);
    expect([...v1.report.coverage].sort()).toEqual([...ENGINE_COVERAGE].sort());
    expect(v1.report.inputs.competitionTimezone).toBe('America/Costa_Rica');
    expect(v1.conflicts.filter((c) => c.code === 'RESOURCE_OVERLAP')).toHaveLength(1);
    // No court hours were declared: undeclared, never silently open.
    expect(v1.conflicts.filter((c) => c.code === 'AVAILABILITY_UNDECLARED')).toHaveLength(3);
    await expect(
      schedule.publish({
        actorAccountId: t.actor,
        versionId,
        baseVersionId: null,
        reportHash: v1.reportHash,
        acknowledgedConflictKeys: v1.conflicts
          .filter((c) => c.severity === 'SOFT')
          .map((c) => c.conflictKey),
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
      details: { reason: 'HARD_CONFLICTS' },
    });

    await put(t.sf2, t.c2, at(9), 'second court');
    const v2r = await schedule.validate({ actorAccountId: t.actor, versionId });
    expect(v2r.hardConflicts).toBe(0);
    expect(new Set(v2r.conflicts.map((c) => c.code))).toEqual(new Set(['AVAILABILITY_UNDECLARED']));
    const soft = v2r.conflicts.map((c) => c.conflictKey);
    await schedule.publish({
      actorAccountId: t.actor,
      versionId,
      baseVersionId: null,
      reportHash: v2r.reportHash,
      acknowledgedConflictKeys: soft,
      idempotencyKey: k(),
    });
    const { rows } = await sql<{
      coverage: string[];
      report: { reportVersion: number; validator: { id: string } };
    }>`
      SELECT coverage, report FROM competition.schedule_publication WHERE version_id = ${versionId}`.execute(
      owner,
    );
    expect(rows[0]?.report.reportVersion).toBe(2);
    expect(rows[0]?.report.validator.id).toBe('br:schedule-conflict-engine');
    expect(rows[0]?.coverage).toHaveLength(19);

    // A competition-zone edit changes the hashed inputs: a validated report becomes stale.
    const { versionId: next } = await schedule.openDraft({
      actorAccountId: t.actor,
      competitionId: t.competitionId,
      idempotencyKey: k(),
    });
    const before = await schedule.validate({ actorAccountId: t.actor, versionId: next });
    await comps.updateCompetitionProfile({
      actorAccountId: t.actor,
      competitionId: t.competitionId,
      profile: { name: 'ONCF-05E-D Fest', timezone: 'America/Mexico_City' },
    });
    const after = await schedule.validate({ actorAccountId: t.actor, versionId: next });
    expect(after.report.inputs.competitionTimezone).toBe('America/Mexico_City');
    expect(after.reportHash).not.toBe(before.reportHash);
    await expect(
      schedule.publish({
        actorAccountId: t.actor,
        versionId: next,
        baseVersionId: versionId,
        reportHash: before.reportHash,
        acknowledgedConflictKeys: before.conflicts.map((c) => c.conflictKey),
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.CONCURRENCY_CONFLICT,
      details: { reason: 'REPORT_STALE' },
    });
  }, 240_000);

  it('05D states reach the report: a corrected semifinal makes the final STALE, the hash stale and STALE_OCCUPANT HARD', async () => {
    const t = await knockout();
    for (const fact of [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      kind: 'WEEKLY' as const,
      weekday,
      start: '00:00',
      end: '24:00',
    })))
      await resources.addAvailability({
        actorAccountId: t.actor,
        competitionId: t.competitionId,
        resourceId: null,
        fact,
        idempotencyKey: k(),
      });
    const { versionId } = await schedule.openDraft({
      actorAccountId: t.actor,
      competitionId: t.competitionId,
      idempotencyKey: k(),
    });
    for (const [contestId, resourceId, h] of [
      [t.sf1, t.c1, 9],
      [t.sf2, t.c2, 9],
      [t.final, t.c1, 15],
    ] as const)
      await schedule.setAssignment({
        actorAccountId: t.actor,
        versionId,
        contestId,
        assignment: { resourceId, startsAt: at(h) },
        idempotencyKey: k(),
      });
    const unresolved = await schedule.validate({ actorAccountId: t.actor, versionId });
    expect(unresolved.conflicts).toEqual([]);

    // Official results and a committed 05D decision: the final's places become RESOLVED.
    const ref = await referee(t.competitionId);
    const r1 = await official(t.actor, ref, t.sf1, sets(true));
    await official(t.actor, ref, t.sf2, sets(true));
    let s = await advancement.state({ actorAccountId: t.actor, eventId: t.eventId });
    const units = s.units.filter((u) => u.unitKey.startsWith('contest:'));
    await advancement.commit({
      actorAccountId: t.actor,
      eventId: t.eventId,
      units: units.map((u) => ({ unitKey: u.unitKey, previewHash: u.previewHash })),
      idempotencyKey: k(),
    });
    const resolved = await schedule.validate({ actorAccountId: t.actor, versionId });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.reportHash).not.toBe(unresolved.reportHash);
    expect(resolved.report.inputs.occupancyDigest).not.toBe(
      unresolved.report.inputs.occupancyDigest,
    );

    // An upstream correction: the committed facts stay, but 05D now judges them STALE on read.
    const v = await scoring.validateScoreSheet({
      actorAccountId: t.actor,
      contestId: t.sf1,
      sheet: sets(false),
    });
    if (!v.ok) throw new Error('sheet');
    const { draftId } = await ledger.saveDraft({
      resultId: r1.resultId as Uuid,
      authorPrincipalId: ref,
      disciplineVersionRef: 'oncf05e-d@1',
      content: v.content,
    });
    await ledger.correct({
      draftId,
      supersedesVersionId: r1.resultVersionId as Uuid,
      actorPrincipalId: ref,
      scope: await scopeOf(t.sf1),
      reason: 'scorer error',
      idempotencyKey: k(),
    });
    s = await advancement.state({ actorAccountId: t.actor, eventId: t.eventId });
    expect(s.units.flatMap((u) => u.targets).some((x) => x.state === 'STALE')).toBe(true);
    // Nothing in the schedule or in v_contest_occupant changed — only the computed state did.
    const stale = await schedule.validate({ actorAccountId: t.actor, versionId });
    expect(stale.reportHash).not.toBe(resolved.reportHash);
    const staleConflicts = stale.conflicts.filter((c) => c.code === 'STALE_OCCUPANT');
    expect(staleConflicts).toHaveLength(1);
    expect(staleConflicts[0]).toMatchObject({ severity: 'HARD', contestIds: [t.final] });
    await expect(
      schedule.publish({
        actorAccountId: t.actor,
        versionId,
        baseVersionId: null,
        reportHash: resolved.reportHash,
        acknowledgedConflictKeys: [],
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.CONCURRENCY_CONFLICT,
      details: { reason: 'REPORT_STALE' },
    });
  }, 240_000);
});
