import { newId } from '@br/domain';
import type { IdentityStore } from '@br/persistence';
import { apiDb, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05E-A API: competition resources and availability. Reads need competition staff
// (COMP_VIEW_PRIVATE); changes need COMP_EDIT; nothing here schedules a contest.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05e-a-api-int-secret-0123456789abcdef';
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

const idem = (key = `k-${newId()}`) => ({ 'idempotency-key': key });
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
async function organizer(label: string) {
  const o = await person(label);
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...o.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug(label), profile: { displayName: `${label} club` } },
  );
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...o.h, ...idem() },
    {
      organizerOrganizationId: org.body?.organizationId,
      slug: uniqueSlug('fest'),
      profile: { name: `${label} fest`, timezone: 'America/Costa_Rica' },
    },
  );
  expect(c.status, c.text).toBe(201);
  return { ...o, competitionId: c.body?.competitionId as string };
}

describe('ONCF-05E-A resources and availability over the API', () => {
  it('create, read, revise, retire; availability, blackouts and evaluation; every refusal', async () => {
    const A = await organizer('o5ea-a');
    const B = await organizer('o5ea-b');
    const stranger = await person('o5ea-stranger');
    const scheduler = await person('o5ea-scheduler');
    expect(
      (
        await call(
          'POST',
          `/v1/competitions/${A.competitionId}/staff`,
          { ...A.h, ...idem() },
          { personId: scheduler.personId, role: 'SCHEDULER' },
        )
      ).status,
    ).toBe(201);

    const base = `/v1/competitions/${A.competitionId}`;
    const court = { typeCode: 'TENNIS_COURT', label: 'Court 1', attributes: { surface: 'HARD' } };
    // Refusals before anything exists: stranger, other organizer, scheduler (no COMP_EDIT).
    for (const h of [stranger.h, B.h, scheduler.h])
      expect((await call('POST', `${base}/resources`, { ...h, ...idem() }, court)).status).toBe(
        403,
      );
    expect(
      (
        await call(
          'POST',
          `${base}/resources`,
          { ...A.h, ...idem() },
          { ...court, typeCode: 'SQUASH_COURT' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `${base}/resources`,
          { ...A.h, ...idem() },
          { ...court, timezone: 'CST' },
        )
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', `${base}/resources`, { ...A.h, ...idem() }, { ...court, capacity: 0 }))
        .status,
    ).toBe(400);

    // Idempotent create: the retry answers 200 with the same resource.
    const key = `k-${newId()}`;
    const created = await call('POST', `${base}/resources`, { ...A.h, ...idem(key) }, court);
    expect(created.status, created.text).toBe(201);
    const resourceId = created.body?.resourceId as string;
    const retry = await call('POST', `${base}/resources`, { ...A.h, ...idem(key) }, court);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ resourceId, created: false });

    const list = await call('GET', `${base}/resources`, scheduler.h);
    expect(list.status).toBe(200);
    expect(list.body?.items).toEqual([
      expect.objectContaining({
        resourceId,
        typeCode: 'TENNIS_COURT',
        occupancy: 'EXCLUSIVE',
        status: 'ACTIVE',
      }),
    ]);
    for (const h of [stranger.h, B.h]) {
      expect((await call('GET', `${base}/resources`, h)).status).toBe(403);
      expect((await call('GET', `/v1/resources/${resourceId}`, h)).status).toBe(403);
      expect(
        (await call('PUT', `/v1/resources/${resourceId}`, { ...h, ...idem() }, { label: 'Mine' }))
          .status,
      ).toBe(403);
    }
    const revised = await call(
      'PUT',
      `/v1/resources/${resourceId}`,
      { ...A.h, ...idem() },
      { label: 'Centre court', attributes: { surface: 'CLAY' }, exclusivityKeys: ['centre'] },
    );
    expect(revised.status, revised.text).toBe(200);
    expect((await call('GET', `/v1/resources/${resourceId}`, A.h)).body).toMatchObject({
      label: 'Centre court',
      revision: 2,
      exclusivityKeys: ['centre'],
    });

    // Availability: weekly hours, a blackout, a competition-wide restriction; then evaluation.
    for (let weekday = 1; weekday <= 7; weekday++)
      expect(
        (
          await call(
            'POST',
            `${base}/availability`,
            { ...A.h, ...idem() },
            { resourceId, fact: { kind: 'WEEKLY', weekday, start: '08:00', end: '20:00' } },
          )
        ).status,
      ).toBe(201);
    const blackout = await call(
      'POST',
      `${base}/availability`,
      { ...A.h, ...idem() },
      {
        resourceId,
        fact: {
          kind: 'BLACKOUT',
          startsAt: '2026-11-16T15:00:00-06:00',
          endsAt: '2026-11-16T16:00:00-06:00',
          reason: 'club final',
        },
      },
    );
    expect(blackout.status, blackout.text).toBe(201);
    expect(
      (
        await call(
          'POST',
          `${base}/availability`,
          { ...scheduler.h, ...idem() },
          { resourceId, fact: { kind: 'DATE_CLOSED', date: '2026-11-20' } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `${base}/availability`,
          { ...A.h, ...idem() },
          {
            resourceId,
            fact: {
              kind: 'BLACKOUT',
              startsAt: '2026-11-16T15:00:00',
              endsAt: '2026-11-16T16:00:00Z',
              reason: 'x',
            },
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `${base}/availability`,
          { ...A.h, ...idem() },
          {
            resourceId,
            fact: { kind: 'WEEKLY', weekday: 1, start: '08:00', end: '20:00', extra: 1 },
          },
        )
      ).status,
    ).toBe(400);
    const facts = await call('GET', `${base}/availability?resource=${resourceId}`, A.h);
    expect(facts.body?.items).toHaveLength(8);
    expect(facts.body?.items.find((f: Json) => f.kind === 'BLACKOUT')).toMatchObject({
      startsAt: '2026-11-16T21:00:00.000Z',
      reason: 'club final',
    });

    const ok = await call(
      'GET',
      `/v1/resources/${resourceId}/availability/check?start=2026-11-16T15:00:00Z&end=2026-11-16T16:00:00Z`,
      A.h,
    );
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body?.available).toBe(true);
    const blocked = await call(
      'GET',
      `/v1/resources/${resourceId}/availability/check?start=${encodeURIComponent('2026-11-16T15:30:00-06:00')}&end=${encodeURIComponent('2026-11-16T16:30:00-06:00')}`,
      A.h,
    );
    expect(blocked.body).toMatchObject({
      available: false,
      gaps: [{ start: '2026-11-16T21:30:00.000Z', end: '2026-11-16T22:00:00.000Z' }],
    });
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${resourceId}/availability/check?start=2026-11-16T15:00:00&end=2026-11-16T16:00:00Z`,
          A.h,
        )
      ).status,
    ).toBe(400);
    const range = await call(
      'GET',
      `/v1/resources/${resourceId}/availability?from=2026-11-16T06:00:00Z&to=2026-11-17T06:00:00Z`,
      A.h,
    );
    expect(range.body).toMatchObject({
      timezone: 'America/Costa_Rica',
      intervals: [
        { start: '2026-11-16T14:00:00.000Z', end: '2026-11-16T21:00:00.000Z' },
        { start: '2026-11-16T22:00:00.000Z', end: '2026-11-17T02:00:00.000Z' },
      ],
    });
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${resourceId}/availability?from=2026-11-16T06:00:00Z&to=2026-11-17T06:00:00Z`,
          B.h,
        )
      ).status,
    ).toBe(403);

    // Revocation and lifecycle: reasons required; retired resources are never available.
    const blackoutId = blackout.body?.availabilityId as string;
    expect(
      (
        await call(
          'POST',
          `/v1/availability/${blackoutId}/revoke`,
          { ...B.h, ...idem() },
          { reason: 'mine' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/availability/${blackoutId}/revoke`,
          { ...A.h, ...idem() },
          { reason: '' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/v1/availability/${blackoutId}/revoke`,
          { ...A.h, ...idem() },
          { reason: 'final moved' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${resourceId}/availability/check?start=2026-11-16T21:30:00Z&end=2026-11-16T22:00:00Z`,
          A.h,
        )
      ).body?.available,
    ).toBe(true);
    expect(
      (
        await call(
          'POST',
          `/v1/resources/${resourceId}/retire`,
          { ...scheduler.h, ...idem() },
          { reason: 'x' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/resources/${resourceId}/retire`,
          { ...A.h, ...idem() },
          { reason: 'resurfacing season' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'GET',
          `/v1/resources/${resourceId}/availability/check?start=2026-11-16T15:00:00Z&end=2026-11-16T16:00:00Z`,
          A.h,
        )
      ).body?.available,
    ).toBe(false);
    expect(
      (
        await call(
          'POST',
          `/v1/resources/${resourceId}/reactivate`,
          { ...A.h, ...idem() },
          { reason: 'reopened' },
        )
      ).status,
    ).toBe(200);
  }, 300_000);

  it('the surface is configuration only: no occupancy, reservation or schedule route exists in 05E-A', () => {
    const routes = app.v1Routes
      .filter((r) => /resources|availability/.test(r.url))
      .map((r) => `${r.method} ${r.url}`);
    expect(routes.sort()).toEqual(
      [
        'GET /v1/competitions/:competitionId/resources',
        'POST /v1/competitions/:competitionId/resources',
        'GET /v1/resources/:resourceId',
        'PUT /v1/resources/:resourceId',
        'POST /v1/resources/:resourceId/retire',
        'POST /v1/resources/:resourceId/reactivate',
        'GET /v1/competitions/:competitionId/availability',
        'POST /v1/competitions/:competitionId/availability',
        'POST /v1/availability/:availabilityId/revoke',
        'GET /v1/resources/:resourceId/availability',
        'GET /v1/resources/:resourceId/availability/check',
      ].sort(),
    );
    expect(app.v1Routes.filter((r) => /reserv|occup|booking/i.test(r.url))).toEqual([]);
  });
});
