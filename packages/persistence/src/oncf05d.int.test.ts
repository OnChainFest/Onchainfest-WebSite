import {
  ADVANCEMENT_POLICY_TEMPLATES,
  BASKETBALL_3X3_V2,
  BOWLING_SINGLES_V2,
  CANONICAL_CATALOG,
  GOLF_INDIVIDUAL_V2,
  RULESET_TEMPLATES,
  RUNNING_ROAD_V2,
  SWIMMING_POOL_V2,
  TENNIS_SINGLES_V1,
  type DisciplineVersionSpec,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId, type Uuid } from '@br/domain';
import { CLASSIFICATION_TEMPLATES } from '@br/rankings';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
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
import { rebuildResultProjections, snapshotResultProjections } from './projections';
import { ScoringStore } from './scoring-store';
import { TeamStore } from './team-store';

/**
 * ONCF-05D proof cases A–F through the real stores: results are submitted, accepted and declared
 * OFFICIAL through the ResultLedger (authority-granted referee), classified by classification-engine/2
 * and resolved into dependent slots by the advancement engine under the pinned AdvancementPolicy —
 * previewed, hash-confirmed, committed as append-only facts, and re-judged (STALE) when an upstream
 * correction changes the evidence. Nothing here schedules anything (05E).
 */

const db = apiDb();
const owner = ownerDb();
const operator = operatorDb();
const maintenance = maintenanceDb();
afterAll(async () => {
  await Promise.all([db, owner, operator, maintenance].map((d) => d.destroy()));
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const catalog = new CatalogStore(operator);
const comps = new CompetitionStore(db);
const teams = new TeamStore(db);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
const advancement = new AdvancementStore(db, scoring);
const structure = new StructureStore(db, { startGuard: (id) => advancement.contestBlockers(id) });
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};
const v2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;
const RS = [
  'sets-bo3-tiebreak',
  'padel-bo3-star-point',
  'road-gun-time',
  'swim-hundredths',
  'golf-stroke-gross',
  '3x3-10min-21',
  'bowling-6-games-scratch',
];
const TP = ['fip_groups', 'road_race', 'swim_time', 'golf_stroke', 'fiba_3x3', 'bowling_pinfall'];

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `y${tag}.${code}`,
    name: code,
    specs,
  });
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `y${tag}`,
          name: 'ONCF-05D test sport',
          disciplines: [
            d('tennis', [TENNIS_SINGLES_V1, v2('tennis.singles')]),
            d('padel', [v2('padel.doubles')]),
            d('road', [RUNNING_ROAD_V2]),
            d('pool', [SWIMMING_POOL_V2]),
            d('golf', [GOLF_INDIVIDUAL_V2]),
            d('b3x3', [BASKETBALL_3X3_V2]),
            d('bowling', [BOWLING_SINGLES_V2]),
          ],
        },
      ],
      formats: [
        {
          code: `se-${tag}`,
          name: 'SE',
          versions: [{ engineId: 'single-elimination', engineVersion: 2 }],
        },
        {
          code: `gk-${tag}`,
          name: 'GK',
          versions: [{ engineId: 'groups-knockout', engineVersion: 1 }],
        },
        {
          code: `wave-${tag}`,
          name: 'Waves',
          versions: [{ engineId: 'wave-start', engineVersion: 1 }],
        },
        {
          code: `heats-${tag}`,
          name: 'Heats',
          versions: [{ engineId: 'heats-final', engineVersion: 1 }],
        },
        {
          code: `mr-${tag}`,
          name: 'MR',
          versions: [{ engineId: 'multi-round', engineVersion: 1 }],
        },
        {
          code: `qk-${tag}`,
          name: 'QK',
          versions: [{ engineId: 'qualifying-knockout', engineVersion: 1 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => RS.includes(t.code)).map((t) => ({
        code: `r${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      advancementPolicies: ADVANCEMENT_POLICY_TEMPLATES.map((t) => ({
        code: `a${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
    classificationTemplates: CLASSIFICATION_TEMPLATES.filter((t) => TP.includes(t.code)).map(
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
    if (x.discipline.code.startsWith(`y${tag}.`))
      ids[`${x.discipline.code.split('.')[1]}@${x.version}`] = x.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code.endsWith(`-${tag}`))
      ids[f.format.code.split('-')[0] as string] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code.startsWith(`t${tag}_`)) ids[`tp:${t.code.slice(`t${tag}_`.length)}`] = t.versionId;
  for (const a of listed.advancementPolicyVersions)
    if (a.code.startsWith(`a${tag}-`)) ids[`ap:${a.code.slice(`a${tag}-`.length)}`] = a.versionId;
}, 180_000);

async function eventWith(dv: string, fv: string, formatConfig: Record<string, unknown> = {}) {
  const org = await newOrganizer(identity, orgs);
  const compSlug = uniqueSlug('comp');
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: compSlug,
    profile: { name: 'ONCF-05D Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  await comps.activateCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  const eventSlug = uniqueSlug('ev');
  const { eventId } = await comps.createEvent({
    actorAccountId: org.ownerAccountId,
    competitionId,
    slug: eventSlug,
    disciplineVersionId: ids[dv] as string,
    formatVersionId: ids[fv] as string,
    formatConfig,
    settings: { name: 'Category', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  return { eventId, competitionId, actor: org.ownerAccountId, compSlug, eventSlug };
}
type Ev = Awaited<ReturnType<typeof eventWith>>;

const pin = (ev: Ev, ruleset: string, template: string | undefined, policy: string) =>
  scoring.pinScoring({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    rulesetVersionId: ids[`rs:${ruleset}`] as string,
    ...(template === undefined
      ? {}
      : { classificationTemplateVersionId: ids[`tp:${template}`] as string }),
    advancementPolicyVersionId: ids[`ap:${policy}`] as string,
    idempotencyKey: k(),
  });

async function individuals(ev: Ev, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = await newAthlete(identity, `p${i}`, `Player ${i}`);
    const { registrationId } = await comps.register({
      actorAccountId: a.accountId,
      eventId: ev.eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
    out.push({ ...a, registrationId });
  }
  return out;
}

async function teamsOf(ev: Ev, count: number, size: number, kind: 'EVENT_PAIR' | 'EVENT_SQUAD') {
  for (let t = 0; t < count; t++) {
    const members = [];
    for (let i = 0; i < size; i++) members.push(await newAthlete(identity, `m${i}`, `Member ${i}`));
    const manager = members[0] as (typeof members)[number];
    const { teamId } = await teams.createTeam({
      actorAccountId: manager.accountId,
      teamKind: kind,
      displayName: `Team ${newId().slice(0, 6)}`,
      idempotencyKey: k(),
    });
    for (const m of members) {
      const { membershipId, status } = await teams.addMember({
        actorAccountId: manager.accountId,
        teamId,
        athleteId: m.athleteId,
        idempotencyKey: k(),
      });
      if (status !== 'ACTIVE')
        await teams.respond({ actorAccountId: m.accountId, membershipId, accept: true });
    }
    await comps.register({
      actorAccountId: manager.accountId,
      eventId: ev.eventId,
      teamId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
}

async function lockSeedPlan(ev: Ev) {
  await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
  await structure.lockField({ actorAccountId: ev.actor, eventId: ev.eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
    method: 'DETERMINISTIC_DRAW',
  });
  await structure.generatePlan({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
}

/** A referee holding the four sporting capabilities on this competition (Authority Engine grant). */
async function referee(
  ev: Ev,
  capabilities: string[] = ['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT'],
) {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (05D)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (05D)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: capabilities as never,
    scope: { recognitionLevel: ['PLATFORM'], competition: [ev.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return ref.id;
}

const scopeOf = (contestId: string) =>
  resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });

/** Validates under the pinned ruleset, submits, accepts and (by default) declares OFFICIAL (T5). */
async function score(ev: Ev, ref: Uuid, contestId: string, sheet: ScoreSheet, official = true) {
  const v = await scoring.validateScoreSheet({ actorAccountId: ev.actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contestId as Uuid,
  });
  const scope = await scopeOf(contestId);
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: ref,
    disciplineVersionRef: 'oncf05d@1',
    content: v.content,
  });
  const sub = await ledger.submitDraft({
    draftId,
    actorPrincipalId: ref,
    scope,
    idempotencyKey: k(),
  });
  await ledger.transition({
    resultVersionId: sub.resultVersionId,
    toStatus: 'PROVISIONAL',
    actorPrincipalId: ref,
    scope,
    idempotencyKey: k(),
  });
  if (official)
    await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: ref,
      scope,
      idempotencyKey: k(),
    });
  return { ...sub, resultId: result.id };
}

async function correct(
  ev: Ev,
  ref: Uuid,
  contestId: string,
  resultId: string,
  supersedes: string,
  sheet: ScoreSheet,
) {
  const v = await scoring.validateScoreSheet({ actorAccountId: ev.actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const { draftId } = await ledger.saveDraft({
    resultId: resultId as Uuid,
    authorPrincipalId: ref,
    disciplineVersionRef: 'oncf05d@1',
    content: v.content,
  });
  return ledger.correct({
    draftId,
    supersedesVersionId: supersedes as Uuid,
    actorPrincipalId: ref,
    scope: await scopeOf(contestId),
    reason: 'scorer error',
    idempotencyKey: k(),
  });
}

/** Contests of a stage (and group) with their CURRENT occupants (resolution-aware). */
async function contests(ev: Ev, stageKey: string, groupKey?: string) {
  const { rows } = await sql<{
    id: string;
    plan_key: string;
    round: number;
    places: (string | null)[] | null;
    entries: string[] | null;
  }>`
    SELECT c.id, c.plan_key, r.sequence AS round,
           (SELECT array_agg(o.participant_id ORDER BY o.place) FROM competition.v_contest_occupant o WHERE o.contest_id = c.id) AS places,
           (SELECT array_agg(ce.participant_id ORDER BY ce.start_order) FROM competition.contest_entry ce WHERE ce.contest_id = c.id) AS entries
    FROM competition.contest c JOIN competition.round r ON r.id = c.round_id JOIN competition.stage s ON s.id = r.stage_id
    WHERE c.event_id = ${ev.eventId} AND s.plan_key = ${stageKey} AND (${groupKey ?? null}::text IS NULL OR r.group_key = ${groupKey ?? null})
    ORDER BY r.sequence, c.sequence`.execute(owner);
  return rows.map((r) => ({
    id: r.id,
    planKey: r.plan_key,
    round: r.round,
    places: r.places ?? [],
    entries: r.entries ?? [],
  }));
}

const stateOf = (ev: Ev) => advancement.state({ actorAccountId: ev.actor, eventId: ev.eventId });
type State = Awaited<ReturnType<typeof stateOf>>;
const unit = (s: State, key: string) => {
  const u = s.units.find((x) => x.unitKey === key);
  if (u === undefined)
    throw new Error(`no unit ${key}: ${s.units.map((x) => x.unitKey).join(', ')}`);
  return u;
};
const commit = async (ev: Ev, s: State, ...keys: string[]) =>
  advancement.commit({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    units: keys.map((key) => ({ unitKey: key, previewHash: unit(s, key).previewHash })),
    idempotencyKey: k(),
  });

const sets = (winnerFirst: boolean): ScoreSheet => ({
  family: 'SETS_OF_GAMES',
  sets: [{ games: winnerFirst ? [6, 2] : [2, 6] }, { games: winnerFirst ? [6, 3] : [3, 6] }],
});

// ───────────────────────────── A ─────────────────────────────

describe('proof case A — tennis singles knockout: official result → winner → semifinal / final slot', () => {
  it('direct winner and loser advance only on OFFICIAL results; preview → confirm → facts; re-running changes nothing', async () => {
    const ev = await eventWith('tennis@2', 'se', { drawSize: 4, thirdPlace: true });
    await pin(ev, 'sets-bo3-tiebreak', undefined, 'official-confirmed');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const [sf1, sf2] = await contests(ev, 's1');
    const contestUnit = `contest:${sf1?.id}`;

    // 4 · unresolved source / 5 · missing result
    let s = await stateOf(ev);
    expect(s.advancement).toBe('REQUIRED');
    expect(
      unit(s, contestUnit).targets.map((t) => [t.state, t.proposed.state, t.proposed.reason]),
    ).toEqual([
      ['UNRESOLVED', 'PENDING', 'RESULT_MISSING'],
      ['UNRESOLVED', 'PENDING', 'RESULT_MISSING'],
    ]);
    // 6 · a PROVISIONAL result never advances anyone under an OFFICIAL policy
    const r1 = await score(ev, ref, sf1?.id as string, sets(true), false);
    s = await stateOf(ev);
    expect(unit(s, contestUnit).targets[0]?.proposed.reason).toBe('RESULT_NOT_OFFICIAL');
    await ledger.transition({
      resultVersionId: r1.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: ref,
      scope: await scopeOf(sf1?.id as string),
      idempotencyKey: k(),
    });
    s = await stateOf(ev);
    const u = unit(s, contestUnit);
    const winner = sf1?.places[0] as string;
    const loser = sf1?.places[1] as string;
    expect(u.targets.map((t) => [t.proposed.provenance.family, t.proposed.participantId])).toEqual(
      expect.arrayContaining([
        ['DIRECT_WINNER', winner],
        ['DIRECT_LOSER', loser],
      ]),
    );
    expect(u.targets[0]?.proposed.provenance.result).toMatchObject({
      resultVersionId: r1.resultVersionId,
      status: 'OFFICIAL',
    });
    // CONFIRM: a commit without (or with a different) preview hash is refused; nothing is written.
    await expect(
      advancement.commit({
        actorAccountId: ev.actor,
        eventId: ev.eventId,
        units: [{ unitKey: contestUnit }],
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ details: { reason: 'PREVIEW_REQUIRED' } });
    await expect(
      advancement.commit({
        actorAccountId: ev.actor,
        eventId: ev.eventId,
        units: [{ unitKey: contestUnit, previewHash: `sha256:${'0'.repeat(64)}` }],
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.CONCURRENCY_CONFLICT });
    const c1 = await commit(ev, s, contestUnit);
    expect(c1.decisions).toHaveLength(1);
    s = await stateOf(ev);
    expect(unit(s, contestUnit).targets.map((t) => t.state)).toEqual(['RESOLVED', 'RESOLVED']);
    // 10 · idempotent: re-running against the same official classification writes nothing.
    const again = await commit(ev, s, contestUnit);
    expect(again.decisions).toEqual([]);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM competition.slot_assignment WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(2);
    // The final's slot shows the winner publicly; provenance stays organizer-only.
    const pub = await reader.structure(ev.compSlug, ev.eventSlug);
    const finalSlot = pub
      ?.flatMap((r) => r.contests)
      .flatMap((c) => c.slots)
      .find((x) => x.kind === 'WINNER_OF_CONTEST' && x.contestId === sf1?.id);
    expect(finalSlot).toMatchObject({ resolved: true, participantId: winner });
    expect(JSON.stringify(pub)).not.toContain('resultVersionId');

    // 7 · 8 · correction: the loser actually won. The fact becomes STALE (never silently kept).
    await score(ev, ref, sf2?.id as string, sets(true));
    const fixed = await correct(
      ev,
      ref,
      sf1?.id as string,
      r1.resultId,
      r1.resultVersionId,
      sets(false),
    );
    s = await stateOf(ev);
    expect(unit(s, contestUnit).targets.map((t) => t.state)).toEqual(['STALE', 'STALE']);
    // Under an OFFICIAL policy the corrected (PROVISIONAL) version is not consumed yet.
    expect(unit(s, contestUnit).targets[0]?.proposed.reason).toBe('RESULT_NOT_OFFICIAL');
    const [final] = (await contests(ev, 's1')).filter(
      (c) => c.planKey.endsWith('-c3') || c.planKey.includes('r2'),
    );
    await expect(
      structure.startContest({ actorAccountId: ev.actor, contestId: final?.id as string }),
    ).rejects.toMatchObject({ details: { reason: 'ADVANCEMENT_STALE' } });
    await ledger.transition({
      resultVersionId: fixed.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: ref,
      scope: await scopeOf(sf1?.id as string),
      idempotencyKey: k(),
    });
    s = await stateOf(ev);
    expect(
      unit(s, contestUnit).targets.find((t) => t.proposed.provenance.family === 'DIRECT_WINNER')
        ?.proposed.participantId,
    ).toBe(loser);
    await commit(ev, s, contestUnit, `contest:${sf2?.id}`);
    s = await stateOf(ev);
    expect(unit(s, contestUnit).targets.every((t) => t.state === 'RESOLVED')).toBe(true);
    // History keeps the superseded decision, marked INVALIDATED (a different entrant replaced it).
    const target = unit(s, contestUnit).targets.find(
      (t) => t.proposed.provenance.family === 'DIRECT_WINNER',
    )?.target as { contestId: string; slot: number };
    const h = await advancement.history({ actorAccountId: ev.actor, eventId: ev.eventId, target });
    expect(h.facts.map((f) => [f.status, f.participantId])).toEqual([
      ['CURRENT', loser],
      ['INVALIDATED', winner],
    ]);
    expect(h.facts[0]?.provenance?.result?.resultVersionId).toBe(fixed.resultVersionId);
  }, 300_000);

  it('20 · a cancelled source contest resolves nothing; an override fills the slot explicitly and is reversible', async () => {
    const ev = await eventWith('tennis@2', 'se', { drawSize: 4 });
    await pin(ev, 'sets-bo3-tiebreak', undefined, 'official-confirmed');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const [sf1] = await contests(ev, 's1');
    await structure.cancelContest({
      actorAccountId: ev.actor,
      contestId: sf1?.id as string,
      reason: 'weather',
    });
    let s = await stateOf(ev);
    const u = unit(s, `contest:${sf1?.id}`);
    expect(u.targets[0]?.proposed.reason).toBe('SOURCE_CANCELLED');
    const target = u.targets[0]?.target as { contestId: string; slot: number };
    const chosen = sf1?.places[0] as string;
    await expect(
      advancement.override({
        actorAccountId: ev.actor,
        eventId: ev.eventId,
        target,
        participantId: chosen,
        reason: '',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    await advancement.override({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      target,
      participantId: chosen,
      reason: 'opponent injured before the match',
      idempotencyKey: k(),
    });
    s = await stateOf(ev);
    expect(unit(s, `contest:${sf1?.id}`).targets[0]).toMatchObject({
      state: 'OVERRIDDEN',
      current: { participantId: chosen, decisionKind: 'OVERRIDE' },
    });
    // An entrant cannot occupy two places of one round.
    const other = unit(
      s,
      (s.units.find((x) => x.unitKey !== `contest:${sf1?.id}`) as { unitKey: string }).unitKey,
    ).targets[0]?.target as { contestId: string; slot: number };
    await expect(
      advancement.override({
        actorAccountId: ev.actor,
        eventId: ev.eventId,
        target: other,
        participantId: chosen,
        reason: 'duplicate',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ details: { reason: 'DUPLICATE_ENTRANT' } });
    await advancement.revokeOverride({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      target,
      reason: 'match will be replayed',
      idempotencyKey: k(),
    });
    s = await stateOf(ev);
    expect(unit(s, `contest:${sf1?.id}`).targets[0]?.state).toBe('UNRESOLVED');
    const h = await advancement.history({ actorAccountId: ev.actor, eventId: ev.eventId, target });
    expect(h.facts.map((f) => f.decision.kind)).toEqual(['OVERRIDE_REVOKED', 'OVERRIDE']);
    expect(h.facts[1]?.decision.reason).toBe('opponent injured before the match');
  }, 300_000);

  it('34 · v1 events keep their behaviour: no advancement policy can be pinned, nothing resolves', async () => {
    const ev = await eventWith('tennis@1', 'se');
    await expect(
      pin(ev, 'sets-bo3-tiebreak', undefined, 'official-confirmed'),
    ).rejects.toMatchObject({ details: { reason: 'CAPABILITY_MISMATCH' } });
    const s = await stateOf(ev);
    expect(['NOT_APPLICABLE', 'POLICY_NOT_PINNED']).toContain(s.advancement);
    expect(s.units).toEqual([]);
  }, 120_000);
});

// ───────────────────────────── B ─────────────────────────────

describe('proof case B — padel doubles, groups → knockout: group rank, tie-break, declared crossover', () => {
  /** u > v 6-0 6-0, v > w 6-lost 6-lost, w > u 6-3 3-6 6-3: one win each; `lost` varies the second's games. */
  const cycle = async (ev: Ev, ref: Uuid, groupKey: string, lost = 4) => {
    const g = await contests(ev, 's1', groupKey);
    const [u, v, w] = [...new Set(g.flatMap((c) => c.places as string[]))].sort();
    const wins: Record<string, { winner: string; sets: [number, number][] }> = {
      [[u, v].sort().join()]: {
        winner: u as string,
        sets: [
          [6, 0],
          [6, 0],
        ],
      },
      [[v, w].sort().join()]: {
        winner: v as string,
        sets: [
          [6, lost],
          [6, lost],
        ],
      },
      [[w, u].sort().join()]: {
        winner: w as string,
        sets: [
          [6, 3],
          [3, 6],
          [6, 3],
        ],
      },
    };
    for (const c of g) {
      const m = wins[[...(c.places as string[])].sort().join()] as {
        winner: string;
        sets: [number, number][];
      };
      const flip = c.places[0] !== m.winner;
      await score(ev, ref, c.id, {
        family: 'SETS_OF_GAMES',
        sets: m.sets.map(([x, y]) => ({ games: flip ? [y, x] : [x, y] })),
      });
    }
    return { first: u as string, second: v as string, third: w as string };
  };

  it('2 · 12 · a three-way tie broken by the declared subset rule; A1 v B2 / B1 v A2 exactly as the plan declares', async () => {
    const ev = await eventWith('padel@1', 'gk', { groupCount: 2, qualifiersPerGroup: 2 });
    await pin(ev, 'padel-bo3-star-point', 'fip_groups', 'groups-wins-games');
    await teamsOf(ev, 6, 2, 'EVENT_PAIR');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const g1 = await cycle(ev, ref, 'g1');
    let s = await stateOf(ev);
    expect(unit(s, 'rank:s1:g2').targets[0]?.proposed.reason).toBe('CLASSIFICATION_INCOMPLETE');
    const g2 = await cycle(ev, ref, 'g2');
    s = await stateOf(ev);
    const ranks = [...unit(s, 'rank:s1:g1').targets, ...unit(s, 'rank:s1:g2').targets];
    expect(
      ranks.every(
        (t) => t.proposed.state === 'RESOLVED' && t.proposed.provenance.family === 'GROUP_RANK',
      ),
    ).toBe(true);
    await commit(ev, s, 'rank:s1:g1', 'rank:s1:g2');
    // The plan's crossover (data, not code): each KO slot names group + rank; its occupant follows.
    const { rows } = await sql<{ group_key: string; rank: number; participant_id: string }>`
      SELECT ct.source_group_key AS group_key, ct.source_rank AS rank, o.participant_id
      FROM competition.contestant ct JOIN competition.v_contest_occupant o ON o.contest_id = ct.contest_id AND o.place = ct.slot
      JOIN competition.contest c ON c.id = ct.contest_id
      WHERE c.event_id = ${ev.eventId} AND ct.source_kind = 'RANK_FROM_STAGE' ORDER BY 1, 2`.execute(
      owner,
    );
    expect(rows.map((r) => [r.group_key, r.rank, r.participant_id])).toEqual([
      ['g1', 1, g1.first],
      ['g1', 2, g1.second],
      ['g2', 1, g2.first],
      ['g2', 2, g2.second],
    ]);
    const ko = await contests(ev, 's2');
    expect(ko[0]?.places).toHaveLength(2);
    expect(new Set(ko.slice(0, 2).flatMap((c) => c.places)).size).toBe(4);
    // Provenance names the classification document hash and the position.
    s = await stateOf(ev);
    expect(unit(s, 'rank:s1:g1').targets[0]?.proposed.provenance.classification).toMatchObject({
      groupKey: 'g1',
      position: 1,
    });
  }, 400_000);

  it('15 · best second place across three groups by the declared cross-group order', async () => {
    const ev = await eventWith('padel@1', 'gk', {
      groupCount: 3,
      qualifiersPerGroup: 1,
      bestRankedExtra: 1,
    });
    await pin(ev, 'padel-bo3-star-point', 'fip_groups', 'groups-wins-games');
    await teamsOf(ev, 9, 2, 'EVENT_PAIR');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const seconds: string[] = [];
    // The g2 second loses fewest games (6-1 6-1): best on game difference after equal wins / sets.
    for (const [g, games] of [
      ['g1', 4],
      ['g2', 1],
      ['g3', 3],
    ] as const)
      seconds.push((await cycle(ev, ref, g, games)).second);
    const s = await stateOf(ev);
    const best = s.units.find((x) => x.unitKey.startsWith('best:s1:'));
    expect(best?.targets[0]?.proposed.state).toBe('RESOLVED');
    expect(best?.targets[0]?.proposed.participantId).toBe(seconds[1]);
    expect(best?.targets[0]?.proposed.provenance.family).toBe('BEST_N_ACROSS_GROUPS');
    expect(
      best?.targets[0]?.proposed.provenance.comparison?.map((c) => c.participantId).sort(),
    ).toEqual([...seconds].sort());
  }, 500_000);
});

// ───────────────────────────── C ─────────────────────────────

describe('proof case C — running road race (wave start): one field, nothing advances', () => {
  it('13 · NO_ADVANCEMENT_REQUIRED — no next stage is invented', async () => {
    const ev = await eventWith('road@1', 'wave', { waveCapacity: 50 });
    await pin(ev, 'road-gun-time', 'road_race', 'official-confirmed');
    await individuals(ev, 6);
    await lockSeedPlan(ev);
    const s = await stateOf(ev);
    expect(s.advancement).toBe('NO_ADVANCEMENT_REQUIRED');
    expect(s.units).toEqual([]);
  }, 120_000);
});

// ───────────────────────────── D ─────────────────────────────

describe('proof case D — swimming heats → final', () => {
  const swim = async (ev: Ev, ref: Uuid, timeOf: (id: string) => number) => {
    for (const h of await contests(ev, 's1'))
      await score(ev, ref, h.id, {
        family: 'ELAPSED_TIME',
        entries: (h.places as string[]).map((participantId) => ({
          participantId,
          status: 'FINISHED' as const,
          timeMs: timeOf(participantId),
        })),
      });
  };

  it('16 · logistic heats (OVERALL): the final is the top 8 across all heats; a tie for lane 8 waits for a swim-off override', async () => {
    const ev = await eventWith('pool@1', 'heats', { qualifyByTime: 8 });
    await pin(ev, 'swim-hundredths', 'swim_time', 'heats-overall-time');
    await individuals(ev, 12);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const all = [
      ...new Set((await contests(ev, 's1')).flatMap((c) => c.places as string[])),
    ].sort();
    // Distinct times except a tie between the 8th and 9th fastest.
    const time = (id: string) => {
      const i = all.indexOf(id);
      return 60_000 + (i <= 7 ? i : i - 1) * 100; // the 9th fastest equals the 8th
    };
    await swim(ev, ref, time);
    let s = await stateOf(ev);
    const f = unit(s, 'field:t1');
    expect(f.targets.slice(0, 7).every((t) => t.proposed.state === 'RESOLVED')).toBe(true);
    expect(f.targets[7]?.proposed).toMatchObject({ state: 'HELD', reason: 'TIE_AT_BOUNDARY' });
    expect(f.targets[7]?.proposed.provenance.candidates).toEqual([all[7], all[8]].sort());
    await commit(ev, s, 'field:t1');
    // Lanes 1–7 are filled; lane of place 8 stays unresolved until the swim-off is recorded.
    await advancement.override({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      target: { transitionKey: 't1', ordinal: 8 },
      participantId: all[8] as string,
      reason: 'swim-off won',
      idempotencyKey: k(),
    });
    s = await stateOf(ev);
    expect(unit(s, 'field:t1').targets[7]?.state).toBe('OVERRIDDEN');
    const [final] = await contests(ev, 's2');
    expect(final?.places.filter((p) => p !== null)).toHaveLength(8);
    expect(final?.places).toContain(all[8]);
    expect(final?.places).not.toContain(all[7]);
  }, 400_000);

  it('17 · competitive heats (PLACE_THEN_TIME): every heat winner reaches the final even when slower', async () => {
    const ev = await eventWith('pool@1', 'heats', { qualifyByPlace: 1, qualifyByTime: 3 });
    await pin(ev, 'swim-hundredths', 'swim_time', 'heats-place-then-time');
    await individuals(ev, 12);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const heats = await contests(ev, 's1');
    // Heat 2 is slow overall; its winner is slower than the top 4 of other heats.
    const slow = new Set(heats[1]?.places as string[]);
    const order = [...new Set(heats.flatMap((h) => h.places as string[]))].sort();
    await swim(ev, ref, (id) => 60_000 + order.indexOf(id) * 10 + (slow.has(id) ? 5_000 : 0));
    const s = await stateOf(ev);
    const field = unit(s, 'field:t1').targets.map((t) => t.proposed.participantId);
    const heatWinner = [...slow].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    expect(field).toContain(heatWinner);
    expect(
      unit(s, 'field:t1').targets.find((t) => t.proposed.participantId === heatWinner)?.proposed
        .provenance.heat,
    ).toMatchObject({ contestId: heats[1]?.id, place: 1 });
    // Deterministic: the same evidence gives the same preview hash.
    expect((await stateOf(ev)).units.find((x) => x.unitKey === 'field:t1')?.previewHash).toBe(
      unit(s, 'field:t1').previewHash,
    );
  }, 400_000);
});

// ───────────────────────────── E ─────────────────────────────

describe('proof case E — golf stroke play: cumulative classification, cut with ties, next-round field', () => {
  const holes = (total: number) =>
    Array.from(
      { length: 18 },
      (_, i) => 4 + (i < Math.abs(total - 72) ? Math.sign(total - 72) : 0),
    );

  it('3 · 18 · 19 · ties at the line continue, DNF never does, the field becomes contests; a withdrawal makes it STALE', async () => {
    const ev = await eventWith('golf@1', 'mr', {
      rounds: 3,
      cutAfterRound: 2,
      cutTopN: 2,
      cutIncludesTies: true,
      groupSize: 3,
    });
    await pin(ev, 'golf-stroke-gross', 'golf_stroke', 'field-cut-official');
    await individuals(ev, 5);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const rounds = await contests(ev, 's1');
    const players = [...new Set(rounds.flatMap((c) => c.places as string[]))].sort();
    const card: Record<number, number[]> = { 1: [70, 71, 72, 75, 72], 2: [70, 71, 70, 75, -1] };
    for (const c of rounds) {
      const p = c.places[0] as string;
      const strokes = card[c.round]?.[players.indexOf(p)] as number;
      await score(ev, ref, c.id, {
        family: 'STROKES',
        entries: [
          strokes < 0
            ? { participantId: p, status: 'DNF' }
            : { participantId: p, status: 'FINISHED', holes: holes(strokes) },
        ],
      });
    }
    let s = await stateOf(ev);
    const f = unit(s, 'field:t1');
    expect(f.families).toEqual(['CUT']);
    expect(f.targets[0]?.proposed.participantId).toBe(players[0]);
    // Tied at the line: both continue, in seed order (deterministic, recorded as tied).
    expect(new Set(f.targets.slice(1).map((t) => t.proposed.participantId))).toEqual(
      new Set([players[1], players[2]]),
    );
    const fieldOrder = f.targets.map((t) => t.proposed.participantId);
    expect(f.targets[2]?.proposed.provenance.classification).toMatchObject({
      throughRound: 2,
      position: 2,
      tied: true,
    });
    const withdrawn = fieldOrder[2] as string;
    expect(f.targets.map((t) => t.proposed.participantId)).not.toContain(players[4]); // DNF
    const c = await commit(ev, s, 'field:t1');
    expect(c.materializedContests).toBe(3);
    const r3 = (await contests(ev, 's1')).filter((x) => x.round === 3);
    expect(r3.map((x) => x.places[0])).toEqual(fieldOrder);
    // Withdrawal before round 3: the field place is STALE until re-resolved (VACATE shrinks the field).
    await structure.withdrawParticipant({
      actorAccountId: ev.actor,
      participantId: withdrawn,
      reason: 'injury',
    });
    s = await stateOf(ev);
    expect(unit(s, 'field:t1').targets[2]?.state).toBe('STALE');
    await commit(ev, s, 'field:t1');
    s = await stateOf(ev);
    expect(
      unit(s, 'field:t1').targets.map((t) => [t.state, t.current?.participantId ?? null]),
    ).toEqual([
      ['RESOLVED', fieldOrder[0]],
      ['RESOLVED', fieldOrder[1]],
      ['VACANT', null],
    ]);
    // The vacated round-3 contest is not part of the field (classification is not blocked by it).
    const cls = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      throughRound: 2,
    });
    expect(cls.document.complete).toBe(true);
  }, 400_000);
});

// ───────────────────────────── F ─────────────────────────────

describe('proof case F — basketball 3x3, pools → knockout: team entrants advance', () => {
  it('11 · team participants fill knockout slots by pool rank', async () => {
    const ev = await eventWith('b3x3@1', 'gk', { groupCount: 2, qualifiersPerGroup: 1 });
    await pin(ev, '3x3-10min-21', 'fiba_3x3', 'pools-wins-points');
    await teamsOf(ev, 6, 3, 'EVENT_SQUAD');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    for (const g of ['g1', 'g2'])
      for (const [i, c] of (await contests(ev, 's1', g)).entries())
        await score(ev, ref, c.id, {
          family: 'TIMED_OR_TARGET',
          regulation: i === 2 ? [12, 21] : [21, 10 + i],
          endedBy: 'TARGET',
        });
    const s = await stateOf(ev);
    await commit(ev, s, 'rank:s1:g1', 'rank:s1:g2');
    const [final] = await contests(ev, 's2');
    const { rows } = await sql<{
      team_id: string | null;
    }>`SELECT team_id FROM competition.participant WHERE id = ANY(${final?.places as string[]}::uuid[])`.execute(
      owner,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.team_id !== null)).toBe(true);
  }, 400_000);
});

// ───────────────────────────── multiple source stages ─────────────────────────────

describe('14 · multiple source stages: a stepladder match is fed by a qualifying rank and a match winner', () => {
  it('each slot resolves from its own stage with its own provenance', async () => {
    const ev = await eventWith('bowling@1', 'qk', {
      qualifyingRounds: 1,
      groupSize: 4,
      qualifiers: 3,
      ladder: 'STEPLADDER',
    });
    await pin(ev, 'bowling-6-games-scratch', 'bowling_pinfall', 'official-confirmed');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    for (const [i, c] of (await contests(ev, 's1')).entries())
      await score(ev, ref, c.id, {
        family: 'FRAMES_PINFALL',
        entries: [
          {
            participantId: c.places[0] as string,
            status: 'FINISHED',
            games: Array.from({ length: 6 }, () => 150 + i * 10),
          },
        ],
      });
    const s = await stateOf(ev);
    const ranks = unit(s, 'rank:s1');
    expect(ranks.families).toEqual(['TOP_N']);
    expect(ranks.targets.every((t) => t.proposed.state === 'RESOLVED')).toBe(true);
    // The second stepladder match: one slot from stage s1 (rank), one from stage s2 (winner of match 1).
    const fromS2 = s.units.find((x) => x.kind === 'CONTEST');
    expect(fromS2?.targets[0]?.proposed.reason).toBe('RESULT_MISSING');
    expect(new Set(s.units.flatMap((x) => x.targets.map((t) => t.label.stageKey)))).toEqual(
      new Set(['s2']),
    );
  }, 400_000);
});

// ───────────────────────────── concurrency ─────────────────────────────

describe('36 · concurrency: two organizers commit the same preview at the same time', () => {
  it('exactly one decision is recorded; the other is a conflict or a no-op, never a duplicate', async () => {
    const ev = await eventWith('tennis@2', 'se', { drawSize: 4 });
    await pin(ev, 'sets-bo3-tiebreak', undefined, 'official-confirmed');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const [sf1] = await contests(ev, 's1');
    await score(ev, ref, sf1?.id as string, sets(true));
    const s = await stateOf(ev);
    const outcomes = await Promise.allSettled([
      commit(ev, s, `contest:${sf1?.id}`),
      commit(ev, s, `contest:${sf1?.id}`),
    ]);
    const decided = outcomes.flatMap((o) => (o.status === 'fulfilled' ? o.value.decisions : []));
    expect(decided).toHaveLength(1);
    for (const o of outcomes)
      if (o.status === 'rejected')
        expect(o.reason).toMatchObject({ code: DomainErrorCode.CONCURRENCY_CONFLICT });
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM competition.advancement_decision WHERE event_id = ${ev.eventId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(1);
  }, 300_000);
});

// ───────────────────────────── ledger lifecycle (T5 / T7) ─────────────────────────────

describe('ResultLedger: official declaration (T5) and atomic correction (T7)', () => {
  it('T5 needs DECLARE_OFFICIAL; a correction needs CORRECT_RESULT + ACCEPT_RESULT, names the CURRENT version and changes the content', async () => {
    const ev = await eventWith('tennis@2', 'se', { drawSize: 4 });
    await pin(ev, 'sets-bo3-tiebreak', undefined, 'official-confirmed');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const [sf1, sf2] = await contests(ev, 's1');
    const clerk = await referee(ev, ['SUBMIT_RESULT', 'ACCEPT_RESULT']);
    const v1 = await score(ev, clerk, sf1?.id as string, sets(true), false);
    const scope = await scopeOf(sf1?.id as string);
    await expect(
      ledger.transition({
        resultVersionId: v1.resultVersionId,
        toStatus: 'OFFICIAL',
        actorPrincipalId: clerk,
        scope,
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTHORITY_DENIED });
    await expect(
      correct(ev, clerk, sf1?.id as string, v1.resultId, v1.resultVersionId, sets(false)),
    ).rejects.toMatchObject({ code: DomainErrorCode.AUTHORITY_DENIED });
    const official = await referee(ev);
    await ledger.transition({
      resultVersionId: v1.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: official,
      scope,
      idempotencyKey: k(),
    });
    // Identical content is not a correction.
    await expect(
      correct(ev, official, sf1?.id as string, v1.resultId, v1.resultVersionId, sets(true)),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    const v2 = await correct(
      ev,
      official,
      sf1?.id as string,
      v1.resultId,
      v1.resultVersionId,
      sets(false),
    );
    // A second correction naming the replaced version is stale and refused (optimistic check).
    await expect(
      correct(ev, official, sf1?.id as string, v1.resultId, v1.resultVersionId, {
        family: 'SETS_OF_GAMES',
        sets: [{ games: [6, 4] }, { games: [6, 4] }],
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.CURRENT_VERSION_CONFLICT });
    const { rows } = await sql<{
      id: string;
      status: string;
      supersedes: string | null;
      current: boolean;
    }>`
      SELECT v.id, st.current_status AS status, v.supersedes_version_id AS supersedes, rs.current_version_id = v.id AS current
      FROM results.result_version v JOIN results.result_version_state st ON st.result_version_id = v.id
      JOIN results.result_state rs ON rs.result_id = v.result_id WHERE v.result_id = ${v1.resultId} ORDER BY v.version_number`.execute(
      owner,
    );
    expect(rows.map((r) => [r.status, r.current])).toEqual([
      ['SUPERSEDED', false],
      ['PROVISIONAL', true],
    ]);
    expect(rows[1]?.supersedes).toBe(v1.resultVersionId);
    const { rows: t } = await sql<{ code: string; from: string | null; to: string }>`
      SELECT transition_code AS code, from_status AS from, to_status AS to FROM results.result_status_transition
      WHERE result_version_id = ANY(${[v1.resultVersionId, v2.resultVersionId]}::uuid[]) ORDER BY recorded_at, to_status`.execute(
      owner,
    );
    expect(t.map((x) => x.code).sort()).toEqual(['T2', 'T2', 'T3', 'T3', 'T5', 'T7']);
    // T5 and T7 replay from the ledger to exactly the live projections (BRT-02 class B).
    await ledger.transition({
      resultVersionId: v2.resultVersionId,
      toStatus: 'OFFICIAL',
      actorPrincipalId: official,
      scope,
      idempotencyKey: k(),
    });
    const before = await snapshotResultProjections(db);
    await rebuildResultProjections(maintenance);
    expect(await snapshotResultProjections(db)).toEqual(before);
    // A version never supersedes a version of another result (database fact).
    const other = await score(ev, official, sf2?.id as string, sets(true));
    await expect(
      sql`INSERT INTO results.result_version (id, result_id, version_number, discipline_version_ref, content_schema, content, content_hash,
            submitted_by_principal_id, supersedes_version_id, fact_hash, recorded_at)
          SELECT ${newId()}, ${other.resultId}, 9, 'x@1', v.content_schema, v.content, ${`sha256:${'1'.repeat(64)}`}, v.submitted_by_principal_id,
                 ${v1.resultVersionId}, v.fact_hash, date_trunc('milliseconds', now()) FROM results.result_version v WHERE v.id = ${other.resultVersionId}`.execute(
        owner,
      ),
    ).rejects.toThrow(/same result/);
  }, 300_000);
});
