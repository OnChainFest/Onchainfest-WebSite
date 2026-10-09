import { describe, expect, it } from 'vitest';
import {
  covers,
  effectiveAvailability,
  ianaZoneIssue,
  intersect,
  isResourceAvailable,
  localMs,
  occupancyOf,
  overlaps,
  resolve,
  resolveRecurring,
  resolveStrict,
  sharesSpace,
  subtract,
  union,
  validateAvailabilityFact,
  validateResource,
  type AvailabilityFact,
  type AvailabilityInput,
} from './index';

const Z = (iso: string) => Date.parse(iso);
const iv = (a: string, b: string) => ({ start: Z(a), end: Z(b) });
const CR = 'America/Costa_Rica'; // UTC-06:00, no DST
const NY = 'America/New_York'; // DST: 2026-03-08 02:00 → 03:00; 2026-11-01 02:00 → 01:00

const input = (
  facts: AvailabilityFact[],
  over: Partial<AvailabilityInput> = {},
): AvailabilityInput => ({
  status: 'ACTIVE',
  resource: { zone: CR, facts },
  competition: { zone: CR, facts: [] },
  ...over,
});
// 2026-11-16 is a Monday.
const weekdays = (start: string, end: string): AvailabilityFact[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ kind: 'WEEKLY' as const, weekday, start, end }));

describe('interval primitive: half-open [start, end)', () => {
  it('J · adjacent intervals do not overlap; K · overlapping ones do', () => {
    expect(
      overlaps(
        iv('2026-11-16T09:00Z', '2026-11-16T10:00Z'),
        iv('2026-11-16T10:00Z', '2026-11-16T11:00Z'),
      ),
    ).toBe(false);
    expect(
      overlaps(
        iv('2026-11-16T09:00Z', '2026-11-16T10:00Z'),
        iv('2026-11-16T09:59Z', '2026-11-16T10:30Z'),
      ),
    ).toBe(true);
  });
  it('union merges touching intervals; intersect / subtract / covers are exact', () => {
    const a = iv('2026-01-01T08:00Z', '2026-01-01T12:00Z');
    const b = iv('2026-01-01T12:00Z', '2026-01-01T14:00Z');
    expect(union([b, a])).toEqual([{ start: a.start, end: b.end }]);
    expect(intersect([a], [iv('2026-01-01T10:00Z', '2026-01-01T20:00Z')])).toEqual([
      iv('2026-01-01T10:00Z', '2026-01-01T12:00Z'),
    ]);
    expect(subtract([a], [iv('2026-01-01T09:00Z', '2026-01-01T10:00Z')])).toEqual([
      iv('2026-01-01T08:00Z', '2026-01-01T09:00Z'),
      iv('2026-01-01T10:00Z', '2026-01-01T12:00Z'),
    ]);
    expect(covers(union([a, b]), iv('2026-01-01T11:00Z', '2026-01-01T13:00Z'))).toBe(true);
  });
});

describe('time model (ADR-0068): server-side wall-clock → instant', () => {
  it('fixed-offset zone: 2026-11-15 09:30 America/Costa_Rica is 15:30Z', () => {
    expect(resolveStrict('2026-11-15', '09:30', CR)).toEqual({
      ok: true,
      instant: Z('2026-11-15T15:30:00Z'),
    });
    expect(resolve(localMs('2026-11-15', '09:30') as number, CR).kind).toBe('NORMAL');
  });
  it('normal DST-zone time', () => {
    expect(resolveStrict('2026-07-01', '10:00', NY)).toEqual({
      ok: true,
      instant: Z('2026-07-01T14:00:00Z'),
    });
  });
  it('spring-forward skipped time: recurring rules move forward by the gap; one-off input is refused', () => {
    const wall = localMs('2026-03-08', '02:30') as number;
    expect(resolve(wall, NY)).toMatchObject({ kind: 'SKIPPED', gapMinutes: 60 });
    expect(resolveRecurring(wall, NY)).toBe(Z('2026-03-08T07:30:00Z')); // 03:30 EDT
    expect(resolveStrict('2026-03-08', '02:30', NY)).toEqual({
      ok: false,
      code: 'LOCAL_TIME_SKIPPED',
    });
  });
  it('fall-back repeated time: recurring rules take the earlier occurrence; one-off input needs an offset', () => {
    const wall = localMs('2026-11-01', '01:30') as number;
    expect(resolve(wall, NY)).toEqual({
      kind: 'REPEATED',
      instants: [Z('2026-11-01T05:30:00Z'), Z('2026-11-01T06:30:00Z')],
    });
    expect(resolveRecurring(wall, NY)).toBe(Z('2026-11-01T05:30:00Z')); // EDT, the earlier one
    expect(resolveStrict('2026-11-01', '01:30', NY)).toEqual({
      ok: false,
      code: 'LOCAL_TIME_AMBIGUOUS',
    });
    expect(resolveStrict('2026-11-01', '01:30', NY, -300)).toEqual({
      ok: true,
      instant: Z('2026-11-01T06:30:00Z'),
    });
    expect(resolveStrict('2026-11-01', '01:30', NY, -240)).toEqual({
      ok: true,
      instant: Z('2026-11-01T05:30:00Z'),
    });
    expect(resolveStrict('2026-11-01', '01:30', NY, -360)).toEqual({
      ok: false,
      code: 'OFFSET_MISMATCH',
    });
  });
  it('a weekly rule keeps its wall-clock time across a DST transition (the UTC instant moves)', () => {
    const r = input([{ kind: 'WEEKLY', weekday: 7, start: '08:00', end: '18:00' }], {
      resource: { zone: NY, facts: [{ kind: 'WEEKLY', weekday: 7, start: '08:00', end: '18:00' }] },
    });
    const before = effectiveAvailability(r, Z('2026-03-01T00:00Z'), Z('2026-03-02T12:00Z'));
    const after = effectiveAvailability(r, Z('2026-03-08T00:00Z'), Z('2026-03-09T12:00Z'));
    expect(before).toEqual([iv('2026-03-01T13:00Z', '2026-03-01T23:00Z')]); // EST
    expect(after).toEqual([iv('2026-03-08T12:00Z', '2026-03-08T22:00Z')]); // EDT
  });
  it('a window spanning the gap is one real hour shorter', () => {
    const r = input([], {
      resource: {
        zone: NY,
        facts: [{ kind: 'DATE_OPEN', date: '2026-03-08', start: '01:00', end: '03:00' }],
      },
    });
    // The local day 2026-03-08 is 05:00Z (00:00 EST) → 04:00Z next day (00:00 EDT): 23 hours.
    expect(effectiveAvailability(r, Z('2026-03-08T05:00Z'), Z('2026-03-09T04:00Z'))).toEqual([
      iv('2026-03-08T06:00Z', '2026-03-08T07:00Z'),
    ]);
  });
  it('IANA zones only: abbreviations, bare offsets and unknown names are refused', () => {
    expect(ianaZoneIssue(CR)).toBeUndefined();
    expect(ianaZoneIssue('America/Argentina/Buenos_Aires')).toBeUndefined();
    expect(ianaZoneIssue('UTC')).toBeUndefined();
    for (const z of ['CST', 'EST', '+06:00', 'GMT-6', 'Mars/Olympus'])
      expect(ianaZoneIssue(z)).toBeDefined();
  });
  it('invalid local dates and times are refused', () => {
    expect(localMs('2026-02-30', '10:00')).toBeUndefined();
    expect(resolveStrict('2026-11-15', '24:00', CR)).toEqual({
      ok: false,
      code: 'INVALID_LOCAL_TIME',
    });
  });
});

describe('availability precedence matrix (ADR-0068)', () => {
  const day = iv('2026-11-16T06:00Z', '2026-11-17T06:00Z'); // Monday 2026-11-16 in Costa Rica
  const regular = weekdays('08:00', '18:00'); // 14:00Z–24:00Z

  it('A · inside a weekly window → available; B · outside → unavailable', () => {
    expect(
      isResourceAvailable(input(regular), iv('2026-11-16T15:00Z', '2026-11-16T16:00Z')).available,
    ).toBe(true);
    const out = isResourceAvailable(input(regular), iv('2026-11-16T13:00Z', '2026-11-16T15:00Z'));
    expect(out.available).toBe(false);
    expect(out.gaps).toEqual([iv('2026-11-16T13:00Z', '2026-11-16T14:00Z')]);
  });
  it('C · a closed date wins; D · an open exception replaces the weekly windows for that date only', () => {
    const closed = input([
      ...regular,
      { kind: 'DATE_CLOSED', date: '2026-11-16' },
      { kind: 'DATE_OPEN', date: '2026-11-16', start: '12:00', end: '18:00' },
    ]);
    expect(effectiveAvailability(closed, day.start, day.end)).toEqual([]);
    const reduced = input([
      ...regular,
      { kind: 'DATE_OPEN', date: '2026-11-16', start: '12:00', end: '18:00' },
    ]);
    expect(effectiveAvailability(reduced, day.start, day.end)).toEqual([
      iv('2026-11-16T18:00Z', '2026-11-17T00:00Z'),
    ]);
    expect(effectiveAvailability(reduced, Z('2026-11-17T06:00Z'), Z('2026-11-18T06:00Z'))).toEqual([
      iv('2026-11-17T14:00Z', '2026-11-18T00:00Z'),
    ]);
  });
  it('E · a blackout removes its interval; F · before and G · after it stay available', () => {
    const r = input([
      ...regular,
      {
        kind: 'MAINTENANCE',
        startsAt: Z('2026-11-16T16:00Z'),
        endsAt: Z('2026-11-16T17:00Z'),
        reason: 'resurfacing',
      },
    ]);
    expect(isResourceAvailable(r, iv('2026-11-16T16:00Z', '2026-11-16T17:00Z')).available).toBe(
      false,
    );
    expect(isResourceAvailable(r, iv('2026-11-16T15:00Z', '2026-11-16T16:00Z')).available).toBe(
      true,
    );
    expect(isResourceAvailable(r, iv('2026-11-16T17:00Z', '2026-11-16T18:00Z')).available).toBe(
      true,
    );
    expect(isResourceAvailable(r, iv('2026-11-16T15:30Z', '2026-11-16T16:30Z')).available).toBe(
      false,
    );
  });
  it('H · a competition-wide restriction intersects; competition blackouts apply to every resource', () => {
    const r = input(weekdays('06:00', '22:00'), {
      competition: {
        zone: CR,
        facts: [
          ...weekdays('10:00', '18:00'),
          {
            kind: 'BLACKOUT',
            startsAt: Z('2026-11-16T19:00Z'),
            endsAt: Z('2026-11-16T20:00Z'),
            reason: 'opening ceremony',
          },
        ],
      },
    });
    expect(effectiveAvailability(r, day.start, day.end)).toEqual([
      iv('2026-11-16T16:00Z', '2026-11-16T19:00Z'),
      iv('2026-11-16T20:00Z', '2026-11-17T00:00Z'),
    ]);
  });
  it('I · a RETIRED resource is never available, whatever its rules say', () => {
    expect(
      effectiveAvailability(input(regular, { status: 'RETIRED' }), day.start, day.end),
    ).toEqual([]);
  });
  it('no rule means no restriction: a resource without weekly windows is open all day', () => {
    expect(effectiveAvailability(input([]), day.start, day.end)).toEqual([day]);
  });
  it('windows crossing midnight, 24:00 ends and multi-day intervals', () => {
    const night = input([{ kind: 'WEEKLY', weekday: 1, start: '22:00', end: '02:00' }]);
    expect(effectiveAvailability(night, day.start, Z('2026-11-17T12:00Z'))).toEqual([
      iv('2026-11-17T04:00Z', '2026-11-17T08:00Z'),
    ]);
    const allDay = input(weekdays('00:00', '24:00'));
    expect(
      isResourceAvailable(allDay, iv('2026-11-16T06:00Z', '2026-11-30T06:00Z')).available,
    ).toBe(true); // 14 days, touching windows merged
  });
  it('a blackout covering the whole window leaves nothing; overlapping open exceptions are a union', () => {
    const r = input([
      ...regular,
      { kind: 'BLACKOUT', startsAt: day.start, endsAt: day.end, reason: 'facility closure' },
    ]);
    expect(effectiveAvailability(r, day.start, day.end)).toEqual([]);
    const u = input([
      { kind: 'DATE_OPEN', date: '2026-11-16', start: '08:00', end: '12:00' },
      { kind: 'DATE_OPEN', date: '2026-11-16', start: '11:00', end: '14:00' },
    ]);
    expect(effectiveAvailability(u, day.start, day.end)).toEqual([
      iv('2026-11-16T14:00Z', '2026-11-16T20:00Z'),
    ]);
  });
  it('validation: empty / reversed intervals, bad weekdays, dates and times are refused', () => {
    expect(
      validateAvailabilityFact({ kind: 'WEEKLY', weekday: 8, start: '08:00', end: '08:00' }).map(
        (i) => i.path,
      ),
    ).toEqual(['/weekday', '/end']);
    expect(
      validateAvailabilityFact({
        kind: 'BLACKOUT',
        startsAt: Z('2026-11-16T10:00Z'),
        endsAt: Z('2026-11-16T10:00Z'),
        reason: 'x',
      }),
    ).not.toEqual([]);
    expect(
      validateAvailabilityFact({
        kind: 'BLACKOUT',
        startsAt: Z('2026-11-16T10:00Z'),
        endsAt: Z('2026-11-16T11:00Z'),
        reason: ' ',
      }),
    ).not.toEqual([]);
    expect(
      validateAvailabilityFact({
        kind: 'DATE_OPEN',
        date: '2026-13-01',
        start: '25:00',
        end: '10:00',
      }),
    ).toHaveLength(2);
    expect(
      validateAvailabilityFact({
        kind: 'WEEKLY',
        weekday: 1,
        start: '00:00',
        end: '24:00',
        validFrom: '2026-12-01',
        validTo: '2026-11-01',
      }),
    ).not.toEqual([]);
  });
});

describe('generic resources: eight sports through one model (data, no sport code)', () => {
  const ok = (
    typeCode: string,
    attributes: Record<string, unknown>,
    capacity = 1,
    exclusivityKeys: string[] = [],
  ) =>
    validateResource({ typeCode, label: `${typeCode} 1`, attributes, capacity, exclusivityKeys });
  it('tennis, padel, road course, pool, cycling course, ten-pin lane pair, basketball court and golf course', () => {
    expect(ok('TENNIS_COURT', { surface: 'CLAY', indoor: false, lights: true })).toEqual([]);
    expect(ok('PADEL_COURT', { indoor: true })).toEqual([]);
    expect(ok('ROAD_COURSE', { distanceMeters: 42195, certified: true }, 500)).toEqual([]);
    expect(ok('POOL', { lanes: 8, lengthMeters: '50' })).toEqual([]);
    expect(ok('CYCLING_COURSE', { distanceMeters: 160000, lapLengthMeters: 12000 }, 200)).toEqual(
      [],
    );
    expect(ok('BOWLING_LANE_PAIR', { firstLane: 11, centerLabel: 'Center A' })).toEqual([]);
    expect(ok('BASKETBALL_COURT', { indoor: true }, 1, ['court-1-a', 'court-1-b'])).toEqual([]);
    expect(ok('GOLF_COURSE', { holes: '18', startingTees: [1, 10] }, 40)).toEqual([]);
  });
  it('closed vocabularies: unknown types, attributes and invalid values are refused', () => {
    expect(ok('SQUASH_COURT', {}).map((i) => i.path)).toEqual(['/typeCode']);
    expect(ok('POOL', { lanes: 20 })).toEqual([
      { path: '/attributes/lanes', message: 'an integer 1–12' },
    ]);
    expect(ok('TENNIS_COURT', { lanes: 8 })[0]?.path).toBe('/attributes/lanes');
    expect(ok('GOLF_COURSE', { startingTees: [1, 1] })).not.toEqual([]);
  });
  it('capacity: zero / negative / non-integer refused; 1 = EXCLUSIVE, N = SHARED_CAPACITY', () => {
    for (const capacity of [0, -1, 1.5, 100_001])
      expect(ok('TENNIS_COURT', {}, capacity).map((i) => i.path)).toContain('/capacity');
    expect(occupancyOf({ capacity: 1 })).toBe('EXCLUSIVE');
    expect(occupancyOf({ capacity: 500 })).toBe('SHARED_CAPACITY');
  });
  it('exclusivity keys: a full court overlaps each half court; the halves do not overlap each other', () => {
    const full = { id: 'full', exclusivityKeys: ['c1-a', 'c1-b'] };
    const halfA = { id: 'a', exclusivityKeys: ['c1-a'] };
    const halfB = { id: 'b', exclusivityKeys: ['c1-b'] };
    expect(sharesSpace(full, halfA)).toBe(true);
    expect(sharesSpace(full, halfB)).toBe(true);
    expect(sharesSpace(halfA, halfB)).toBe(false);
    expect(sharesSpace(halfA, { id: 'a', exclusivityKeys: [] })).toBe(true); // the same resource
    expect(ok('BASKETBALL_HALF_COURT', {}, 1, ['C1'])).not.toEqual([]);
  });
  it('labels and zones are validated', () => {
    expect(
      validateResource({
        typeCode: 'POOL',
        label: ' ',
        attributes: {},
        capacity: 1,
        exclusivityKeys: [],
      }),
    ).not.toEqual([]);
    expect(
      validateResource({
        typeCode: 'POOL',
        label: 'Pool',
        attributes: {},
        capacity: 1,
        exclusivityKeys: [],
        timezone: 'CST',
      })[0]?.path,
    ).toBe('/timezone');
  });
});
