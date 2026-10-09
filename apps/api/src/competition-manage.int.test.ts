import { newId } from '@br/domain';
import { SLUG_MAX_LENGTH } from '@br/identity';
import { CatalogStore, IdentityStore } from '@br/persistence';
import { apiDb, operatorDb, seedTestCatalog, uniqueSlug, type TestCatalog } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-03A: organizer reads of the canonical Competition/Event model (DRAFT included), the
// catalog facts a tournament form needs, and the canonical slug bound. Every boundary below is
// enforced by the API; the web only renders what these routes return.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf03a-manage-int-secret-0123456789abcdefghijk';
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

async function organization(label: string) {
  const owner = await person(`${label}-owner`);
  const slug = uniqueSlug(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...owner.h, ...idem() },
    { orgType: 'CLUB', slug, profile: { displayName: `ONCF-03A ${label}` } },
  );
  expect(org.status).toBe(201);
  return { owner, slug, id: org.body?.organizationId as string };
}

/** An athlete invited into `org` with `role` who accepts the invitation. */
async function member(org: Awaited<ReturnType<typeof organization>>, role: string) {
  const u = await person(`m-${role.toLowerCase()}`);
  const athleteSlug = uniqueSlug('ath');
  const a = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    { personId: u.personId, slug: athleteSlug, profile: { displayName: `Member ${role}` } },
  );
  expect(a.status).toBe(201);
  const inv = await call(
    'POST',
    `/v1/organizations/${org.id}/invitations`,
    { ...org.owner.h, ...idem() },
    { role, visibility: 'PUBLIC', athleteSlug },
  );
  expect(inv.status).toBe(201);
  expect(
    (await call('POST', '/v1/invitations/accept', u.h, { token: inv.body?.token })).status,
  ).toBe(200);
  return u;
}

async function competition(
  org: Awaited<ReturnType<typeof organization>>,
  overrides: Record<string, unknown> = {},
) {
  const slug = uniqueSlug('cup');
  const r = await call(
    'POST',
    '/v1/competitions',
    { ...org.owner.h, ...idem() },
    {
      organizerOrganizationId: org.id,
      slug,
      profile: {
        name: 'ONCF-03A Cup',
        timezone: 'America/Costa_Rica',
        locationLabel: 'Fictional Courts',
        startsAt: '2031-05-01T00:00:00Z',
        endsAt: '2031-05-10T00:00:00Z',
      },
      ...overrides,
    },
  );
  expect(r.status, r.text).toBe(201);
  return { id: r.body?.competitionId as string, slug };
}

let cat: TestCatalog;
let orgA: Awaited<ReturnType<typeof organization>>;
let orgB: Awaited<ReturnType<typeof organization>>;
let draft: { id: string; slug: string };
let published: { id: string; slug: string };
let draftEventId: string;

beforeAll(async () => {
  cat = await seedTestCatalog(new IdentityStore(db), new CatalogStore(operator));
  orgA = await organization('orga');
  orgB = await organization('orgb');
  draft = await competition(orgA);
  const ev = await call(
    'POST',
    `/v1/competitions/${draft.id}/events`,
    { ...orgA.owner.h, ...idem() },
    {
      slug: 'open-doubles',
      disciplineVersionId: cat.padelDoubles,
      formatVersionId: cat.singleElimination,
      settings: { name: 'Open Doubles', capacity: 8, category: { genderCategory: 'OPEN' } },
    },
  );
  expect(ev.status, ev.text).toBe(201);
  draftEventId = ev.body?.eventId as string;
  published = await competition(orgA);
  expect(
    (await call('POST', `/v1/competitions/${published.id}/publish`, orgA.owner.h)).status,
  ).toBe(200);
  // Another organization's draft must never appear in orgA's list.
  await competition(orgB);
}, 240_000);

describe('GET /v1/organizations/:id/competitions/manage', () => {
  it('lists the organization’s drafts and published competitions for its owner', async () => {
    const r = await call('GET', `/v1/organizations/${orgA.id}/competitions/manage`, orgA.owner.h);
    expect(r.status, r.text).toBe(200);
    const items = r.body?.items as Json[];
    expect(items.map((i) => i.id).sort()).toEqual([draft.id, published.id].sort());
    expect(items.find((i) => i.id === draft.id)).toEqual({
      id: draft.id,
      slug: draft.slug,
      name: 'ONCF-03A Cup',
      status: 'DRAFT',
      startsAt: '2031-05-01T00:00:00.000Z',
      endsAt: '2031-05-10T00:00:00.000Z',
      timezone: 'America/Costa_Rica',
      locationLabel: 'Fictional Courts',
      regionCode: null,
      eventCount: 1,
      cancelledEventCount: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      statusChangedAt: expect.any(String),
    });
    expect(items.find((i) => i.id === published.id)?.status).toBe('PUBLISHED');
  });

  it('admits an organization ADMIN', async () => {
    const admin = await member(orgA, 'ADMIN');
    const r = await call('GET', `/v1/organizations/${orgA.id}/competitions/manage`, admin.h);
    expect(r.status).toBe(200);
    expect((r.body?.items as Json[]).some((i) => i.id === draft.id)).toBe(true);
  });

  it('refuses members without ORG_MANAGE_COMPETITIONS, other organizations and strangers', async () => {
    const staff = await member(orgA, 'STAFF');
    const plain = await member(orgA, 'MEMBER');
    const stranger = await person('stranger');
    for (const h of [staff.h, plain.h, orgB.owner.h, stranger.h]) {
      const r = await call('GET', `/v1/organizations/${orgA.id}/competitions/manage`, h);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(draft.slug);
    }
    // An unknown organization answers exactly like a foreign one (no existence oracle).
    expect(
      (await call('GET', `/v1/organizations/${newId()}/competitions/manage`, orgA.owner.h)).status,
    ).toBe(403);
    expect((await call('GET', `/v1/organizations/${orgA.id}/competitions/manage`)).status).toBe(
      401,
    );
  });

  it('keeps drafts out of the public organization list', async () => {
    const r = await call('GET', `/v1/organizations/${orgA.slug}/competitions`);
    expect(r.status).toBe(200);
    expect((r.body?.items as Json[]).map((i) => i.id)).toEqual([published.id]);
  });
});

describe('GET /v1/competitions/:id/manage', () => {
  it('returns the draft with its events in editable form, plus the caller’s access', async () => {
    const r = await call('GET', `/v1/competitions/${draft.id}/manage`, orgA.owner.h);
    expect(r.status, r.text).toBe(200);
    expect(r.body?.competition).toMatchObject({
      id: draft.id,
      slug: draft.slug,
      organizerOrganizationId: orgA.id,
      status: 'DRAFT',
      profile: {
        name: 'ONCF-03A Cup',
        description: null,
        locationLabel: 'Fictional Courts',
        timezone: 'America/Costa_Rica',
        startsAt: '2031-05-01T00:00:00.000Z',
        endsAt: '2031-05-10T00:00:00.000Z',
        website: null,
      },
      editable: { profile: true, addEvents: true },
      nextStatuses: ['PUBLISHED', 'CANCELLED'],
    });
    expect(r.body?.events).toEqual([
      expect.objectContaining({
        id: draftEventId,
        slug: 'open-doubles',
        status: 'DRAFT',
        entrantKind: 'TEAM',
        discipline: expect.objectContaining({ versionId: cat.padelDoubles, version: 1 }),
        format: expect.objectContaining({
          versionId: cat.singleElimination,
          engine: 'single-elimination/1',
        }),
        formatConfig: {},
        settings: expect.objectContaining({
          name: 'Open Doubles',
          capacity: 8,
          registrationMode: 'AUTO_CONFIRM',
          category: { genderCategory: 'OPEN' },
          timezone: 'America/Costa_Rica',
        }),
        counts: { confirmed: 0, waitlisted: 0, participants: 0 },
        editable: { settings: true, capacityAndRegistrationMode: true },
        nextStatuses: ['REGISTRATION_OPEN', 'CANCELLED'],
      }),
    ]);
    expect(r.body?.access).toMatchObject({ staffRoles: ['OWNER'] });
    expect(r.body?.access.permissions).toContain('COMP_VIEW_PRIVATE');
  });

  it('reflects the edit windows after publication and opening registration', async () => {
    const comp = await competition(orgA);
    const ev = await call(
      'POST',
      `/v1/competitions/${comp.id}/events`,
      { ...orgA.owner.h, ...idem() },
      {
        slug: 'singles',
        disciplineVersionId: cat.tennisSingles,
        formatVersionId: cat.roundRobin,
        settings: { name: 'Singles' },
      },
    );
    expect(ev.status).toBe(201);
    await call('POST', `/v1/competitions/${comp.id}/publish`, orgA.owner.h);
    await call('POST', `/v1/events/${ev.body?.eventId}/open-registration`, orgA.owner.h);
    const r = await call('GET', `/v1/competitions/${comp.id}/manage`, orgA.owner.h);
    expect(r.body?.competition.status).toBe('PUBLISHED');
    expect(r.body?.events[0]).toMatchObject({
      status: 'REGISTRATION_OPEN',
      entrantKind: 'INDIVIDUAL',
      editable: { settings: true, capacityAndRegistrationMode: false },
      nextStatuses: ['REGISTRATION_CLOSED', 'CANCELLED'],
    });
  });

  it('admits explicit competition staff (COMP_VIEW_PRIVATE) without organization rights', async () => {
    const manager = await person('reg-manager');
    const staff = await call(
      'POST',
      `/v1/competitions/${draft.id}/staff`,
      { ...orgA.owner.h, ...idem() },
      { personId: manager.personId, role: 'REGISTRATION_MANAGER' },
    );
    expect(staff.status, staff.text).toBe(201);
    const r = await call('GET', `/v1/competitions/${draft.id}/manage`, manager.h);
    expect(r.status).toBe(200);
    expect(r.body?.access.staffRoles).toEqual(['REGISTRATION_MANAGER']);
    // …but the organization list still needs ORG_MANAGE_COMPETITIONS.
    expect(
      (await call('GET', `/v1/organizations/${orgA.id}/competitions/manage`, manager.h)).status,
    ).toBe(403);
  });

  it('refuses plain members, other organizations and strangers; never leaks the draft', async () => {
    const plain = await member(orgA, 'STAFF');
    const stranger = await person('stranger2');
    for (const h of [plain.h, orgB.owner.h, stranger.h]) {
      const r = await call('GET', `/v1/competitions/${draft.id}/manage`, h);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(draft.slug);
      expect(r.text).not.toContain('Open Doubles');
    }
    expect((await call('GET', `/v1/competitions/${draft.id}/manage`)).status).toBe(401);
    expect((await call('GET', `/v1/competitions/${newId()}/manage`, orgA.owner.h)).status).toBe(
      404,
    );
  });

  it('drafts stay hidden publicly while published competitions remain readable', async () => {
    expect((await call('GET', `/v1/competitions/${draft.slug}`)).status).toBe(404);
    const pub = await call('GET', `/v1/competitions/${published.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body?.competition.status).toBe('PUBLISHED');
  });
});

describe('catalog facts for the tournament form', () => {
  it('exposes participation, contest types, format schemas and compatible pairs', async () => {
    const r = await call('GET', '/v1/catalog');
    expect(r.status).toBe(200);
    const dv = (id: string) =>
      (r.body?.disciplineVersions as Json[]).find((d) => d.disciplineVersionId === id);
    const fv = (id: string) =>
      (r.body?.formatVersions as Json[]).find((f) => f.formatVersionId === id);
    expect(dv(cat.padelDoubles)).toMatchObject({
      participantKinds: ['TEAM'],
      lineupSize: { min: 2, max: 2 },
      allowedContestTypes: ['MATCH'],
    });
    expect(dv(cat.padelDoubles)?.compatibleFormatVersionIds).toEqual(
      expect.arrayContaining([cat.singleElimination, cat.roundRobin]),
    );
    expect(dv(cat.tennisSingles)?.participantKinds).toEqual(['INDIVIDUAL']);
    // Running is HEAT-only: no registered format produces HEAT contests.
    expect(dv(cat.running5k)).toMatchObject({
      allowedContestTypes: ['HEAT'],
      compatibleFormatVersionIds: [],
    });
    expect(fv(cat.singleElimination)).toMatchObject({
      engine: 'single-elimination/1',
      contestType: 'MATCH',
      configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  });

  it('rejects the combinations the catalog reports as invalid', async () => {
    const comp = await competition(orgA);
    const create = (body: Record<string, unknown>) =>
      call('POST', `/v1/competitions/${comp.id}/events`, { ...orgA.owner.h, ...idem() }, body);
    const incompatible = await create({
      slug: 'five-k',
      disciplineVersionId: cat.running5k,
      formatVersionId: cat.singleElimination,
      settings: { name: '5K' },
    });
    expect(incompatible.status).toBe(400);
    expect(incompatible.body?.error.code).toBe('INVALID_INPUT');
    const wrongKind = await create({
      slug: 'padel-solo',
      disciplineVersionId: cat.padelDoubles,
      formatVersionId: cat.singleElimination,
      entrantKind: 'INDIVIDUAL',
      settings: { name: 'Solo padel' },
    });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body?.error.code).toBe('INVALID_INPUT');
  });
});

describe('canonical slug bound', () => {
  const exact = (n: number) => `s${newId().replace(/-/g, '')}`.padEnd(n, 'x').slice(0, n);

  it('accepts a SLUG_MAX_LENGTH slug and refuses one character more', async () => {
    const atMax = exact(SLUG_MAX_LENGTH);
    const body = (slug: string) => ({
      organizerOrganizationId: orgA.id,
      slug,
      profile: { name: 'Boundary', timezone: 'UTC' },
    });
    const accepted = await call(
      'POST',
      '/v1/competitions',
      { ...orgA.owner.h, ...idem() },
      body(atMax),
    );
    expect(accepted.status, accepted.text).toBe(201);
    expect(accepted.body?.slug).toBe(atMax);
    const over = await call(
      'POST',
      '/v1/competitions',
      { ...orgA.owner.h, ...idem() },
      body(exact(SLUG_MAX_LENGTH + 1)),
    );
    expect(over.status).toBe(400);
    const slugChange = await call(
      'PUT',
      `/v1/competitions/${accepted.body?.competitionId}/slug`,
      orgA.owner.h,
      {
        slug: exact(SLUG_MAX_LENGTH + 1),
      },
    );
    expect(slugChange.status).toBe(400);
  });

  it('a lookup longer than any slug is a miss (404), not a validation error', async () => {
    expect((await call('GET', `/v1/competitions/${'a'.repeat(80)}`)).status).toBe(404);
    expect((await call('GET', `/v1/organizations/${'a'.repeat(80)}`)).status).toBe(404);
  });
});
