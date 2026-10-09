import { DomainErrorCode, newId } from '@br/domain';
import { apiDb, newOrganizer, newTestAccount, ownerDb, uniqueSlug } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { CompetitionStore } from './competition-store';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { ResourceStore } from './resource-store';

/**
 * ONCF-05E-A through the real stores: generic competition-scoped resources for the eight proof
 * sports, append-only revisions and lifecycle, availability facts with deterministic precedence,
 * server-side time conversion, authorization (COMP_EDIT to change, COMP_VIEW_PRIVATE to read,
 * cross-organization denial), idempotency and append-only integrity. No schedule exists here.
 */

const db = apiDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([db.destroy(), owner.destroy()]);
});
const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const comps = new CompetitionStore(db);
const resources = new ResourceStore(db);
const k = () => `k-${newId()}`;

async function competition(timezone = 'America/Costa_Rica') {
  const org = await newOrganizer(identity, orgs);
  const { competitionId } = await comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('comp'),
    profile: { name: 'ONCF-05E-A Fest', timezone },
    idempotencyKey: k(),
  });
  return { competitionId, actor: org.ownerAccountId };
}
type C = Awaited<ReturnType<typeof competition>>;

const create = (
  c: C,
  typeCode: string,
  label: string,
  extra: Record<string, unknown> = {},
  idempotencyKey = k(),
) =>
  resources.createResource({
    actorAccountId: c.actor,
    competitionId: c.competitionId,
    typeCode,
    resource: { label, ...extra },
    idempotencyKey,
  });
const add = (
  c: C,
  resourceId: string | null,
  fact: Parameters<ResourceStore['addAvailability']>[0]['fact'],
) =>
  resources.addAvailability({
    actorAccountId: c.actor,
    competitionId: c.competitionId,
    resourceId,
    fact,
    idempotencyKey: k(),
  });
const check = (c: C, resourceId: string, start: string, end: string) =>
  resources.check({ actorAccountId: c.actor, resourceId, start, end });

describe('generic resources: eight proof sports, one model', () => {
  it('creates every proof-sport resource through the same API, with capacity and overlap semantics as data', async () => {
    const c = await competition();
    const specs: [string, string, Record<string, unknown>][] = [
      ['TENNIS_COURT', 'Court 1', { attributes: { surface: 'HARD', lights: true } }],
      ['PADEL_COURT', 'Padel A', { attributes: { indoor: true } }],
      [
        'ROAD_COURSE',
        'Marathon course',
        { capacity: 500, attributes: { distanceMeters: 42195, certified: true } },
      ],
      ['POOL', 'Competition pool', { attributes: { lanes: 8, lengthMeters: '50' } }],
      ['CYCLING_COURSE', 'Circuit', { capacity: 200, attributes: { distanceMeters: 12000 } }],
      ['BOWLING_LANE_PAIR', 'Lanes 11–12', { attributes: { firstLane: 11 } }],
      ['BASKETBALL_COURT', 'Main court', { exclusivityKeys: ['main-a', 'main-b'] }],
      ['BASKETBALL_HALF_COURT', 'Main court · half A', { exclusivityKeys: ['main-a'] }],
      [
        'GOLF_COURSE',
        'Championship course',
        { capacity: 40, attributes: { holes: '18', startingTees: [1, 10] } },
      ],
    ];
    for (const [type, label, extra] of specs) await create(c, type, label, extra);
    const { items } = await resources.listResources({
      actorAccountId: c.actor,
      competitionId: c.competitionId,
    });
    expect(items).toHaveLength(9);
    const byType = Object.fromEntries(items.map((r) => [r.typeCode, r]));
    expect(byType['TENNIS_COURT']?.occupancy).toBe('EXCLUSIVE');
    expect(byType['ROAD_COURSE']).toMatchObject({ occupancy: 'SHARED_CAPACITY', capacity: 500 });
    expect(byType['BASKETBALL_COURT']?.exclusivityKeys).toEqual(['main-a', 'main-b']);
    expect(byType['GOLF_COURSE']?.attributes).toEqual({ holes: '18', startingTees: [1, 10] });
  }, 120_000);

  it('validation: unknown type, foreign attribute, bad capacity, abbreviation zone and duplicate labels are refused', async () => {
    const c = await competition();
    await expect(create(c, 'SQUASH_COURT', 'Court')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    await expect(
      create(c, 'TENNIS_COURT', 'Court', { attributes: { lanes: 8 } }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    await expect(create(c, 'TENNIS_COURT', 'Court', { capacity: 0 })).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    await expect(create(c, 'TENNIS_COURT', 'Court', { timezone: 'CST' })).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_INPUT,
    });
    await create(c, 'TENNIS_COURT', 'Court 1');
    await expect(create(c, 'PADEL_COURT', 'court 1')).rejects.toMatchObject({
      details: { reason: 'DUPLICATE_LABEL' },
    });
  }, 120_000);

  it('revisions and lifecycle are append-only history; retiring needs a reason; a retired label is free again', async () => {
    const c = await competition();
    const { resourceId } = await create(c, 'TENNIS_COURT', 'Court 1');
    await resources.reviseResource({
      actorAccountId: c.actor,
      resourceId,
      resource: { label: 'Centre court', attributes: { surface: 'CLAY' } },
      idempotencyKey: k(),
    });
    await expect(
      resources.setResourceStatus({
        actorAccountId: c.actor,
        resourceId,
        status: 'RETIRED',
        reason: '',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
    await resources.setResourceStatus({
      actorAccountId: c.actor,
      resourceId,
      status: 'RETIRED',
      reason: 'net damaged beyond repair',
      idempotencyKey: k(),
    });
    await expect(
      resources.setResourceStatus({
        actorAccountId: c.actor,
        resourceId,
        status: 'RETIRED',
        reason: 'again',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
    const r = await resources.getResource({ actorAccountId: c.actor, resourceId });
    expect(r).toMatchObject({
      label: 'Centre court',
      status: 'RETIRED',
      revision: 3,
      attributes: { surface: 'CLAY' },
    });
    expect(r.history.map((h) => [h.revision, h.status, h.reason])).toEqual([
      [3, 'RETIRED', 'net damaged beyond repair'],
      [2, 'ACTIVE', null],
      [1, 'ACTIVE', null],
    ]);
    await create(c, 'TENNIS_COURT', 'Centre court'); // the retired label is reusable
    await expect(
      resources.setResourceStatus({
        actorAccountId: c.actor,
        resourceId,
        status: 'ACTIVE',
        reason: 'repaired',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ details: { reason: 'DUPLICATE_LABEL' } });
    await expect(
      sql`UPDATE competition.resource_revision SET label = 'x' WHERE resource_id = ${resourceId}`.execute(
        owner,
      ),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM competition.resource WHERE id = ${resourceId}`.execute(owner),
    ).rejects.toThrow();
  }, 120_000);

  it('idempotency: a retried create returns the same resource and writes nothing new', async () => {
    const c = await competition();
    const key = k();
    const a = await create(c, 'POOL', 'Pool', {}, key);
    const b = await create(c, 'POOL', 'Pool', {}, key);
    expect(b).toEqual({ resourceId: a.resourceId, created: false });
    expect(
      (await resources.listResources({ actorAccountId: c.actor, competitionId: c.competitionId }))
        .items,
    ).toHaveLength(1);
  }, 120_000);
});

describe('availability: precedence, time conversion, revocation', () => {
  it('weekly hours, a reduced date, a closed date, maintenance and a competition-wide restriction', async () => {
    const c = await competition(); // America/Costa_Rica, UTC-06:00
    const { resourceId } = await create(c, 'TENNIS_COURT', 'Court 1');
    for (let weekday = 1; weekday <= 7; weekday++)
      await add(c, resourceId, { kind: 'WEEKLY', weekday, start: '08:00', end: '22:00' });
    // A · B · inside / outside the weekly window (Mon 2026-11-16: 08:00–22:00 local = 14:00Z–04:00Z)
    expect(
      (await check(c, resourceId, '2026-11-16T15:00:00Z', '2026-11-16T16:00:00Z')).available,
    ).toBe(true);
    expect(
      (await check(c, resourceId, '2026-11-16T13:00:00Z', '2026-11-16T15:00:00Z')).gaps,
    ).toEqual([{ start: '2026-11-16T13:00:00.000Z', end: '2026-11-16T14:00:00.000Z' }]);
    // D · C · reduced and closed dates replace the weekly windows for that date only
    await add(c, resourceId, {
      kind: 'DATE_OPEN',
      date: '2026-11-17',
      start: '12:00',
      end: '18:00',
    });
    await add(c, resourceId, { kind: 'DATE_CLOSED', date: '2026-11-18' });
    expect(
      (await check(c, resourceId, '2026-11-17T15:00:00Z', '2026-11-17T17:00:00Z')).available,
    ).toBe(false);
    expect(
      (await check(c, resourceId, '2026-11-17T18:00:00Z', '2026-11-18T00:00:00Z')).available,
    ).toBe(true);
    expect(
      (await check(c, resourceId, '2026-11-18T15:00:00Z', '2026-11-18T16:00:00Z')).available,
    ).toBe(false);
    // E · F · G · maintenance removes its interval only
    await add(c, resourceId, {
      kind: 'MAINTENANCE',
      startsAt: '2026-11-16T16:00:00Z',
      endsAt: '2026-11-16T17:00:00Z',
      reason: 'line repainting',
    });
    expect(
      (await check(c, resourceId, '2026-11-16T16:30:00Z', '2026-11-16T16:45:00Z')).available,
    ).toBe(false);
    expect(
      (await check(c, resourceId, '2026-11-16T15:00:00Z', '2026-11-16T16:00:00Z')).available,
    ).toBe(true);
    expect(
      (await check(c, resourceId, '2026-11-16T17:00:00Z', '2026-11-16T18:00:00Z')).available,
    ).toBe(true);
    // H · a competition-wide restriction intersects every resource (10:00–18:00 local on Mondays)
    await add(c, null, { kind: 'WEEKLY', weekday: 1, start: '10:00', end: '18:00' });
    const day = await resources.availability({
      actorAccountId: c.actor,
      resourceId,
      from: '2026-11-16T06:00:00Z',
      to: '2026-11-17T06:00:00Z',
    });
    // resource 14:00Z–04:00Z ∩ competition 16:00Z–24:00Z − maintenance 16:00Z–17:00Z
    expect(day.intervals).toEqual([
      { start: '2026-11-16T17:00:00.000Z', end: '2026-11-17T00:00:00.000Z' },
    ]);
    expect(day.timezone).toBe('America/Costa_Rica');
  }, 180_000);

  it('I · a retired resource is never available; J · adjacent intervals touch without overlapping', async () => {
    const c = await competition();
    const { resourceId } = await create(c, 'PADEL_COURT', 'Padel A');
    await add(c, resourceId, {
      kind: 'BLACKOUT',
      startsAt: '2026-11-16T10:00:00Z',
      endsAt: '2026-11-16T11:00:00Z',
      reason: 'private event',
    });
    expect(
      (await check(c, resourceId, '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')).available,
    ).toBe(true);
    expect(
      (await check(c, resourceId, '2026-11-16T11:00:00Z', '2026-11-16T12:00:00Z')).available,
    ).toBe(true);
    expect(
      (await check(c, resourceId, '2026-11-16T10:59:00Z', '2026-11-16T11:30:00Z')).available,
    ).toBe(false);
    await resources.setResourceStatus({
      actorAccountId: c.actor,
      resourceId,
      status: 'RETIRED',
      reason: 'closed',
      idempotencyKey: k(),
    });
    expect(
      (await check(c, resourceId, '2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z')).available,
    ).toBe(false);
  }, 120_000);

  it('a resource in a DST zone keeps its local hours across the transition (server-side conversion)', async () => {
    const c = await competition('America/New_York');
    const { resourceId } = await create(c, 'BOWLING_LANE_PAIR', 'Lanes 1–2');
    await add(c, resourceId, { kind: 'WEEKLY', weekday: 7, start: '09:00', end: '17:00' });
    const before = await resources.availability({
      actorAccountId: c.actor,
      resourceId,
      from: '2026-03-01T05:00:00Z',
      to: '2026-03-02T05:00:00Z',
    });
    const after = await resources.availability({
      actorAccountId: c.actor,
      resourceId,
      from: '2026-03-08T05:00:00Z',
      to: '2026-03-09T04:00:00Z',
    });
    expect(before.intervals).toEqual([
      { start: '2026-03-01T14:00:00.000Z', end: '2026-03-01T22:00:00.000Z' },
    ]);
    expect(after.intervals).toEqual([
      { start: '2026-03-08T13:00:00.000Z', end: '2026-03-08T21:00:00.000Z' },
    ]);
    // A resource may declare its own zone instead of inheriting the competition's.
    const { resourceId: cr } = await create(c, 'POOL', 'Remote pool', {
      timezone: 'America/Costa_Rica',
    });
    await add(c, cr, { kind: 'WEEKLY', weekday: 7, start: '09:00', end: '17:00' });
    expect(
      (
        await resources.availability({
          actorAccountId: c.actor,
          resourceId: cr,
          from: '2026-03-08T06:00:00Z',
          to: '2026-03-09T06:00:00Z',
        })
      ).intervals,
    ).toEqual([{ start: '2026-03-08T15:00:00.000Z', end: '2026-03-08T23:00:00.000Z' }]);
  }, 120_000);

  it('duplicates are refused, revocation is append-only and explicit, and validation runs in the domain', async () => {
    const c = await competition();
    const { resourceId } = await create(c, 'POOL', 'Pool');
    const blackout = {
      kind: 'BLACKOUT' as const,
      startsAt: '2026-11-16T10:00:00Z',
      endsAt: '2026-11-16T12:00:00Z',
      reason: 'school gala',
    };
    const { availabilityId } = await add(c, resourceId, blackout);
    await expect(add(c, resourceId, blackout)).rejects.toMatchObject({
      details: { reason: 'DUPLICATE_AVAILABILITY' },
    });
    expect(
      (await check(c, resourceId, '2026-11-16T10:30:00Z', '2026-11-16T11:00:00Z')).available,
    ).toBe(false);
    await resources.revokeAvailability({
      actorAccountId: c.actor,
      availabilityId,
      reason: 'gala moved',
      idempotencyKey: k(),
    });
    expect(
      (await check(c, resourceId, '2026-11-16T10:30:00Z', '2026-11-16T11:00:00Z')).available,
    ).toBe(true);
    await expect(
      resources.revokeAvailability({
        actorAccountId: c.actor,
        availabilityId,
        reason: 'again',
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_TRANSITION });
    expect(
      (
        await resources.listAvailability({
          actorAccountId: c.actor,
          competitionId: c.competitionId,
        })
      ).items,
    ).toEqual([]);
    for (const bad of [
      {
        kind: 'BLACKOUT' as const,
        startsAt: '2026-11-16T12:00:00Z',
        endsAt: '2026-11-16T12:00:00Z',
        reason: 'zero',
      },
      {
        kind: 'BLACKOUT' as const,
        startsAt: '2026-11-16T12:00:00',
        endsAt: '2026-11-16T13:00:00Z',
        reason: 'no offset',
      },
      { kind: 'WEEKLY' as const, weekday: 0, start: '08:00', end: '09:00' },
      { kind: 'DATE_OPEN' as const, date: '2026-02-30', start: '08:00', end: '09:00' },
    ])
      await expect(add(c, resourceId, bad)).rejects.toMatchObject({
        code: DomainErrorCode.INVALID_INPUT,
      });
    await expect(
      resources.check({
        actorAccountId: c.actor,
        resourceId,
        start: '2026-11-16T12:00:00Z',
        end: '2026-11-16T11:00:00Z',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.INVALID_INPUT });
  }, 120_000);
});

describe('authorization and competition scope', () => {
  it('COMP_EDIT changes, COMP_VIEW_PRIVATE reads; schedulers and registration managers cannot configure; other organizers see nothing', async () => {
    const a = await competition();
    const b = await competition();
    const { resourceId } = await create(a, 'TENNIS_COURT', 'Court 1');
    const staff = async (role: 'SCHEDULER' | 'REGISTRATION_MANAGER') => {
      const acct = await newTestAccount(identity, { label: role.toLowerCase() });
      await comps.assignStaff({
        actorAccountId: a.actor,
        competitionId: a.competitionId,
        personId: acct.personId as string,
        role,
        idempotencyKey: k(),
      });
      return acct.accountId;
    };
    for (const role of ['SCHEDULER', 'REGISTRATION_MANAGER'] as const) {
      const actor = await staff(role);
      expect(
        (await resources.listResources({ actorAccountId: actor, competitionId: a.competitionId }))
          .items,
      ).toHaveLength(1);
      await expect(
        resources.createResource({
          actorAccountId: actor,
          competitionId: a.competitionId,
          typeCode: 'POOL',
          resource: { label: 'Pool' },
          idempotencyKey: k(),
        }),
      ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
      await expect(
        resources.addAvailability({
          actorAccountId: actor,
          competitionId: a.competitionId,
          resourceId,
          fact: { kind: 'DATE_CLOSED', date: '2026-11-16' },
          idempotencyKey: k(),
        }),
      ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    }
    // Organizer B: nothing of competition A is readable or writable, whatever ids it sends.
    await expect(
      resources.listResources({ actorAccountId: b.actor, competitionId: a.competitionId }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    await expect(
      resources.getResource({ actorAccountId: b.actor, resourceId }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    await expect(
      resources.reviseResource({
        actorAccountId: b.actor,
        resourceId,
        resource: { label: 'Mine' },
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    await expect(
      resources.check({
        actorAccountId: b.actor,
        resourceId,
        start: '2026-11-16T10:00:00Z',
        end: '2026-11-16T11:00:00Z',
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.FORBIDDEN });
    // B cannot attach a fact to A's resource through B's own competition (scope is resolved server-side).
    await expect(
      resources.addAvailability({
        actorAccountId: b.actor,
        competitionId: b.competitionId,
        resourceId,
        fact: { kind: 'DATE_CLOSED', date: '2026-11-16' },
        idempotencyKey: k(),
      }),
    ).rejects.toMatchObject({ code: DomainErrorCode.NOT_FOUND });
    // …and the database refuses it too.
    await expect(
      sql`INSERT INTO competition.resource_availability (id, competition_id, resource_id, kind, local_date, created_by_account_id, recorded_at)
          VALUES (${newId()}, ${b.competitionId}, ${resourceId}, 'DATE_CLOSED', '2026-11-16', ${b.actor}, date_trunc('milliseconds', now()))`.execute(
        owner,
      ),
    ).rejects.toThrow(/another competition/);
  }, 180_000);

  it('a cancelled competition’s resources can be read but no longer changed', async () => {
    const c = await competition();
    const { resourceId } = await create(c, 'GOLF_COURSE', 'Course');
    await comps.cancelCompetition({
      actorAccountId: c.actor,
      competitionId: c.competitionId,
      reason: 'weather',
    });
    expect((await resources.getResource({ actorAccountId: c.actor, resourceId })).status).toBe(
      'ACTIVE',
    );
    await expect(create(c, 'GOLF_COURSE', 'Course 2')).rejects.toMatchObject({
      code: DomainErrorCode.INVALID_TRANSITION,
    });
  }, 120_000);
});
