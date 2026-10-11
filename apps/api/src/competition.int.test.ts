import { newId } from '@br/domain';
import {
  createDevelopmentPiiCipher,
  createTestWalletVerifier,
  eip155EoaPersonalSignVerifier,
  generateTestWalletKey,
} from '@br/identity';
import type { IdentityStore } from '@br/persistence';
import { apiDb, operatorDb, ownerDb, TENNIS_SINGLES_SPEC, uniqueSlug, vaultDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'competition-int-test-auth-secret-0123456789abcdef';
const KEY = 'competition-int-test-vault-key-0123456789abcdefg';
const tag = newId().replace(/-/g, '').slice(-10);
const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const operator = operatorDb();
const app = buildServer({
  db,
  vaultDb: vault,
  operatorDb: operator,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: KEY }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  walletVerifiers: [eip155EoaPersonalSignVerifier, createTestWalletVerifier()],
  logStream: { write: (line: string) => void logLines.push(line) },
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), vault.destroy(), owner.destroy(), operator.destroy()]);
});

const subjects = {
  operator: `op-subject-${tag}`,
  organizer: `org-subject-${tag}`,
  guardian: `guardian-subject-${tag}`,
};
const bearer = (sub: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET, operator })}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });
async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
    text: res.body,
    body: res.body.length > 0 ? (res.json() as Json) : null,
  };
}
async function ok(p: Promise<{ status: number; body: Json | null; text: string }>, status = 200) {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${r.text}`);
  return r.body as Json;
}

// Sentinels: distinctive private values that must never leave their private stores.
const S = {
  legalName: `Sentinel Comp Legal Q${tag}`,
  dateOfBirth: '1907-03-11',
  email: `comp.sentinel.q${tag}@example.test`,
  phone: `+1555${tag.replace(/[a-f]/g, '3').slice(0, 7)}`,
  guardianLegal: `Sentinel Guardian Q${tag}`,
  privateExt: `PRIV-EXT-COMP-Q${tag}`,
};
const privateWallet = generateTestWalletKey().address;

interface Ctx {
  op: Record<string, string>;
  org: Record<string, string>;
  organizationId: string;
  dv: string;
  fv: string;
  compSlug: string;
  competitionId: string;
  eventSlug: string;
  eventId: string;
  athletes: {
    h: Record<string, string>;
    accountId: string;
    personId: string;
    athleteId: string;
    slug: string;
    subject: string;
  }[];
  minorAthleteSlug: string;
  minorAthleteId: string;
  guardian: Record<string, string>;
}
const c = {} as Ctx;

async function athlete(i: number, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const subject = `ath-subject-${i}-${tag}`;
  const h = bearer(subject);
  const p = await ok(call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' }), 201);
  const slug = uniqueSlug(`cp${i}`);
  const a = await ok(
    call(
      'POST',
      '/v1/athletes',
      { ...h, ...idem() },
      {
        personId: p.personId,
        slug,
        profile: { displayName: `Comp Player ${i}`, profileVisibility: visibility },
      },
    ),
    201,
  );
  const me = await ok(call('GET', '/v1/me', h));
  return {
    h,
    accountId: me.accountId as string,
    personId: p.personId as string,
    athleteId: a.athleteId as string,
    slug,
    subject,
  };
}

beforeAll(async () => {
  c.op = bearer(subjects.operator, true);
  c.org = bearer(subjects.organizer);
  // operator builds the catalog through INTERNAL endpoints
  const sport = await ok(
    call(
      'POST',
      '/v1/internal/catalog/sports',
      { ...c.op, ...idem() },
      { code: `tennis${tag}`, name: 'Tennis' },
    ),
    201,
  );
  const disc = await ok(
    call(
      'POST',
      `/v1/internal/catalog/sports/${sport.sportId}/disciplines`,
      { ...c.op, ...idem() },
      { code: `tennis${tag}.singles`, name: 'Singles' },
    ),
    201,
  );
  const dv = await ok(
    call(
      'POST',
      `/v1/internal/catalog/disciplines/${disc.disciplineId}/versions`,
      { ...c.op, ...idem() },
      { spec: TENNIS_SINGLES_SPEC },
    ),
    201,
  );
  await ok(
    call(
      'POST',
      `/v1/internal/catalog/discipline-versions/${dv.disciplineVersionId}/publish`,
      c.op,
    ),
  );
  const ft = await ok(
    call(
      'POST',
      '/v1/internal/catalog/format-templates',
      { ...c.op, ...idem() },
      { code: `knockout-${tag}`, name: 'Knockout' },
    ),
    201,
  );
  const fv = await ok(
    call(
      'POST',
      `/v1/internal/catalog/format-templates/${ft.formatTemplateId}/versions`,
      { ...c.op, ...idem() },
      { engineId: 'single-elimination', engineVersion: 1 },
    ),
    201,
  );
  await ok(
    call('POST', `/v1/internal/catalog/format-versions/${fv.formatVersionId}/publish`, c.op),
  );
  c.dv = dv.disciplineVersionId;
  c.fv = fv.formatVersionId;
  // organizer
  await ok(call('POST', '/v1/persons', { ...c.org, ...idem() }, { relation: 'SELF' }), 201);
  const org = await ok(
    call(
      'POST',
      '/v1/organizations',
      { ...c.org, ...idem() },
      {
        orgType: 'CLUB',
        slug: uniqueSlug('api-club'),
        profile: { displayName: 'API Fictional Club' },
      },
    ),
    201,
  );
  c.organizationId = org.organizationId;
  c.compSlug = uniqueSlug('api-open');
  const comp = await ok(
    call(
      'POST',
      '/v1/competitions',
      { ...c.org, ...idem() },
      {
        organizerOrganizationId: c.organizationId,
        slug: c.compSlug,
        profile: {
          name: 'API Fictional Open',
          timezone: 'Europe/Madrid',
          startsAt: '2027-06-01T00:00:00Z',
          endsAt: '2027-06-30T00:00:00Z',
        },
      },
    ),
    201,
  );
  c.competitionId = comp.competitionId;
  c.eventSlug = uniqueSlug('singles');
  const ev = await ok(
    call(
      'POST',
      `/v1/competitions/${c.competitionId}/events`,
      { ...c.org, ...idem() },
      {
        slug: c.eventSlug,
        disciplineVersionId: c.dv,
        formatVersionId: c.fv,
        settings: { name: 'Open Singles', capacity: 4, category: { genderCategory: 'OPEN' } },
      },
    ),
    201,
  );
  c.eventId = ev.eventId;
  await ok(call('POST', `/v1/competitions/${c.competitionId}/publish`, c.org));
  await ok(call('POST', `/v1/events/${c.eventId}/open-registration`, c.org));

  c.athletes = [await athlete(1), await athlete(2, 'PRIVATE'), await athlete(3)];
  // private data, a private external identity and a private wallet for athlete 1 (sentinels)
  const a1 = c.athletes[0]!;
  await ok(
    call('PUT', `/v1/persons/${a1.personId}/private`, a1.h, {
      legalName: S.legalName,
      dateOfBirth: S.dateOfBirth,
      email: S.email,
      phone: S.phone,
    }),
  );
  await ok(
    call(
      'POST',
      `/v1/athletes/${a1.athleteId}/external-identities`,
      { ...a1.h, ...idem() },
      { namespace: 'fed:license', externalValue: S.privateExt, visibility: 'PRIVATE' },
    ),
    201,
  );
  const ch = await ok(
    call(
      'POST',
      `/v1/persons/${a1.personId}/wallet-challenges`,
      { ...a1.h, ...idem() },
      {
        network: 'eip155:1',
        address: privateWallet,
        visibility: 'PRIVATE',
        proofScheme: 'test-signature',
      },
    ),
    201,
  );
  const nonce = /Nonce: ([0-9a-f]+)/.exec(ch.message as string)?.[1];
  await ok(
    call(
      'POST',
      '/v1/wallet-links',
      { ...a1.h, ...idem() },
      { challengeId: ch.challengeId, signature: `test-signature:${nonce}` },
    ),
    201,
  );

  // a guardian registers a (confirmed) dependent minor
  c.guardian = bearer(subjects.guardian);
  const gp = await ok(
    call('POST', '/v1/persons', { ...c.guardian, ...idem() }, { relation: 'SELF' }),
    201,
  );
  await ok(
    call('PUT', `/v1/persons/${gp.personId}/private`, c.guardian, { legalName: S.guardianLegal }),
  );
  const dep = await ok(
    call(
      'POST',
      '/v1/persons',
      { ...c.guardian, ...idem() },
      { relation: 'DEPENDENT', relationshipKind: 'PARENT' },
    ),
    201,
  );
  await ok(
    call(
      'POST',
      `/v1/internal/guardian-relationships/${dep.guardianRelationshipId}/confirm`,
      c.op,
      { basis: 'PLATFORM_REVIEW' },
    ),
  );
  c.minorAthleteSlug = uniqueSlug('minor');
  const minor = await ok(
    call(
      'POST',
      '/v1/athletes',
      { ...c.guardian, ...idem() },
      {
        personId: dep.personId,
        slug: c.minorAthleteSlug,
        profile: { displayName: `Minor Sentinel ${tag}` },
      },
    ),
    201,
  );
  c.minorAthleteId = minor.athleteId;
}, 240_000);

describe('BRT-05 API: public competition pages', () => {
  it('catalog, competition and event pages are public DTOs; drafts are hidden', async () => {
    const catalog = await ok(call('GET', '/v1/catalog'));
    expect(catalog.disciplineVersions.some((d: Json) => d.disciplineVersionId === c.dv)).toBe(true);
    const comp = await ok(call('GET', `/v1/competitions/${c.compSlug.toUpperCase()}`));
    expect(comp).toMatchObject({
      schema: 'br:public-competition@1',
      canonicalSlug: c.compSlug,
      redirected: false, // case variants resolve to the same slug (the web redirects to canonical case)
      authority: { status: 'NOT_AVAILABLE' },
    });
    expect(comp.competition.organizer.displayName).toBe('API Fictional Club');
    expect(comp.events[0]).toMatchObject({
      slug: c.eventSlug,
      status: 'REGISTRATION_OPEN',
      capacity: 4,
      format: { engine: 'single-elimination/1' },
    });
    expect((await call('GET', `/v1/competitions/${uniqueSlug('nope')}`)).status).toBe(404);
  });

  it('commands require authentication (401), staff permission (403) and an idempotency key (400)', async () => {
    expect((await call('POST', `/v1/events/${c.eventId}/close-registration`)).status).toBe(401);
    expect(
      (
        await call('POST', `/v1/events/${c.eventId}/close-registration`, {
          authorization: 'Bearer brdev.e30.AAAA',
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('POST', `/v1/events/${c.eventId}/close-registration`, c.athletes[0]!.h)).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/v1/events/${c.eventId}/registrations`, c.athletes[0]!.h, {
          athleteId: c.athletes[0]!.athleteId,
          eligibilityDeclared: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/v1/internal/catalog/sports',
          { ...c.org, ...idem() },
          { code: 'hacked', name: 'Hacked' },
        )
      ).status,
    ).toBe(403);
    // unknown fields are refused, never stripped
    expect(
      (
        await call(
          'POST',
          `/v1/events/${c.eventId}/registrations`,
          { ...c.athletes[0]!.h, ...idem() },
          { athleteId: c.athletes[0]!.athleteId, eligibilityDeclared: true, verified: true },
        )
      ).status,
    ).toBe(400);
  });

  it('full flow: register → capacity → lock → seed → plan → schedule → lineup; public pages stay honest and private', async () => {
    for (const a of c.athletes) {
      await ok(
        call(
          'POST',
          `/v1/events/${c.eventId}/registrations`,
          { ...a.h, ...idem() },
          { athleteId: a.athleteId, eligibilityDeclared: true },
        ),
        201,
      );
    }
    const minorReg = await ok(
      call(
        'POST',
        `/v1/events/${c.eventId}/registrations`,
        { ...c.guardian, ...idem() },
        { athleteId: c.minorAthleteId, eligibilityDeclared: true },
      ),
      201,
    );
    expect(minorReg.status).toBe('CONFIRMED');
    const extra = await athlete(4);
    const waitlisted = await ok(
      call(
        'POST',
        `/v1/events/${c.eventId}/registrations`,
        { ...extra.h, ...idem() },
        { athleteId: extra.athleteId, eligibilityDeclared: true },
      ),
      201,
    );
    expect(waitlisted.status).toBe('WAITLISTED');

    await ok(call('POST', `/v1/events/${c.eventId}/close-registration`, c.org));
    const field = await ok(
      call('POST', `/v1/events/${c.eventId}/lock-field`, { ...c.org, ...idem() }),
    );
    expect(field.participantCount).toBe(4);
    const seed = await ok(
      call(
        'POST',
        `/v1/events/${c.eventId}/seed`,
        { ...c.org, ...idem() },
        { method: 'DETERMINISTIC_DRAW' },
      ),
    );
    expect(seed.drawSeed).toMatch(/^[0-9a-f]{64}$/);
    const planKey = idem();
    const plan = await ok(
      call('POST', `/v1/events/${c.eventId}/generate-plan`, { ...c.org, ...planKey }),
    );
    expect(plan).toMatchObject({
      engine: 'single-elimination/1',
      rounds: 2,
      contests: 3,
      created: true,
    });
    expect(
      await ok(call('POST', `/v1/events/${c.eventId}/generate-plan`, { ...c.org, ...planKey })),
    ).toMatchObject({ planHash: plan.planHash, created: false });

    const bracket = await ok(
      call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/bracket`),
    );
    expect(bracket.rounds.map((r: Json) => r.label)).toEqual(['Semifinal', 'Final']);
    const final = bracket.rounds[1].contests[0];
    expect(final.slots.map((s: Json) => s.kind)).toEqual([
      'WINNER_OF_CONTEST',
      'WINNER_OF_CONTEST',
    ]);
    expect(final.slots.every((s: Json) => s.resolved === false && s.display === undefined)).toBe(
      true,
    );
    expect(bracket.results.status).toBe('NOT_AVAILABLE');

    const semi = bracket.rounds[0].contests[0];
    await ok(
      call(
        'POST',
        `/v1/contests/${semi.contestId}/schedule`,
        { ...c.org, ...idem() },
        { scheduledStart: '2027-06-10T09:00:00+02:00', courtLabel: 'Court 1' },
      ),
    );
    // ONCF-05E-C: the route edits a private draft. A move needs a reason; a time outside the event
    // window is recorded in the draft and blocks publication (HARD OUTSIDE_EVENT_WINDOW).
    expect(
      (
        await call(
          'POST',
          `/v1/contests/${semi.contestId}/schedule`,
          { ...c.org, ...idem() },
          { scheduledStart: '2027-07-10T09:00:00Z' },
        )
      ).status,
    ).toBe(400); // a move without a reason
    const moved = await ok(
      call(
        'POST',
        `/v1/contests/${semi.contestId}/schedule`,
        { ...c.org, ...idem() },
        { scheduledStart: '2027-07-10T09:00:00Z', reason: 'venue change' },
      ),
    );
    const draftId = moved.versionId as string;
    const outside = await ok(call('POST', `/v1/schedule-versions/${draftId}/validate`, c.org));
    expect(outside.conflicts.map((x: Json) => x.code)).toContain('OUTSIDE_EVENT_WINDOW');
    const refused = await call(
      'POST',
      `/v1/schedule-versions/${draftId}/publish`,
      { ...c.org, ...idem() },
      {
        baseVersionId: null,
        reportHash: outside.reportHash,
        acknowledgedConflictKeys: outside.conflicts
          .filter((x: Json) => x.severity === 'SOFT')
          .map((x: Json) => x.conflictKey),
      },
    );
    expect(refused.status).toBe(409); // outside window
    expect(
      (await ok(call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/schedule`)))
        .items[0].scheduledStart,
    ).toBeNull(); // the draft is private
    await ok(
      call(
        'POST',
        `/v1/contests/${semi.contestId}/schedule`,
        { ...c.org, ...idem() },
        { scheduledStart: '2027-06-10T09:00:00+02:00', courtLabel: 'Court 1', reason: 'back' },
      ),
    );
    const report = await ok(call('POST', `/v1/schedule-versions/${draftId}/validate`, c.org));
    await ok(
      call(
        'POST',
        `/v1/schedule-versions/${draftId}/publish`,
        { ...c.org, ...idem() },
        {
          baseVersionId: null,
          reportHash: report.reportHash,
          // The organizer acknowledges the SOFT warning: a time-only slot has no end.
          acknowledgedConflictKeys: report.conflicts
            .filter((x: Json) => x.severity === 'SOFT')
            .map((x: Json) => x.conflictKey),
        },
      ),
    );
    const schedule = await ok(
      call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/schedule`),
    );
    expect(schedule.items[0]).toMatchObject({
      contestId: semi.contestId,
      scheduledStart: '2027-06-10T07:00:00.000Z',
      courtLabel: 'Court 1',
      status: 'SCHEDULED',
    });

    // lineup by the entrant for their own contest slot
    const mySlot = bracket.rounds[0].contests
      .flatMap((ct: Json) => ct.slots.map((s: Json) => ({ ct, s })))
      .find((x: Json) => x.s.display?.athleteSlug === c.athletes[0]!.slug);
    expect(mySlot).toBeDefined();
    const lineup = await call(
      'POST',
      `/v1/contests/${mySlot.ct.contestId}/lineups`,
      { ...c.athletes[0]!.h, ...idem() },
      {
        participantId: mySlot.s.participantId,
        athletes: [{ athleteId: c.athletes[0]!.athleteId }],
      },
    );
    expect(lineup.status).toBe(201);

    // public participants: private and minor athletes are PRIVATE_ENTRANT; waitlisted entries are not listed
    const parts = await ok(
      call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/participants`),
    );
    expect(parts.items).toHaveLength(4);
    const kinds = parts.items.map((p: Json) => p.display.kind).sort();
    expect(kinds).toEqual(['ATHLETE', 'ATHLETE', 'PRIVATE_ENTRANT', 'PRIVATE_ENTRANT']);
    expect(parts.items.every((p: Json) => p.seed >= 1 && p.participantId !== null)).toBe(true);
    const event = await ok(call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}`));
    expect(event).toMatchObject({
      field: { locked: true },
      seeding: { method: 'DETERMINISTIC_DRAW', drawAlgorithm: 'br-draw/1' },
      results: { status: 'NOT_AVAILABLE' },
      standings: { status: 'NOT_AVAILABLE' },
    });
    expect(event.event).toMatchObject({ confirmedCount: 4, waitlistCount: 1, participantCount: 4 });
  });

  it('sentinel privacy: no private value reaches public DTOs, outbox, audit details or logs', async () => {
    const publicTexts = [
      (await call('GET', `/v1/competitions/${c.compSlug}`)).text,
      (await call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}`)).text,
      (await call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/participants`)).text,
      (await call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/schedule`)).text,
      (await call('GET', `/v1/competitions/${c.compSlug}/events/${c.eventSlug}/bracket`)).text,
    ].join('\n');
    const accountIds = [
      ...c.athletes.map((a) => a.accountId),
      (await ok(call('GET', '/v1/me', c.guardian))).accountId as string,
    ];
    const forbidden = [
      ...Object.values(S),
      privateWallet,
      ...accountIds,
      ...Object.values(subjects),
      ...c.athletes.map((a) => a.subject),
      c.minorAthleteSlug,
      c.athletes[1]!.slug, // PRIVATE athlete
      `Minor Sentinel ${tag}`,
      'Comp Player 2', // PRIVATE athlete display name
      c.athletes[0]!.personId,
    ];
    for (const v of forbidden)
      expect(publicTexts.includes(v), `public DTO contains ${v}`).toBe(false);
    const outbox = JSON.stringify(
      (await sql`SELECT payload FROM platform.outbox_event`.execute(owner)).rows,
    );
    const audit = JSON.stringify(
      (await sql`SELECT details FROM platform.audit_event`.execute(owner)).rows,
    );
    const readModels =
      JSON.stringify((await sql`SELECT * FROM competition_read.event_entry`.execute(owner)).rows) +
      JSON.stringify((await sql`SELECT * FROM competition_read.contest_card`.execute(owner)).rows);
    for (const v of [
      ...Object.values(S),
      privateWallet,
      ...accountIds,
      ...Object.values(subjects),
    ]) {
      expect(outbox.includes(v), `outbox contains ${v}`).toBe(false);
      expect(audit.includes(v), `audit details contain ${v}`).toBe(false);
      expect(readModels.includes(v), `read models contain ${v}`).toBe(false);
      expect(logLines.join('\n').includes(v), `logs contain ${v}`).toBe(false);
    }
    expect(logLines.length).toBeGreaterThan(20);
  });
});

describe('BRT-05R: catalog mutation needs the dedicated operator connection', () => {
  // Same auth and stores, but NO operator database connection.
  const bare = buildServer({
    db,
    auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  });
  afterAll(() => bare.close());
  const bcall = async (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    payload?: unknown,
  ) => {
    const res = await bare.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: res.body.length > 0 ? (res.json() as Json) : null };
  };

  it('public catalog reads and organizer event pinning work without the operator connection', async () => {
    const cat = await bcall('GET', '/v1/catalog');
    expect(cat.status).toBe(200);
    expect(cat.body?.disciplineVersions.some((d: Json) => d.disciplineVersionId === c.dv)).toBe(
      true,
    );
    const comp = await bcall(
      'POST',
      '/v1/competitions',
      { ...c.org, ...idem() },
      {
        organizerOrganizationId: c.organizationId,
        slug: uniqueSlug('bare'),
        profile: { name: 'Bare Cup', timezone: 'UTC' },
      },
    );
    expect(comp.status).toBe(201);
    const ev = await bcall(
      'POST',
      `/v1/competitions/${comp.body?.competitionId}/events`,
      { ...c.org, ...idem() },
      {
        slug: uniqueSlug('ev'),
        disciplineVersionId: c.dv,
        formatVersionId: c.fv,
        settings: { name: 'Pinned' },
      },
    );
    expect(ev.status).toBe(201);
  });

  it('operator token without an operator connection fails closed (503), never falling back to br_api', async () => {
    const r = await bcall(
      'POST',
      '/v1/internal/catalog/sports',
      { ...c.op, ...idem() },
      { code: `nope${tag}`, name: 'Nope' },
    );
    expect(r.status).toBe(503);
    expect(r.body?.error.code).toBe('INTERNAL_CAPABILITY_UNAVAILABLE');
    expect(
      (await bcall('POST', `/v1/internal/catalog/discipline-versions/${c.dv}/retire`, c.op)).status,
    ).toBe(503);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM sports.sport WHERE code = ${`nope${tag}`}`.execute(owner);
    expect(rows[0]?.n).toBe(0);
  });

  it('non-operators, forged tokens and header spoofing never reach catalog mutation', async () => {
    for (const server of ['bare', 'full'] as const) {
      const run =
        server === 'bare'
          ? bcall
          : (m: 'GET' | 'POST', u: string, h: Record<string, string> = {}, p?: unknown) =>
              call(m, u, h, p);
      const body = { code: `evil${tag}`, name: 'Evil' };
      expect(
        (await run('POST', '/v1/internal/catalog/sports', { ...c.org, ...idem() }, body)).status,
      ).toBe(403);
      expect(
        (
          await run(
            'POST',
            '/v1/internal/catalog/sports',
            { ...bearer('random-user'), ...idem() },
            body,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await run(
            'POST',
            '/v1/internal/catalog/sports',
            { authorization: 'Bearer brdev.e30.AAAA', ...idem() },
            body,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await run(
            'POST',
            '/v1/internal/catalog/sports',
            { 'x-user-id': newId(), 'x-operator': 'true', ...idem() },
            body,
          )
        ).status,
      ).toBe(401);
    }
  });

  it('operator token + operator connection can mutate the catalog', async () => {
    const r = await call(
      'POST',
      '/v1/internal/catalog/sports',
      { ...c.op, ...idem() },
      { code: `op${tag}`, name: 'Operator sport' },
    );
    expect(r.status).toBe(201);
  });
});
