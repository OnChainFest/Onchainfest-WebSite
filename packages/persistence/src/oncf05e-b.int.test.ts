import {
  BASKETBALL_3X3_V2,
  BASKETBALL_5X5_V2,
  BASKETBALL_WHEELCHAIR_V2,
  BOWLING_SINGLES_V2,
  CANONICAL_CATALOG,
  CYCLING_ITT_V2,
  CYCLING_ROAD_V2,
  GOLF_INDIVIDUAL_V2,
  RULESET_TEMPLATES,
  RUNNING_ROAD_V2,
  SCHEDULING_PROFILE_TEMPLATES,
  schedulingProfileSpecHash,
  SWIMMING_POOL_V2,
  TENNIS_SINGLES_V1,
  type DisciplineVersionSpec,
  type SchedulingProfileSpec,
} from '@br/competition';
import { DomainErrorCode, newId } from '@br/domain';
import { apiDb, newOrganizer, newTestAccount, operatorDb, ownerDb, uniqueSlug } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { CompetitionReader } from './competition-reader';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ScoringStore } from './scoring-store';

/**
 * ONCF-05E-B through the real stores: SchedulingProfile as a versioned catalog axis — operator
 * provisioning, canonical storage and hashing, DRAFT → PUBLISHED → RETIRED, database immutability —
 * and the event pin (by id, PUBLISHED only, capability-checked, COMP_EDIT, frozen at field lock,
 * enforced again by the database). Nine proof categories pin one generic profile type. Nothing here
 * schedules, assigns a resource or detects a conflict.
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
const k = () => `k-${newId()}`;

const tag = newId().replace(/-/g, '').slice(-8);
const ids: Record<string, string> = {};
let op = '';
const v2 = (code: string) =>
  CANONICAL_CATALOG.sports.flatMap((s) => s.disciplines).find((d) => d.code === code)
    ?.specs[1] as DisciplineVersionSpec;
const RS = [
  'sets-bo3-tiebreak',
  'padel-bo3-star-point',
  'road-gun-time',
  'swim-hundredths',
  'cycling-road-same-time',
  'cycling-itt',
  'bowling-6-games-scratch',
  'basketball-4x10',
  'wheelchair-basketball-4x10',
  '3x3-10min-21',
  'golf-stroke-gross',
];
const template = (code: string) => {
  const t = SCHEDULING_PROFILE_TEMPLATES.find((x) => x.code === code);
  if (t === undefined) throw new Error(code);
  return t;
};

beforeAll(async () => {
  op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const d = (code: string, specs: DisciplineVersionSpec[]) => ({
    code: `z${tag}.${code}`,
    name: code,
    specs,
  });
  const f = (code: string, engineId: string, engineVersion = 1) => ({
    code: `${code}-${tag}`,
    name: code,
    versions: [{ engineId, engineVersion }],
  });
  const report = await catalog.provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `z${tag}`,
          name: 'ONCF-05E-B test sport',
          disciplines: [
            d('tennis', [TENNIS_SINGLES_V1, v2('tennis.singles')]),
            d('padel', [v2('padel.doubles')]),
            d('road', [RUNNING_ROAD_V2]),
            d('pool', [SWIMMING_POOL_V2]),
            d('cyclingroad', [CYCLING_ROAD_V2]),
            d('itt', [CYCLING_ITT_V2]),
            d('bowling', [BOWLING_SINGLES_V2]),
            d('b5x5', [BASKETBALL_5X5_V2]),
            d('wheelchair', [BASKETBALL_WHEELCHAIR_V2]),
            d('b3x3', [BASKETBALL_3X3_V2]),
            d('golf', [GOLF_INDIVIDUAL_V2]),
          ],
        },
      ],
      formats: [
        f('se', 'single-elimination', 2),
        f('sev1', 'single-elimination', 1),
        f('gk', 'groups-knockout'),
        f('wave', 'wave-start'),
        f('heats', 'heats-final'),
        f('mr', 'multi-round'),
        f('interval', 'interval-start'),
        f('qk', 'qualifying-knockout'),
      ],
      rulesets: RULESET_TEMPLATES.filter((t) => RS.includes(t.code)).map((t) => ({
        code: `r${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
  });
  expect(report.conflicts).toEqual([]);
  expect(
    report.steps.filter((s) => s.kind === 'scheduling-profile-version').map((s) => s.action),
  ).toEqual(SCHEDULING_PROFILE_TEMPLATES.map(() => 'CREATED'));
  const listed = await reader.catalog();
  for (const x of listed.disciplineVersions)
    if (x.discipline.code.startsWith(`z${tag}.`))
      ids[`${x.discipline.code.split('.')[1]}@${x.version}`] = x.disciplineVersionId;
  for (const fv of listed.formatVersions)
    if (fv.format.code.endsWith(`-${tag}`))
      ids[fv.format.code.split('-')[0] as string] = fv.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`r${tag}-`)) ids[`rs:${r.code.slice(`r${tag}-`.length)}`] = r.versionId;
  for (const p of listed.schedulingProfileVersions)
    if (p.code.startsWith(`p${tag}-`)) ids[`sp:${p.code.slice(`p${tag}-`.length)}`] = p.versionId;
}, 240_000);

async function eventWith(dv: string, fv: string, open = true) {
  const org = await newOrganizer(identity, orgs);
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-B Fest', timezone: 'America/Costa_Rica' },
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
    formatConfig: {},
    settings: { name: 'Category', capacity: null, registrationMode: 'AUTO_CONFIRM' },
    idempotencyKey: k(),
  });
  if (open) await comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  return { eventId, competitionId, actor: org.ownerAccountId };
}
type Ev = Awaited<ReturnType<typeof eventWith>>;

const pin = (ev: Ev, ruleset: string, profile: string | null, actorAccountId: string = ev.actor) =>
  scoring.pinScoring({
    actorAccountId,
    eventId: ev.eventId,
    rulesetVersionId: ids[`rs:${ruleset}`] as string,
    ...(profile === null ? {} : { schedulingProfileVersionId: ids[`sp:${profile}`] ?? profile }),
    idempotencyKey: k(),
  });
const pinned = async (ev: Ev) =>
  (await scoring.scoring({ actorAccountId: ev.actor, eventId: ev.eventId })) as {
    frozen: boolean;
    schedulingProfile?: {
      versionId: string;
      code: string;
      specVersion: number;
      specHash: string;
      spec: SchedulingProfileSpec;
    } | null;
  };

async function draftProfile(code: string, spec: SchedulingProfileSpec) {
  const { id: parentId } = await catalog.createScoringParent({
    operatorAccountId: op,
    kind: 'scheduling-profile',
    code,
    name: code,
    idempotencyKey: k(),
  });
  const v = await catalog.createScoringVersion({
    operatorAccountId: op,
    kind: 'scheduling-profile',
    parentId,
    spec,
    basis: { kind: 'COMMON_PRACTICE', note: 'test' },
    idempotencyKey: k(),
  });
  return { parentId, ...v };
}

describe('the catalog axis: versions, canonical hash, publication, immutability', () => {
  it('stores the canonical spec and its hash; schemaVersion is distinct from the catalog version', async () => {
    const t = template('golf-course-tee-groups');
    const listed = await reader.catalog();
    const v = listed.schedulingProfileVersions.find(
      (p) => p.versionId === ids['sp:golf-course-tee-groups'],
    );
    expect(v).toMatchObject({
      version: 1,
      specVersion: 1,
      specHash: schedulingProfileSpecHash(t.spec),
    });
    // Requirements are stored in content order (default first), whatever the declaration order.
    expect(v?.spec.requirements.map((r) => Object.keys(r.selector).length)).toEqual([0, 1]);
    expect(await reader.schedulingProfileVersion(v?.versionId as string)).toEqual(v);
    const { rows } = await sql<{ version: number; spec_version: number }>`
      SELECT version, spec_version FROM sports.scheduling_profile_version WHERE id = ${v?.versionId}`.execute(
      owner,
    );
    expect(rows).toEqual([{ version: 1, spec_version: 1 }]);
  });

  it('DRAFT → PUBLISHED → RETIRED; only PUBLISHED versions are listed, served or pinnable', async () => {
    const t = template('tennis-court-match');
    const code = `q${tag}-draft`;
    const draft = await draftProfile(code, t.spec);
    expect(draft).toMatchObject({ version: 1, specHash: schedulingProfileSpecHash(t.spec) });
    const ev = await eventWith('tennis@2', 'se');
    const visible = async () =>
      (await reader.catalog()).schedulingProfileVersions.some((p) => p.versionId === draft.id);
    expect(await visible()).toBe(false);
    expect(await reader.schedulingProfileVersion(draft.id)).toBeUndefined();
    await expect(pin(ev, 'sets-bo3-tiebreak', draft.id)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
      message: expect.stringContaining('not published'),
    });
    // The database refuses a DRAFT pin that bypasses the store.
    await expect(
      sql`INSERT INTO competition.event_scoring (id, event_id, ruleset_version_id, scheduling_profile_version_id, pinned_by_account_id, recorded_at)
          VALUES (${newId()}, ${ev.eventId}, ${ids['rs:sets-bo3-tiebreak']}, ${draft.id}, ${ev.actor}, date_trunc('milliseconds', now()))`.execute(
        owner,
      ),
    ).rejects.toThrow(/only a PUBLISHED scheduling profile/);

    await catalog.setScoringVersionStatus({
      operatorAccountId: op,
      kind: 'scheduling-profile',
      versionId: draft.id,
      status: 'PUBLISHED',
    });
    expect(await visible()).toBe(true);
    await pin(ev, 'sets-bo3-tiebreak', draft.id);
    expect((await pinned(ev)).schedulingProfile?.versionId).toBe(draft.id);

    await catalog.setScoringVersionStatus({
      operatorAccountId: op,
      kind: 'scheduling-profile',
      versionId: draft.id,
      status: 'RETIRED',
    });
    expect(await visible()).toBe(false);
    expect(await reader.schedulingProfileVersion(draft.id)).toBeUndefined();
    // An existing pin keeps its exact reference; a new pin of a RETIRED version is refused.
    expect((await pinned(ev)).schedulingProfile?.versionId).toBe(draft.id);
    await expect(pin(ev, 'sets-bo3-tiebreak', draft.id)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    await expect(
      catalog.setScoringVersionStatus({
        operatorAccountId: op,
        kind: 'scheduling-profile',
        versionId: draft.id,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
  }, 120_000);

  it('published versions are immutable in the database (spec, hash, status history)', async () => {
    const id = ids['sp:road-course-waves'] as string;
    for (const stmt of [
      sql`UPDATE sports.scheduling_profile_version SET spec = jsonb_set(spec, '{requirements,0,startSpacingSeconds}', '60') WHERE id = ${id}`,
      sql`UPDATE sports.scheduling_profile_version SET spec_hash = ${'sha256:' + '0'.repeat(64)} WHERE id = ${id}`,
      sql`DELETE FROM sports.scheduling_profile_version WHERE id = ${id}`,
      sql`UPDATE sports.scheduling_profile_version_status_change SET status = 'DRAFT' WHERE scheduling_profile_version_id = ${id}`,
      sql`DELETE FROM sports.scheduling_profile_version_status_change WHERE scheduling_profile_version_id = ${id}`,
      sql`UPDATE sports.scheduling_profile SET name = 'renamed' WHERE code = ${`p${tag}-road-course-waves`}`,
      sql`TRUNCATE sports.scheduling_profile_version_status_change`,
    ])
      await expect(stmt.execute(owner)).rejects.toThrow();
    const after = await reader.schedulingProfileVersion(id);
    expect(after?.specHash).toBe(schedulingProfileSpecHash(template('road-course-waves').spec));
    // The application role cannot write the catalog at all.
    await expect(
      sql`INSERT INTO sports.scheduling_profile_version_status_change (id, scheduling_profile_version_id, status, recorded_at)
          VALUES (${newId()}, ${id}, 'RETIRED', date_trunc('milliseconds', now()))`.execute(db),
    ).rejects.toThrow(/permission denied/);
  });

  it('identical content is one version (selector order included); a semantic change is a new version', async () => {
    const t = template('bowling-lane-pair-blocks');
    const first = await draftProfile(`q${tag}-versions`, t.spec);
    const reordered: SchedulingProfileSpec = {
      ...t.spec,
      requirements: [...t.spec.requirements].reverse(),
    };
    await expect(
      catalog.createScoringVersion({
        operatorAccountId: op,
        kind: 'scheduling-profile',
        parentId: first.parentId,
        spec: reordered,
        basis: t.basis,
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.ALREADY_EXISTS });
    const changed: SchedulingProfileSpec = {
      ...t.spec,
      requirements: t.spec.requirements.map((r) =>
        Object.keys(r.selector).length === 0 ? { ...r, expectedDurationSeconds: 10_800 } : r,
      ),
    };
    const second = await catalog.createScoringVersion({
      operatorAccountId: op,
      kind: 'scheduling-profile',
      parentId: first.parentId,
      spec: changed,
      basis: t.basis,
      idempotencyKey: k(),
    });
    expect(second.version).toBe(2);
    expect(second.specHash).not.toBe(first.specHash);
  });

  it('invalid profiles never reach publication: refused at creation and re-validated at publish', async () => {
    const ambiguous: SchedulingProfileSpec = {
      specVersion: 1,
      requirements: [
        { ...template('pool-heats').spec.requirements[0]!, selector: {} },
        { ...template('pool-heats').spec.requirements[0]!, selector: { contestType: 'HEAT' } },
        { ...template('pool-heats').spec.requirements[0]!, selector: { roundType: 'FINAL' } },
      ],
    };
    await expect(draftProfile(`q${tag}-ambiguous`, ambiguous)).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    await expect(
      draftProfile(`q${tag}-floats`, {
        specVersion: 1,
        requirements: [{ ...template('pool-heats').spec.requirements[0]!, changeoverSeconds: 0.5 }],
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    // A row written behind the store (owner) with an ambiguous spec cannot be published.
    const { parentId } = await draftProfile(`q${tag}-bypass`, template('pool-heats').spec).then(
      (x) => x,
    );
    const id = newId();
    await sql`INSERT INTO sports.scheduling_profile_version (id, profile_id, version, spec_version, spec, spec_hash, basis, created_by_account_id, recorded_at)
      VALUES (${id}, ${parentId}, 2, 1, ${JSON.stringify(ambiguous)}::jsonb, ${'sha256:' + 'a'.repeat(64)},
              '{"kind":"COMMON_PRACTICE","note":"x"}'::jsonb, ${op}, date_trunc('milliseconds', now()))`.execute(
      owner,
    );
    await sql`INSERT INTO sports.scheduling_profile_version_status_change (id, scheduling_profile_version_id, status, actor_account_id, recorded_at)
      VALUES (${newId()}, ${id}, 'DRAFT', ${op}, date_trunc('milliseconds', now()))`.execute(owner);
    await expect(
      catalog.setScoringVersionStatus({
        operatorAccountId: op,
        kind: 'scheduling-profile',
        versionId: id,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
      message: expect.stringContaining('cannot be published'),
    });
    // The database itself refuses a spec whose shape version disagrees with its column.
    await expect(
      sql`INSERT INTO sports.scheduling_profile_version (id, profile_id, version, spec_version, spec, spec_hash, basis, created_by_account_id, recorded_at)
        VALUES (${newId()}, ${parentId}, 3, 1, '{"specVersion":2,"requirements":[{}]}'::jsonb, ${'sha256:' + 'b'.repeat(64)},
                '{"kind":"COMMON_PRACTICE","note":"x"}'::jsonb, ${op}, date_trunc('milliseconds', now()))`.execute(
        owner,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('provisioning is lookup-first: a re-run changes nothing; changed content under a code is a conflict', async () => {
    const manifest = {
      sports: [],
      formats: [],
      schedulingProfiles: SCHEDULING_PROFILE_TEMPLATES.map((t) => ({
        code: `p${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    };
    const again = await catalog.provision({ operatorAccountId: op, manifest });
    expect(again.conflicts).toEqual([]);
    expect(new Set(again.steps.map((s) => s.action))).toEqual(new Set(['UNCHANGED']));
    const t = template('tennis-court-match');
    const drift = await catalog.provision({
      operatorAccountId: op,
      dryRun: true,
      manifest: {
        sports: [],
        formats: [],
        schedulingProfiles: [
          {
            code: `p${tag}-tennis-court-match`,
            name: t.name,
            versions: [
              {
                spec: {
                  ...t.spec,
                  requirements: [{ ...t.spec.requirements[0]!, changeoverSeconds: 900 }],
                },
                basis: t.basis,
              },
            ],
          },
        ],
      },
    });
    expect(drift.conflicts).toEqual([
      {
        code: `p${tag}-tennis-court-match`,
        reason: 'existing scheduling-profile versions differ from the declared specification',
      },
    ]);
  });
});

describe('event pinning: reference, compatibility, authorization, field lock', () => {
  it('nine proof categories pin the one generic profile type (wheelchair uses the basketball profile)', async () => {
    const cases: [string, string, string, string][] = [
      ['tennis@2', 'se', 'sets-bo3-tiebreak', 'tennis-court-match'],
      ['padel@1', 'gk', 'padel-bo3-star-point', 'padel-court-match'],
      ['road@1', 'wave', 'road-gun-time', 'road-course-waves'],
      ['pool@1', 'heats', 'swim-hundredths', 'pool-heats'],
      ['cyclingroad@1', 'mr', 'cycling-road-same-time', 'cycling-course-stage'],
      ['itt@1', 'interval', 'cycling-itt', 'cycling-course-stage'],
      ['bowling@1', 'qk', 'bowling-6-games-scratch', 'bowling-lane-pair-blocks'],
      ['b5x5@1', 'gk', 'basketball-4x10', 'basketball-court-game'],
      ['wheelchair@1', 'gk', 'wheelchair-basketball-4x10', 'basketball-court-game'],
      ['b3x3@1', 'gk', '3x3-10min-21', 'basketball-half-court-3x3'],
      ['golf@1', 'mr', 'golf-stroke-gross', 'golf-course-tee-groups'],
    ];
    const seen: Record<string, string> = {};
    for (const [dv, fv, rs, sp] of cases) {
      const ev = await eventWith(dv, fv);
      await pin(ev, rs, sp);
      const p = (await pinned(ev)).schedulingProfile;
      expect(p, `${dv} × ${sp}`).toMatchObject({
        versionId: ids[`sp:${sp}`],
        specVersion: 1,
        specHash: schedulingProfileSpecHash(template(sp).spec),
      });
      seen[dv] = p?.versionId as string;
    }
    expect(seen['wheelchair@1']).toBe(seen['b5x5@1']);
  }, 300_000);

  it('the event stores a reference only, and a new pin replaces the previous one (append-only)', async () => {
    const ev = await eventWith('tennis@2', 'se', false); // DRAFT event
    await pin(ev, 'sets-bo3-tiebreak', 'tennis-court-match');
    const { rows: cols } = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'competition' AND table_name = 'event_scoring'`.execute(owner);
    expect(cols.map((c) => c.column_name)).toContain('scheduling_profile_version_id');
    expect(
      cols.map((c) => c.column_name).filter((c) => /spec|duration|rest|requirement/.test(c)),
    ).toEqual([]);
    await comps.openRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
    await pin(ev, 'sets-bo3-tiebreak', null); // unpinned before lock
    expect((await pinned(ev)).schedulingProfile).toBeNull();
    await pin(ev, 'sets-bo3-tiebreak', 'tennis-court-match');
    const { rows } = await sql<{ scheduling_profile_version_id: string | null }>`
      SELECT scheduling_profile_version_id FROM competition.event_scoring WHERE event_id = ${ev.eventId} ORDER BY seq`.execute(
      owner,
    );
    expect(rows.map((r) => r.scheduling_profile_version_id)).toEqual([
      ids['sp:tennis-court-match'],
      null,
      ids['sp:tennis-court-match'],
    ]);
  }, 120_000);

  it('compatibility is capability data: undeclared resource type and v1 disciplines are refused', async () => {
    const tennis = await eventWith('tennis@2', 'se');
    await expect(pin(tennis, 'sets-bo3-tiebreak', 'padel-court-match')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
      details: { reason: 'CAPABILITY_MISMATCH' },
      message: expect.stringContaining('PADEL_COURT'),
    });
    const b3 = await eventWith('b3x3@1', 'gk');
    await expect(pin(b3, '3x3-10min-21', 'basketball-court-game')).rejects.toMatchObject({
      details: { reason: 'CAPABILITY_MISMATCH' },
    });
    const v1 = await eventWith('tennis@1', 'sev1');
    await expect(pin(v1, 'sets-bo3-tiebreak', 'tennis-court-match')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    const listed = await reader.catalog();
    const compatible = (dv: string) =>
      listed.disciplineVersions.find((x) => x.disciplineVersionId === ids[dv])
        ?.compatibleSchedulingProfileVersionIds;
    expect(compatible('tennis@1')).toEqual([]);
    expect(compatible('tennis@2')).toContain(ids['sp:tennis-court-match']);
    expect(compatible('tennis@2')).not.toContain(ids['sp:padel-court-match']);
    expect(compatible('wheelchair@1')).toContain(ids['sp:basketball-court-game']);
  }, 120_000);

  it('COMP_EDIT pins; schedulers, registration managers, non-members and other organizers cannot', async () => {
    const a = await eventWith('golf@1', 'mr');
    const b = await eventWith('golf@1', 'mr');
    for (const role of ['SCHEDULER', 'REGISTRATION_MANAGER'] as const) {
      const acct = await newTestAccount(identity, { label: role.toLowerCase() });
      await comps.assignStaff({
        actorAccountId: a.actor,
        competitionId: a.competitionId,
        personId: acct.personId as string,
        role,
        idempotencyKey: k(),
      });
      await expect(
        pin(a, 'golf-stroke-gross', 'golf-course-tee-groups', acct.accountId),
      ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    }
    const stranger = await newTestAccount(identity, { label: 'stranger' });
    await expect(
      pin(a, 'golf-stroke-gross', 'golf-course-tee-groups', stranger.accountId),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    // Organizer B owns another competition: A's event is out of scope for pins and reads.
    await expect(
      pin(a, 'golf-stroke-gross', 'golf-course-tee-groups', b.actor),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    await expect(
      scoring.scoring({ actorAccountId: b.actor, eventId: a.eventId }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    expect((await pinned(a)).schedulingProfile ?? null).toBeNull();
    await pin(a, 'golf-stroke-gross', 'golf-course-tee-groups');
    expect((await pinned(a)).schedulingProfile?.code).toBe(`p${tag}-golf-course-tee-groups`);
  }, 120_000);

  it('the pin is frozen at field lock (store and database)', async () => {
    const ev = await eventWith('golf@1', 'mr');
    await pin(ev, 'golf-stroke-gross', 'golf-course-tee-groups');
    await comps.closeRegistration({ actorAccountId: ev.actor, eventId: ev.eventId });
    await pin(ev, 'golf-stroke-gross', 'golf-course-tee-groups'); // REGISTRATION_CLOSED: still editable
    await structure.lockField({
      actorAccountId: ev.actor,
      eventId: ev.eventId,
      idempotencyKey: k(),
    });
    expect((await pinned(ev)).frozen).toBe(true);
    for (const profile of ['golf-course-tee-groups', null])
      await expect(pin(ev, 'golf-stroke-gross', profile)).rejects.toMatchObject({
        code: DomainErrorCode.INVALID_TRANSITION,
      });
    await expect(
      sql`INSERT INTO competition.event_scoring (id, event_id, ruleset_version_id, scheduling_profile_version_id, pinned_by_account_id, recorded_at)
          VALUES (${newId()}, ${ev.eventId}, ${ids['rs:golf-stroke-gross']}, NULL, ${ev.actor}, date_trunc('milliseconds', now()))`.execute(
        owner,
      ),
    ).rejects.toThrow(/frozen once the field is locked/);
    expect((await pinned(ev)).schedulingProfile?.versionId).toBe(ids['sp:golf-course-tee-groups']);
  }, 120_000);
});
