import { newId } from '@br/domain';
import { CatalogStore, IdentityStore } from '@br/persistence';
import { apiDb, operatorDb, seedTestCatalog, uniqueSlug, type TestCatalog } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-04: athlete registration and organizer registration management over the canonical
// Competition/Event/Registration model. Registration commands are the BRT-05 ones; the reads
// (own registrations, one registration, a competition's registrations) are new and never public.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf04-registration-int-secret-0123456789abcdef';
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

async function athlete(label: string, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const u = await person(label);
  const slug = uniqueSlug(label);
  const a = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    {
      personId: u.personId,
      slug,
      profile: { displayName: `Athlete ${label}`, profileVisibility: visibility },
    },
  );
  expect(a.status, a.text).toBe(201);
  return { ...u, slug, athleteId: a.body?.athleteId as string };
}

async function organization(label: string) {
  const owner = await person(`${label}-owner`);
  const slug = uniqueSlug(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...owner.h, ...idem() },
    { orgType: 'CLUB', slug, profile: { displayName: `ONCF-04 ${label}` } },
  );
  expect(org.status).toBe(201);
  return { owner, slug, id: org.body?.organizationId as string };
}

async function invite(org: Awaited<ReturnType<typeof organization>>, role: string) {
  const u = await athlete(`m-${role.toLowerCase()}`);
  const inv = await call(
    'POST',
    `/v1/organizations/${org.id}/invitations`,
    { ...org.owner.h, ...idem() },
    { role, visibility: 'PUBLIC', athleteSlug: u.slug },
  );
  expect(inv.status).toBe(201);
  expect(
    (await call('POST', '/v1/invitations/accept', u.h, { token: inv.body?.token })).status,
  ).toBe(200);
  return u;
}

let cat: TestCatalog;
let orgA: Awaited<ReturnType<typeof organization>>;
let orgB: Awaited<ReturnType<typeof organization>>;
let comp: { id: string; slug: string };

async function event(
  slug: string,
  settings: Record<string, unknown>,
  opts: { open?: boolean; discipline?: string } = {},
) {
  const r = await call(
    'POST',
    `/v1/competitions/${comp.id}/events`,
    { ...orgA.owner.h, ...idem() },
    {
      slug,
      disciplineVersionId: opts.discipline ?? cat.tennisSingles,
      formatVersionId: cat.singleElimination,
      settings: { name: slug, category: { genderCategory: 'OPEN' }, ...settings },
    },
  );
  expect(r.status, r.text).toBe(201);
  const id = r.body?.eventId as string;
  if (opts.open !== false)
    expect((await call('POST', `/v1/events/${id}/open-registration`, orgA.owner.h)).status).toBe(
      200,
    );
  return id;
}

const register = (
  a: { h: Record<string, string>; athleteId: string },
  eventId: string,
  key = `k-${newId()}`,
) =>
  call(
    'POST',
    `/v1/events/${eventId}/registrations`,
    { ...a.h, 'idempotency-key': key },
    { athleteId: a.athleteId, eligibilityDeclared: true },
  );

const decide = (
  h: Record<string, string>,
  registrationId: string,
  decision: string,
  reason?: string,
) =>
  call(
    'POST',
    `/v1/registrations/${registrationId}/decision`,
    { ...h, ...idem() },
    { decision, ...(reason === undefined ? {} : { reason }) },
  );

beforeAll(async () => {
  cat = await seedTestCatalog(new IdentityStore(db), new CatalogStore(operator));
  orgA = await organization('reg-a');
  orgB = await organization('reg-b');
  const slug = uniqueSlug('open');
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...orgA.owner.h, ...idem() },
    {
      organizerOrganizationId: orgA.id,
      slug,
      profile: {
        name: 'ONCF-04 Open',
        timezone: 'America/Costa_Rica',
        locationLabel: 'Fictional Courts',
        startsAt: '2031-05-01T00:00:00Z',
        endsAt: '2031-05-10T00:00:00Z',
      },
    },
  );
  expect(c.status, c.text).toBe(201);
  comp = { id: c.body?.competitionId as string, slug };
  expect((await call('POST', `/v1/competitions/${comp.id}/publish`, orgA.owner.h)).status).toBe(
    200,
  );
}, 240_000);

describe('athlete registration (approval mode) and organizer decisions', () => {
  let eventId: string;
  let pub: Awaited<ReturnType<typeof athlete>>;
  let priv: Awaited<ReturnType<typeof athlete>>;
  let regPub: string;
  let regPriv: string;

  beforeAll(async () => {
    eventId = await event('approval-singles', {
      capacity: 1,
      registrationMode: 'ORGANIZER_APPROVAL',
    });
    pub = await athlete('pub');
    priv = await athlete('priv', 'PRIVATE');
  }, 120_000);

  it('creates a REQUESTED registration once per idempotency key and refuses a duplicate', async () => {
    const key = `k-${newId()}`;
    const first = await register(pub, eventId, key);
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({ status: 'REQUESTED', created: true });
    regPub = first.body?.registrationId as string;
    // Double submit / refresh with the same form key: the same registration, nothing new.
    const replay = await register(pub, eventId, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ registrationId: regPub, created: false });
    // A fresh attempt is a duplicate entry: refused by the store (and the DB trigger).
    const dup = await register(pub, eventId);
    expect(dup.status).toBe(409);
    expect(dup.body?.error.code).toBe('ALREADY_EXISTS');

    const p = await register(priv, eventId);
    expect(p.status).toBe(201);
    regPriv = p.body?.registrationId as string;
  });

  it('refuses registering someone else’s athlete', async () => {
    const other = await athlete('other');
    const r = await call(
      'POST',
      `/v1/events/${eventId}/registrations`,
      { ...other.h, ...idem() },
      { athleteId: pub.athleteId, eligibilityDeclared: true },
    );
    expect(r.status).toBe(403);
  });

  it('lists the athlete’s own registrations with their context and actions', async () => {
    const r = await call('GET', '/v1/me/registrations', pub.h);
    expect(r.status, r.text).toBe(200);
    const items = r.body?.items as Json[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: regPub,
      status: 'REQUESTED',
      entrantType: 'INDIVIDUAL',
      athleteId: pub.athleteId,
      athlete: { slug: pub.slug, displayName: 'Athlete pub' },
      team: null,
      reason: null,
      event: {
        id: eventId,
        slug: 'approval-singles',
        status: 'REGISTRATION_OPEN',
        entrantKind: 'INDIVIDUAL',
        capacity: 1,
        registrationMode: 'ORGANIZER_APPROVAL',
      },
      competition: { id: comp.id, slug: comp.slug, name: 'ONCF-04 Open', status: 'PUBLISHED' },
      actions: { decisions: [], withdraw: true },
    });
    // Nobody else's entries; an account without athletes has none.
    expect(
      ((await call('GET', '/v1/me/registrations', priv.h)).body?.items as Json[]).map((i) => i.id),
    ).toEqual([regPriv]);
    const nobody = await person('nobody');
    expect((await call('GET', '/v1/me/registrations', nobody.h)).body?.items).toEqual([]);
    expect((await call('GET', '/v1/me/registrations')).status).toBe(401);
  });

  it('shows one registration to its entrant and the staff, and to nobody else', async () => {
    const own = await call('GET', `/v1/registrations/${regPub}`, pub.h);
    expect(own.status, own.text).toBe(200);
    expect(own.body).toMatchObject({
      id: regPub,
      viewer: { entrant: true, staff: false },
      history: [{ status: 'REQUESTED', reason: null }],
    });
    const staff = await call('GET', `/v1/registrations/${regPub}`, orgA.owner.h);
    expect(staff.status).toBe(200);
    expect(staff.body?.viewer).toEqual({ entrant: false, staff: true });
    expect(staff.body?.actions.decisions).toEqual(['CONFIRM', 'WAITLIST', 'DECLINE']);

    // Cross-athlete, cross-organization and anonymous access are refused.
    expect((await call('GET', `/v1/registrations/${regPub}`, priv.h)).status).toBe(403);
    expect((await call('GET', `/v1/registrations/${regPub}`, orgB.owner.h)).status).toBe(403);
    expect((await call('GET', `/v1/registrations/${regPub}`)).status).toBe(401);
    expect((await call('GET', `/v1/registrations/${newId()}`, pub.h)).status).toBe(404);
  });

  it('lists the competition’s registrations for staff, naming only visible athletes', async () => {
    const r = await call('GET', `/v1/competitions/${comp.id}/registrations`, orgA.owner.h);
    expect(r.status, r.text).toBe(200);
    const items = r.body?.items as Json[];
    expect(items.map((i) => i.id)).toEqual([regPub, regPriv]);
    expect(items[0]?.athlete).toEqual({ slug: pub.slug, displayName: 'Athlete pub' });
    // A PRIVATE profile is never named, even to the organizer.
    expect(items[1]?.athlete).toBeNull();
    expect(r.text).not.toContain(priv.slug);
    expect(r.text).not.toContain('Athlete priv');
    expect(r.body?.counts).toMatchObject({ REQUESTED: 2, CONFIRMED: 0 });
    expect(r.body?.access.permissions).toContain('COMP_MANAGE_REGISTRATIONS');
    expect(items[0]?.actions).toEqual({
      decisions: ['CONFIRM', 'WAITLIST', 'DECLINE'],
      withdraw: true,
    });
  });

  it('refuses the list to other organizations, plain members, athletes and anonymous callers', async () => {
    const plain = await invite(orgA, 'MEMBER');
    for (const h of [orgB.owner.h, plain.h, pub.h]) {
      const r = await call('GET', `/v1/competitions/${comp.id}/registrations`, h);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain(regPub);
    }
    expect((await call('GET', `/v1/competitions/${comp.id}/registrations`)).status).toBe(401);
  });

  it('admits an organization ADMIN', async () => {
    const admin = await invite(orgA, 'ADMIN');
    const r = await call('GET', `/v1/competitions/${comp.id}/registrations`, admin.h);
    expect(r.status).toBe(200);
  });

  it('filters by category and status, and pages with a cursor', async () => {
    const base = `/v1/competitions/${comp.id}/registrations`;
    const byEvent = await call('GET', `${base}?eventId=${eventId}&limit=1`, orgA.owner.h);
    expect(byEvent.status, byEvent.text).toBe(200);
    expect((byEvent.body?.items as Json[]).map((i) => i.id)).toEqual([regPub]);
    expect(byEvent.body?.nextCursor).toBe(regPub);
    const next = await call(
      'GET',
      `${base}?eventId=${eventId}&limit=1&after=${regPub}`,
      orgA.owner.h,
    );
    expect((next.body?.items as Json[]).map((i) => i.id)).toEqual([regPriv]);
    expect(next.body?.nextCursor).toBeNull();
    const none = await call('GET', `${base}?status=CONFIRMED`, orgA.owner.h);
    expect(none.body?.items).toEqual([]);
    // Unknown cursor / foreign or unknown category / bad status.
    expect((await call('GET', `${base}?after=${newId()}`, orgA.owner.h)).status).toBe(400);
    expect((await call('GET', `${base}?eventId=${newId()}`, orgA.owner.h)).status).toBe(404);
    expect((await call('GET', `${base}?status=PENDING`, orgA.owner.h)).status).toBe(400);
  });

  it('confirms within capacity, then refuses another confirmation', async () => {
    const ok = await decide(orgA.owner.h, regPub, 'CONFIRM');
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body?.status).toBe('CONFIRMED');
    const full = await decide(orgA.owner.h, regPriv, 'CONFIRM');
    expect(full.status).toBe(409);
    expect(full.body?.error.code).toBe('CAPACITY_REACHED');
    // The athlete sees the organizer's decision.
    const seen = await call('GET', `/v1/registrations/${regPub}`, pub.h);
    expect(seen.body?.status).toBe('CONFIRMED');
    expect(seen.body?.eligibilityBasis).toBe('ORGANIZER_ACCEPTED');
    expect((seen.body?.history as Json[]).map((h) => h.status)).toEqual(['REQUESTED', 'CONFIRMED']);
  });

  it('waitlists and declines with a reason the athlete can read; terminal statuses refuse more', async () => {
    expect((await decide(orgA.owner.h, regPriv, 'WAITLIST')).body?.status).toBe('WAITLISTED');
    const declined = await decide(orgA.owner.h, regPriv, 'DECLINE', 'Category is full');
    expect(declined.body?.status).toBe('DECLINED');
    const seen = await call('GET', `/v1/registrations/${regPriv}`, priv.h);
    expect(seen.body).toMatchObject({
      status: 'DECLINED',
      reason: 'Category is full',
      actions: { decisions: [], withdraw: false },
    });
    const again = await decide(orgA.owner.h, regPriv, 'CONFIRM');
    expect(again.status).toBe(409);
    expect(again.body?.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses decisions from other organizations and from the athlete', async () => {
    expect((await decide(orgB.owner.h, regPub, 'CANCEL')).status).toBe(403);
    expect((await decide(pub.h, regPub, 'CANCEL')).status).toBe(403);
  });

  it('cancels a confirmed entry; the athlete sees it', async () => {
    const r = await decide(orgA.owner.h, regPub, 'CANCEL', 'Duplicate entry');
    expect(r.body?.status).toBe('CANCELLED');
    const mine = await call('GET', '/v1/me/registrations', pub.h);
    expect((mine.body?.items as Json[])[0]).toMatchObject({
      status: 'CANCELLED',
      reason: 'Duplicate entry',
    });
  });
});

describe('auto-confirm capacity, waitlist and withdrawal', () => {
  it('confirms while places last, waitlists after, and promotes on withdrawal', async () => {
    const eventId = await event('auto-singles', { capacity: 1, registrationMode: 'AUTO_CONFIRM' });
    const first = await athlete('auto1');
    const second = await athlete('auto2');
    const a = await register(first, eventId);
    expect(a.body?.status).toBe('CONFIRMED');
    const b = await register(second, eventId);
    expect(b.body?.status).toBe('WAITLISTED');

    const w = await call('POST', `/v1/registrations/${a.body?.registrationId}/withdraw`, {
      ...first.h,
      ...idem(),
    });
    expect(w.status, w.text).toBe(200);
    expect(w.body?.promotedRegistrationId).toBe(b.body?.registrationId);
    const seen = await call('GET', '/v1/me/registrations', second.h);
    expect((seen.body?.items as Json[])[0]?.status).toBe('CONFIRMED');
  });
});

describe('registration window and entrant kind', () => {
  it('refuses registration before the window opens, while DRAFT, and for team categories', async () => {
    const a = await athlete('window');
    const early = await event('later-singles', {
      registrationOpensAt: '2031-04-01T00:00:00Z',
      registrationClosesAt: '2031-04-20T00:00:00Z',
    });
    const r1 = await register(a, early);
    expect(r1.status).toBe(409);
    expect(r1.body?.error.code).toBe('INVALID_TRANSITION');

    const draft = await event('draft-singles', {}, { open: false });
    const r2 = await register(a, draft);
    expect(r2.status).toBe(409);
    expect(r2.body?.error.code).toBe('INVALID_TRANSITION');

    const team = await event('team-doubles', {}, { discipline: cat.padelDoubles });
    const r3 = await register(a, team);
    expect(r3.status).toBe(400);
    expect(r3.body?.error.code).toBe('INVALID_INPUT');

    expect((await call('GET', '/v1/me/registrations', a.h)).body?.items).toEqual([]);
  });

  it('refuses registration after registration closes', async () => {
    const a = await athlete('closed');
    const eventId = await event('closed-singles', {});
    expect(
      (await call('POST', `/v1/events/${eventId}/close-registration`, orgA.owner.h)).status,
    ).toBe(200);
    const r = await register(a, eventId);
    expect(r.status).toBe(409);
    expect(r.body?.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('public privacy', () => {
  it('never lists pending or waitlisted entries, nor private athletes, publicly', async () => {
    const eventId = await event('public-check', { registrationMode: 'ORGANIZER_APPROVAL' });
    const shown = await athlete('shown');
    const pending = await athlete('pending');
    const hidden = await athlete('hidden', 'PRIVATE');
    const s = await register(shown, eventId);
    await register(pending, eventId);
    const h = await register(hidden, eventId);
    await decide(orgA.owner.h, s.body?.registrationId as string, 'CONFIRM');
    await decide(orgA.owner.h, h.body?.registrationId as string, 'CONFIRM');

    // ONCF-04: the public summary says whether athletes or teams enter (nothing private).
    const ev = await call('GET', `/v1/competitions/${comp.slug}/events/public-check`);
    expect(ev.body?.event.entrantKind).toBe('INDIVIDUAL');
    expect(ev.text).not.toContain(s.body?.registrationId as string);

    const entries = await call(
      'GET',
      `/v1/competitions/${comp.slug}/events/public-check/participants`,
    );
    expect(entries.status).toBe(200);
    const items = entries.body?.items as Json[];
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.display.kind).sort()).toEqual(['ATHLETE', 'PRIVATE_ENTRANT']);
    expect(entries.text).toContain(shown.slug);
    expect(entries.text).not.toContain(pending.slug);
    expect(entries.text).not.toContain(hidden.slug);
    expect(entries.text).not.toContain(s.body?.registrationId as string);
  });
});
