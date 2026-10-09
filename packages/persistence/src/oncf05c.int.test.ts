import {
  BASKETBALL_3X3_V2,
  BASKETBALL_WHEELCHAIR_V2,
  CANONICAL_CATALOG,
  GOLF_INDIVIDUAL_V2,
  PADEL_DOUBLES_V1,
  RULESET_TEMPLATES,
  RUNNING_ROAD_V2,
  SWIMMING_POOL_V2,
  TENNIS_SINGLES_V1,
  type DisciplineVersionSpec,
  type ScoreSheet,
} from '@br/competition';
import { DomainErrorCode, newId, type ResultVersionContent, type Uuid } from '@br/domain';
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
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { ScoringStore } from './scoring-store';
import { TeamStore } from './team-store';

/**
 * ONCF-05C proof cases A–F (+ wheelchair) through the real stores: rulesets and templates
 * provisioned as catalog versions, pinned per event, score sheets validated into canonical content,
 * submitted and accepted through the ResultLedger (authority-checked), and stages classified on read
 * by classification-engine/2. Nothing here resolves a dependent slot (05D).
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
const teams = new TeamStore(db);
const reader = new CompetitionReader(db);
const scoring = new ScoringStore(db);
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
  'wheelchair-basketball-4x10',
];
const TP = ['fip_groups', 'road_race', 'swim_time', 'golf_stroke', 'fiba_3x3', 'fiba_5x5'];

beforeAll(async () => {
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `z${tag}.${code}`,
    name: code,
    specs,
  });
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `z${tag}`,
          name: 'ONCF-05C test sport',
          disciplines: [
            d('tennis', [TENNIS_SINGLES_V1, v2('tennis.singles')]),
            d('padel', [PADEL_DOUBLES_V1, v2('padel.doubles')]),
            d('road', [RUNNING_ROAD_V2]),
            d('pool', [SWIMMING_POOL_V2]),
            d('golf', [GOLF_INDIVIDUAL_V2]),
            d('b3x3', [BASKETBALL_3X3_V2]),
            d('wheelchair', [BASKETBALL_WHEELCHAIR_V2]),
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
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => RS.includes(t.code)).map((t) => ({
        code: `r${tag}-${t.code}`,
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
    if (x.discipline.code.startsWith(`z${tag}.`))
      ids[`${x.discipline.code.split('.')[1]}@${x.version}`] = x.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code.endsWith(`-${tag}`))
      ids[f.format.code.split('-')[0] as string] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code.startsWith(`t${tag}_`)) ids[`tp:${t.code.slice(`t${tag}_`.length)}`] = t.versionId;
  // v1 disciplines provide no ruleset family: none is compatible with them.
  const v1 = listed.disciplineVersions.find(
    (x) => x.discipline.code === `z${tag}.tennis` && x.version === 1,
  );
  expect(v1?.compatibleRulesetVersionIds).toEqual([]);
}, 180_000);

async function eventWith(dv: string, fv: string, formatConfig: Record<string, unknown> = {}) {
  const org = await newOrganizer(identity, orgs);
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05C Fest', timezone: 'America/Costa_Rica' },
    idempotencyKey: k(),
  });
  await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  await comps.activateCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  const { eventId } = await comps.createEvent({
    actorAccountId: org.ownerAccountId,
    competitionId,
    slug: uniqueSlug('ev'),
    disciplineVersionId: ids[dv] as string,
    formatVersionId: ids[fv] as string,
    formatConfig,
    settings: { name: 'Category', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  await comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  return { eventId, competitionId, actor: org.ownerAccountId };
}

type Ev = Awaited<ReturnType<typeof eventWith>>;

const pin = (ev: Ev, ruleset: string, template?: string) =>
  scoring.pinScoring({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    rulesetVersionId: ids[`rs:${ruleset}`] as string,
    ...(template === undefined
      ? {}
      : { classificationTemplateVersionId: ids[`tp:${template}`] as string }),
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

async function lockSeedPlan(
  ev: Ev,
  seeding: Omit<
    Parameters<StructureStore['seedField']>[0],
    'actorAccountId' | 'eventId' | 'idempotencyKey'
  > = { method: 'DETERMINISTIC_DRAW' },
) {
  await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
  await structure.lockField({ actorAccountId: ev.actor, eventId: ev.eventId, idempotencyKey: k() });
  await structure.seedField({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
    ...seeding,
  });
  await structure.generatePlan({
    actorAccountId: ev.actor,
    eventId: ev.eventId,
    idempotencyKey: k(),
  });
}

/** A referee with SUBMIT_RESULT + ACCEPT_RESULT on the competition (the 05D grant model). */
async function referee(ev: Ev) {
  const platform = await authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (05C)',
  });
  await authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fx-${newId()}`,
  });
  const ref = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'referee (05C)',
  });
  await authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: ref.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [ev.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return ref.id;
}

/** Submits content through the ResultLedger and accepts it to PROVISIONAL. */
async function submit(refId: Uuid, contestId: string, content: ResultVersionContent) {
  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contestId as Uuid,
  });
  const scope = await resolver.scopeOf('CONTEST', contestId, { recognitionLevel: 'PLATFORM' });
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: refId,
    disciplineVersionRef: 'oncf05c@1',
    content,
  });
  const sub = await ledger.submitDraft({
    draftId,
    actorPrincipalId: refId,
    scope,
    idempotencyKey: k(),
  });
  await ledger.transition({
    resultVersionId: sub.resultVersionId,
    toStatus: 'PROVISIONAL',
    actorPrincipalId: refId,
    scope,
    idempotencyKey: k(),
  });
  return sub;
}

/** Validates the sheet under the pinned ruleset, then submits the canonical content. */
async function score(ev: Ev, refId: Uuid, contestId: string, sheet: ScoreSheet) {
  const v = await scoring.validateScoreSheet({ actorAccountId: ev.actor, contestId, sheet });
  if (!v.ok) throw new Error(JSON.stringify(v.issues));
  const sub = await submit(refId, contestId, v.content);
  expect(sub.contentHash).toBe(v.contentHash); // the ledger computes exactly the validated hash
  return v;
}

async function contests(ev: Ev, stageKey: string, groupKey?: string) {
  const { rows } = await sql<{
    id: string;
    slots: string[] | null;
    entries: string[] | null;
    round: number;
  }>`
    SELECT c.id, r.sequence AS round,
           (SELECT array_agg(ct.participant_id ORDER BY ct.slot) FROM competition.contestant ct WHERE ct.contest_id = c.id) AS slots,
           (SELECT array_agg(ce.participant_id ORDER BY ce.start_order) FROM competition.contest_entry ce WHERE ce.contest_id = c.id) AS entries
    FROM competition.contest c JOIN competition.round r ON r.id = c.round_id JOIN competition.stage s ON s.id = r.stage_id
    WHERE c.event_id = ${ev.eventId} AND s.plan_key = ${stageKey} AND (${groupKey ?? null}::text IS NULL OR r.group_key = ${groupKey ?? null})
    ORDER BY r.sequence, c.sequence`.execute(owner);
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    slots: r.slots ?? [],
    entries: r.entries ?? [],
  }));
}

describe('proof case A — tennis singles, single elimination: validate a match and determine the winner', () => {
  it('a valid score decides the winner; an impossible score is refused; nothing is written by validation', async () => {
    const ev = await eventWith('tennis@2', 'se', { drawSize: 4 });
    await pin(ev, 'sets-bo3-tiebreak');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const [sf] = await contests(ev, 's1');
    const bad = await scoring.validateScoreSheet({
      actorAccountId: ev.actor,
      contestId: sf?.id as string,
      sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 5] }, { games: [6, 0] }] },
    });
    expect(bad.ok).toBe(false);
    const good = await scoring.validateScoreSheet({
      actorAccountId: ev.actor,
      contestId: sf?.id as string,
      sheet: {
        family: 'SETS_OF_GAMES',
        sets: [{ games: [7, 6], tiebreak: [7, 4] }, { games: [6, 2] }],
      },
    });
    expect(good.ok).toBe(true);
    if (good.ok)
      expect(good.result.entries.find((e) => e.participantId === sf?.slots[0])?.outcome).toBe(
        'WIN',
      );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM results.result WHERE scope_target_id = ${sf?.id}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  }, 120_000);

  it('scoring is capability-checked and frozen at field lock; v1 events cannot be scored', async () => {
    const ev = await eventWith('tennis@2', 'se');
    await expect(pin(ev, 'golf-stroke-gross')).rejects.toMatchObject({
      details: { reason: 'CAPABILITY_MISMATCH' },
    });
    await expect(pin(ev, 'sets-bo3-tiebreak', 'road_race')).rejects.toMatchObject({
      details: { reason: 'CAPABILITY_MISMATCH' },
    });
    await pin(ev, 'sets-bo3-tiebreak');
    await individuals(ev, 2);
    await lockSeedPlan(ev);
    await expect(pin(ev, 'sets-bo3-tiebreak')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
    });
    const v1 = await eventWith('tennis@1', 'se');
    await expect(pin(v1, 'sets-bo3-tiebreak')).rejects.toMatchObject({
      details: { reason: 'CAPABILITY_MISMATCH' },
    });
  }, 120_000);
});

describe('proof case B — padel doubles, groups → knockout: standings with a three-way tie', () => {
  it('validates group matches, classifies the group with the tied-subset rule, and stays pending elsewhere', async () => {
    const ev = await eventWith('padel@2', 'gk', { groupCount: 2, qualifiersPerGroup: 1 });
    await pin(ev, 'padel-bo3-star-point', 'fip_groups');
    await teamsOf(ev, 6, 2, 'EVENT_PAIR');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const g1 = await contests(ev, 's1', 'g1');
    expect(g1).toHaveLength(3);
    // A genuine cycle: u beats v 6-0 6-0, v beats w 6-4 6-4, w beats u 6-3 3-6 6-3 (one win each).
    const [u, v, w] = [...new Set(g1.flatMap((c) => c.slots))].sort();
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
          [6, 4],
          [6, 4],
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
    for (const c of g1) {
      const m = wins[[...c.slots].sort().join()] as { winner: string; sets: [number, number][] };
      const flip = c.slots[0] !== m.winner;
      await score(ev, ref, c.id, {
        family: 'SETS_OF_GAMES',
        sets: m.sets.map(([x, y]) => ({ games: flip ? [y, x] : [x, y] })),
      });
    }
    const out = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      groupKey: 'g1',
    });
    expect(out.document.complete).toBe(true);
    expect(out.document.entries).toHaveLength(3);
    expect(out.document.explanations[0]?.kind).toBe('TIED_SUBSET');
    expect(out.hash).toMatch(/^sha256:/);
    // Re-reading is deterministic.
    expect(
      (
        await scoring.classify({
          actorAccountId: ev.actor,
          eventId: ev.eventId,
          stageKey: 's1',
          groupKey: 'g1',
        })
      ).hash,
    ).toBe(out.hash);
    const g2 = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      groupKey: 'g2',
    });
    expect(g2.document.complete).toBe(false);
    await expect(
      scoring.classify({ actorAccountId: ev.actor, eventId: ev.eventId, stageKey: 's1' }),
    ).rejects.toMatchObject({ details: { reason: 'GROUP_REQUIRED' } });
  }, 240_000);

  it('a stored result that does not re-validate under the ruleset blocks the classification', async () => {
    const ev = await eventWith('padel@2', 'gk', { groupCount: 2, qualifiersPerGroup: 1 });
    await pin(ev, 'padel-bo3-star-point', 'fip_groups');
    await teamsOf(ev, 4, 2, 'EVENT_PAIR');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const [c] = await contests(ev, 's1', 'g1');
    const v = await scoring.validateScoreSheet({
      actorAccountId: ev.actor,
      contestId: c?.id as string,
      sheet: { family: 'SETS_OF_GAMES', sets: [{ games: [6, 0] }, { games: [6, 0] }] },
    });
    if (!v.ok) throw new Error('unexpected');
    const tampered = JSON.parse(JSON.stringify(v.content));
    tampered.entries[0].primaryMark.value = '7';
    await submit(ref, c?.id as string, tampered);
    await expect(
      scoring.classify({
        actorAccountId: ev.actor,
        eventId: ev.eventId,
        stageKey: 's1',
        groupKey: 'g1',
      }),
    ).rejects.toMatchObject({
      details: { reason: 'CONTEST_RESULT_INVALID' },
    });
  }, 240_000);
});

describe('proof case C — running road race, wave start: a large field classified by time', () => {
  it('validates each wave, classifies 120 runners across waves with non-finishers last and age subsets', async () => {
    const ev = await eventWith('road@1', 'wave', { waveCapacity: 50 });
    await pin(ev, 'road-gun-time', 'road_race');
    const runners = await individuals(ev, 120);
    for (const [i, r] of runners.entries())
      await structure.declareEntryAttributes({
        actorAccountId: r.accountId,
        registrationId: r.registrationId,
        attributes: [{ key: 'ageBand', value: i % 2 === 0 ? 'M35' : 'M40' }],
        idempotencyKey: k(),
      });
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const waves = await contests(ev, 's1');
    expect(waves).toHaveLength(3);
    let n = 0;
    for (const w of waves)
      await score(ev, ref, w.id, {
        family: 'ELAPSED_TIME',
        entries: w.entries.map((participantId) => {
          n += 1;
          return n % 40 === 0
            ? { participantId, status: 'DNF' as const }
            : {
                participantId,
                status: 'FINISHED' as const,
                timeMs: 2_400_000 + ((n * 7919) % 900) * 1000 + 17,
              };
        }),
      });
    const out = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
    });
    const e = out.document.entries;
    expect(e).toHaveLength(120);
    expect(e.slice(-3).every((x) => x.status === 'DNF')).toBe(true);
    expect(out.document.subsets?.map((s) => s.value)).toEqual(['M35', 'M40']);
    expect(out.document.complete).toBe(true);
  }, 300_000);
});

describe('proof case D — swimming, heats → final: heats classified by time; the final waits for 05D', () => {
  it('times across heats order the heat stage; the final stays pending (unresolved qualifiers)', async () => {
    const ev = await eventWith('pool@1', 'heats', { qualifyByTime: 8 });
    await pin(ev, 'swim-hundredths', 'swim_time');
    const swimmers = await individuals(ev, 18);
    for (const [i, s] of swimmers.entries())
      await structure.declareEntryAttributes({
        actorAccountId: s.accountId,
        registrationId: s.registrationId,
        attributes: [{ key: 'entryTimeMs', value: `${60_000 + i * 150}` }],
        idempotencyKey: k(),
      });
    await lockSeedPlan(ev, {
      method: 'BY_ENTRY_ATTRIBUTE',
      attributeKey: 'entryTimeMs',
      direction: 'ASC',
    });
    const ref = await referee(ev);
    for (const h of await contests(ev, 's1'))
      await score(ev, ref, h.id, {
        family: 'ELAPSED_TIME',
        entries: h.slots.map((participantId, i) => ({
          participantId,
          status: 'FINISHED' as const,
          timeMs: 59_000 + i * 333 + h.round,
        })),
      });
    const heats = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
    });
    expect(heats.document.entries).toHaveLength(18);
    expect(heats.document.complete).toBe(true);
    const final = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's2',
    });
    expect(final.document.complete).toBe(false);
    expect(final.pendingContests).toHaveLength(1);
  }, 300_000);
});

describe('proof case E — golf stroke play, multi-round + cut: cumulative classification and count-back', () => {
  it('aggregates rounds 1–2 (what the cut reads) and breaks a tie by count-back', async () => {
    const ev = await eventWith('golf@1', 'mr', {
      rounds: 4,
      cutAfterRound: 2,
      cutTopN: 2,
      groupSize: 3,
    });
    await pin(ev, 'golf-stroke-gross', 'golf_stroke');
    await individuals(ev, 4);
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const rounds = await contests(ev, 's1');
    const players = [...new Set(rounds.flatMap((c) => c.slots))].sort();
    const strokesFor = (p: string, round: number) => (h: number) => {
      const i = players.indexOf(p);
      if (i === 0) return round === 2 && h >= 9 ? 3 : round === 2 ? 5 : 4; // 72 + 72, back nine better
      if (i === 1) return 4; // 72 + 72
      return 5;
    };
    for (const c of rounds) {
      const p = c.slots[0] as string;
      await score(ev, ref, c.id, {
        family: 'STROKES',
        entries: [
          {
            participantId: p,
            status: 'FINISHED',
            holes: Array.from({ length: 18 }, (_, h) => strokesFor(p, c.round)(h)),
          },
        ],
      });
    }
    const out = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      throughRound: 2,
    });
    expect(out.document.entries.slice(0, 2).map((x) => x.participantId)).toEqual([
      players[0],
      players[1],
    ]);
    expect(out.document.entries[0]?.decidedBy?.kind).toBe('COUNT_BACK');
    expect(out.document.complete).toBe(true);
  }, 300_000);
});

describe('proof case F — basketball 3x3, pools → knockout: team scores and win/loss + score criteria', () => {
  it('validates team scores and classifies the pool', async () => {
    const ev = await eventWith('b3x3@1', 'gk', { groupCount: 2, qualifiersPerGroup: 1 });
    await pin(ev, '3x3-10min-21', 'fiba_3x3');
    await teamsOf(ev, 6, 3, 'EVENT_SQUAD');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const g1 = await contests(ev, 's1', 'g1');
    const scores: [number, number][] = [
      [21, 12],
      [21, 19],
      [16, 21],
    ];
    for (const [i, c] of g1.entries()) {
      const [a, b] = scores[i] as [number, number];
      await score(ev, ref, c.id, {
        family: 'TIMED_OR_TARGET',
        regulation: [a, b],
        endedBy: 'TARGET',
      });
    }
    const out = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      groupKey: 'g1',
    });
    expect(out.document.entries).toHaveLength(3);
    expect(out.document.complete).toBe(true);
    expect(out.document.entries.every((e) => e.values.some((v) => v.key === 'wins'))).toBe(true);
    await expect(
      scoring.validateScoreSheet({
        actorAccountId: ev.actor,
        contestId: g1[0]?.id as string,
        sheet: { family: 'TIMED_OR_TARGET', regulation: [-1, 3], endedBy: 'TIME' },
      }),
    ).resolves.toMatchObject({ ok: false });
  }, 300_000);

  it('wheelchair basketball: the same TIMED_PERIODS family and FIBA template — capability data, no sport branch', async () => {
    const ev = await eventWith('wheelchair@1', 'gk', { groupCount: 2, qualifiersPerGroup: 1 });
    await pin(ev, 'wheelchair-basketball-4x10', 'fiba_5x5');
    await teamsOf(ev, 4, 5, 'EVENT_SQUAD');
    await lockSeedPlan(ev);
    const ref = await referee(ev);
    const [c] = await contests(ev, 's1', 'g1');
    await score(ev, ref, c?.id as string, {
      family: 'TIMED_PERIODS',
      periods: [
        [10, 8],
        [12, 9],
        [8, 14],
        [11, 9],
      ],
    });
    const out = await scoring.classify({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      stageKey: 's1',
      groupKey: 'g1',
    });
    expect(
      out.document.entries.map((e) => e.values.find((v) => v.key === 'points')?.value).sort(),
    ).toEqual(['1', '2']);
  }, 300_000);
});
