import {
  PADEL_DOUBLES_V1,
  SWIMMING_POOL_V2,
  CANONICAL_CATALOG,
  type DisciplineVersionSpec,
} from '@br/competition';
import { newId } from '@br/domain';
import { CatalogStore, CompetitionReader, IdentityStore } from '@br/persistence';
import { apiDb, newTestAccount, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05B API: declared entry attributes, seeding v2, organizer readiness and locked field, the
// public stage-graph structure, and team reads for pair / squad entry.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05b-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const app = buildServer({
  db,
  operatorDb: operator,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), operator.destroy()]);
});

const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const auth = (subject: string) => ({
  authorization: `Bearer ${mintDevToken(subject, { secret: SECRET })}`,
});

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? (res.json() as Json) : null,
    text: res.body,
  };
}

async function person(label: string) {
  const h = auth(`${label}-${newId()}`);
  const p = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
  expect(p.status).toBe(201);
  return { h, personId: p.body?.personId as string };
}

async function athlete(label: string) {
  const u = await person(label);
  const slug = uniqueSlug(label);
  const a = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    {
      personId: u.personId,
      slug,
      profile: { displayName: `Athlete ${label}`, profileVisibility: 'PUBLIC' },
    },
  );
  expect(a.status, a.text).toBe(201);
  return { ...u, slug, athleteId: a.body?.athleteId as string };
}

const tag = newId().replace(/-/g, '').slice(-8);
const versions: Record<string, string> = {};
let owner: Awaited<ReturnType<typeof person>>;
let orgId = '';
let comp = { id: '', slug: '' };

beforeAll(async () => {
  const identity = new IdentityStore(db);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const padelV2 = CANONICAL_CATALOG.sports
    .flatMap((s) => s.disciplines)
    .find((d) => d.code === 'padel.doubles')?.specs[1] as DisciplineVersionSpec;
  const report = await new CatalogStore(operator).provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `y${tag}`,
          name: 'ONCF-05B API sport',
          disciplines: [
            { code: `y${tag}.pool`, name: 'Pool', specs: [SWIMMING_POOL_V2] },
            { code: `y${tag}.padel`, name: 'Padel', specs: [PADEL_DOUBLES_V1, padelV2] },
          ],
        },
      ],
      formats: [
        {
          code: `heats-${tag}`,
          name: 'Heats',
          versions: [{ engineId: 'heats-final', engineVersion: 1 }],
        },
        {
          code: `gk-${tag}`,
          name: 'Groups KO',
          versions: [{ engineId: 'groups-knockout', engineVersion: 1 }],
        },
      ],
    },
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code.startsWith(`y${tag}.`))
      versions[`${d.discipline.code.split('.')[1]}@${d.version}`] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code.endsWith(`-${tag}`))
      versions[f.format.code.split('-')[0] as string] = f.formatVersionId;

  owner = await person('o5b-owner');
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...owner.h, ...idem() },
    {
      orgType: 'CLUB',
      slug: uniqueSlug('o5b'),
      profile: { displayName: 'ONCF-05B club' },
    },
  );
  expect(org.status).toBe(201);
  orgId = org.body?.organizationId as string;
  const slug = uniqueSlug('fest');
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...owner.h, ...idem() },
    {
      organizerOrganizationId: orgId,
      slug,
      profile: { name: 'ONCF-05B Fest', timezone: 'America/Costa_Rica' },
    },
  );
  expect(c.status, c.text).toBe(201);
  comp = { id: c.body?.competitionId as string, slug };
  expect((await call('POST', `/v1/competitions/${comp.id}/publish`, owner.h)).status).toBe(200);
  expect((await call('POST', `/v1/competitions/${comp.id}/activate`, owner.h)).status).toBe(200);
}, 240_000);

async function event(
  slug: string,
  discipline: string,
  format: string,
  formatConfig: Record<string, unknown>,
) {
  const r = await call(
    'POST',
    `/v1/competitions/${comp.id}/events`,
    { ...owner.h, ...idem() },
    {
      slug,
      disciplineVersionId: versions[discipline],
      formatVersionId: versions[format],
      formatConfig,
      settings: { name: slug, category: { genderCategory: 'OPEN' } },
    },
  );
  expect(r.status, r.text).toBe(201);
  const id = r.body?.eventId as string;
  expect((await call('POST', `/v1/events/${id}/open-registration`, owner.h)).status).toBe(200);
  return id;
}

describe('swimming heats → final over the API (proof case D)', () => {
  it('entry times are declared privately, frozen at lock, seed the heats and stay out of public reads', async () => {
    const eventId = await event('free-100', 'pool@1', 'heats', { qualifyByTime: 8 });
    const swimmers = [];
    for (let i = 0; i < 12; i++) {
      const a = await athlete(`sw${i}`);
      const r = await call(
        'POST',
        `/v1/events/${eventId}/registrations`,
        { ...a.h, ...idem() },
        {
          athleteId: a.athleteId,
          eligibilityDeclared: true,
        },
      );
      expect(r.status, r.text).toBe(201);
      swimmers.push({ ...a, registrationId: r.body?.registrationId as string });
    }
    for (const [i, s] of swimmers.entries()) {
      const d = await call(
        'POST',
        `/v1/registrations/${s.registrationId}/entry-attributes`,
        { ...s.h, ...idem() },
        {
          attributes: [{ key: 'entryTimeMs', value: `${70_000 - i * 250}` }],
        },
      );
      expect(d.status, d.text).toBe(200);
    }
    // A stranger can neither declare nor read another entrant's attributes.
    const stranger = await person('stranger');
    const s0 = swimmers[0] as (typeof swimmers)[number];
    expect(
      (
        await call(
          'POST',
          `/v1/registrations/${s0.registrationId}/entry-attributes`,
          { ...stranger.h, ...idem() },
          {
            attributes: [{ key: 'entryTimeMs', value: '1' }],
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/registrations/${s0.registrationId}/entry-attributes`, stranger.h))
        .status,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/registrations/${s0.registrationId}/entry-attributes`, s0.h)).body
        ?.items,
    ).toEqual([{ key: 'entryTimeMs', value: '70000' }]);
    // An undeclared key and an invalid value are refused.
    expect(
      (
        await call(
          'POST',
          `/v1/registrations/${s0.registrationId}/entry-attributes`,
          { ...s0.h, ...idem() },
          {
            attributes: [{ key: 'handicapIndex', value: '3' }],
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/v1/registrations/${s0.registrationId}/entry-attributes`,
          { ...s0.h, ...idem() },
          {
            attributes: [{ key: 'entryTimeMs', value: '-5' }],
          },
        )
      ).status,
    ).toBe(400);

    let ready = await call('GET', `/v1/events/${eventId}/readiness`, owner.h);
    expect(ready.body?.blockers).toEqual(['FIELD_NOT_LOCKED']);
    expect((await call('GET', `/v1/events/${eventId}/readiness`, stranger.h)).status).toBe(403);

    expect((await call('POST', `/v1/events/${eventId}/close-registration`, owner.h)).status).toBe(
      200,
    );
    expect(
      (await call('POST', `/v1/events/${eventId}/lock-field`, { ...owner.h, ...idem() })).status,
    ).toBe(200);
    const field = await call('GET', `/v1/events/${eventId}/field`, owner.h);
    expect(field.body?.items).toHaveLength(12);
    expect(field.body?.items[0]?.attributes[0]?.key).toBe('entryTimeMs');
    const seed = await call(
      'POST',
      `/v1/events/${eventId}/seed`,
      { ...owner.h, ...idem() },
      {
        method: 'BY_ENTRY_ATTRIBUTE',
        attributeKey: 'entryTimeMs',
        direction: 'ASC',
        source: { kind: 'ENTRY_ATTRIBUTE', label: 'Declared entry times' },
      },
    );
    expect(seed.status, seed.text).toBe(200);
    expect(seed.body?.seedingVersion).toBe(2);
    const plan = await call('POST', `/v1/events/${eventId}/generate-plan`, {
      ...owner.h,
      ...idem(),
    });
    expect(plan.status, plan.text).toBe(200);
    expect(plan.body?.engine).toBe('heats-final/1');
    ready = await call('GET', `/v1/events/${eventId}/readiness`, owner.h);
    expect(ready.body).toMatchObject({
      blockers: [],
      planGenerated: true,
      plan: { planVersion: 2, stages: 2 },
    });

    const bracket = await call('GET', `/v1/competitions/${comp.slug}/events/free-100/bracket`);
    expect(bracket.status, bracket.text).toBe(200);
    expect(bracket.text).not.toContain('70000'); // declared values are never published
    const rounds = (bracket.body?.rounds ?? bracket.body?.items ?? bracket.body) as Json[];
    const heats = rounds.find((r: Json) => r.roundType === 'HEAT');
    expect(heats?.stage).toMatchObject({ primitive: 'HEATS', partitionKind: 'COMPETITIVE' });
    const final = rounds.find((r: Json) => r.roundType === 'FINAL');
    expect(final?.contests[0]?.slots.every((s: Json) => s.kind === 'QUALIFIER')).toBe(true);
  }, 240_000);
});

describe('pair entry over the API (team reads)', () => {
  it('a captain forms a pair, the partner accepts, the pair registers into a padel event', async () => {
    const eventId = await event('mixed-a', 'padel@2', 'gk', {
      groupCount: 2,
      qualifiersPerGroup: 1,
    });
    const captain = await athlete('cap');
    const partner = await athlete('par');
    const team = await call(
      'POST',
      '/v1/teams',
      { ...captain.h, ...idem() },
      { teamKind: 'EVENT_PAIR', displayName: 'Cap & Par' },
    );
    expect(team.status).toBe(201);
    const teamId = team.body?.teamId as string;
    for (const a of [captain, partner])
      expect(
        (
          await call(
            'POST',
            `/v1/teams/${teamId}/members`,
            { ...captain.h, ...idem() },
            { athleteId: a.athleteId },
          )
        ).status,
      ).toBe(201);
    const pending = await call('GET', '/v1/me/team-memberships', partner.h);
    expect(pending.body?.items[0]).toMatchObject({
      teamId,
      teamName: 'Cap & Par',
      status: 'PROPOSED',
    });
    expect(
      (
        await call(
          'POST',
          `/v1/team-memberships/${pending.body?.items[0]?.membershipId}/accept`,
          partner.h,
        )
      ).status,
    ).toBe(200);
    const mine = await call('GET', '/v1/me/teams', captain.h);
    const t = mine.body?.items.find((x: Json) => x.teamId === teamId);
    expect(t?.members.map((m: Json) => m.status)).toEqual(['ACTIVE', 'ACTIVE']);
    expect(t?.members.every((m: Json) => typeof m.athlete?.displayName === 'string')).toBe(true);
    const reg = await call(
      'POST',
      `/v1/events/${eventId}/registrations`,
      { ...captain.h, ...idem() },
      {
        teamId,
        eligibilityDeclared: true,
      },
    );
    expect(reg.status, reg.text).toBe(201);
    // The partner cannot read the captain's teams.
    const other = await call('GET', '/v1/me/teams', partner.h);
    expect(other.body?.items.some((x: Json) => x.teamId === teamId)).toBe(false);
  }, 240_000);
});
