import { intersect, subtract, union, covers, type Interval } from './interval';
import {
  addDays,
  isLocalDate,
  isLocalTime,
  isoWeekday,
  localDateOf,
  localMs,
  minutesOf,
  resolveRecurring,
} from './zoned';

/**
 * Resource availability (ONCF-05E-A, ADR-0068). Availability answers ONE question: "can this
 * resource be used during this interval?" — never "is it assigned to a contest?" (occupancy is
 * derived from schedules, 05E-C).
 *
 * Facts (all append-only; a revoked fact no longer applies):
 *   WEEKLY       local weekday window (start–end; end ≤ start crosses midnight; 24:00 = end of day),
 *                optional validity date range, in the layer's IANA zone
 *   DATE_OPEN    a local date's window(s) that REPLACE the weekly windows for that date
 *   DATE_CLOSED  the local date is closed (wins over DATE_OPEN on the same date)
 *   BLACKOUT / MAINTENANCE  an absolute UTC interval with a reason
 * Layers: the resource's own facts (in its zone) and competition-wide facts (resource-less, in the
 * competition zone) that restrict every resource.
 *
 * Precedence (encoded below, never left to call order):
 *   1. a RETIRED resource is never available;
 *   2. per local date and layer: DATE_CLOSED > DATE_OPEN > WEEKLY; a layer with no WEEKLY window at
 *      all is open all day on dates without an exception (no rule = no restriction);
 *   3. effective = resource layer ∩ competition layer;
 *   4. minus every BLACKOUT / MAINTENANCE (resource and competition-wide).
 * Wall-clock → instant uses the recurring rule of ADR-0068 (skipped → forward by the gap;
 * repeated → earlier occurrence).
 */

export type AvailabilityFact =
  | {
      readonly kind: 'WEEKLY';
      readonly weekday: number;
      readonly start: string;
      readonly end: string;
      readonly validFrom?: string;
      readonly validTo?: string;
    }
  | {
      readonly kind: 'DATE_OPEN';
      readonly date: string;
      readonly start: string;
      readonly end: string;
    }
  | { readonly kind: 'DATE_CLOSED'; readonly date: string }
  | {
      readonly kind: 'BLACKOUT' | 'MAINTENANCE';
      readonly startsAt: number;
      readonly endsAt: number;
      readonly reason: string;
    };

export interface AvailabilityIssue {
  readonly path: string;
  readonly message: string;
}

export function validateAvailabilityFact(f: AvailabilityFact): AvailabilityIssue[] {
  const out: AvailabilityIssue[] = [];
  const window = (start: string, end: string) => {
    if (!isLocalTime(start) || start === '24:00')
      out.push({ path: '/start', message: 'HH:MM (00:00–23:59)' });
    if (!isLocalTime(end)) out.push({ path: '/end', message: 'HH:MM (00:01–24:00)' });
    else if (isLocalTime(start) && minutesOf(start) === minutesOf(end) % 1440 && end !== '24:00')
      out.push({ path: '/end', message: 'a window cannot be empty' });
  };
  switch (f.kind) {
    case 'WEEKLY':
      if (!Number.isInteger(f.weekday) || f.weekday < 1 || f.weekday > 7)
        out.push({ path: '/weekday', message: '1 (Monday) – 7 (Sunday)' });
      window(f.start, f.end);
      if (f.validFrom !== undefined && !isLocalDate(f.validFrom))
        out.push({ path: '/validFrom', message: 'YYYY-MM-DD' });
      if (f.validTo !== undefined && !isLocalDate(f.validTo))
        out.push({ path: '/validTo', message: 'YYYY-MM-DD' });
      if (f.validFrom !== undefined && f.validTo !== undefined && f.validTo < f.validFrom)
        out.push({ path: '/validTo', message: 'on or after validFrom' });
      break;
    case 'DATE_OPEN':
      if (!isLocalDate(f.date)) out.push({ path: '/date', message: 'YYYY-MM-DD' });
      window(f.start, f.end);
      break;
    case 'DATE_CLOSED':
      if (!isLocalDate(f.date)) out.push({ path: '/date', message: 'YYYY-MM-DD' });
      break;
    case 'BLACKOUT':
    case 'MAINTENANCE':
      if (!Number.isFinite(f.startsAt) || !Number.isFinite(f.endsAt) || f.endsAt <= f.startsAt)
        out.push({ path: '/endsAt', message: 'after startsAt' });
      if (f.reason.trim().length === 0 || f.reason.length > 500)
        out.push({ path: '/reason', message: '1–500 characters' });
      break;
  }
  return out;
}

export interface AvailabilityLayer {
  /** IANA zone the layer's local rules are written in. */
  readonly zone: string;
  readonly facts: readonly AvailabilityFact[];
}

export interface AvailabilityInput {
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly resource: AvailabilityLayer;
  readonly competition: AvailabilityLayer;
}

/** The local window [start, end) of `date` as instants (end ≤ start or 24:00 → next day). */
function windowInstants(
  date: string,
  start: string,
  end: string,
  zone: string,
): Interval | undefined {
  const s = localMs(date, start) as number;
  const crosses = end !== '24:00' && minutesOf(end) <= minutesOf(start);
  const e = localMs(crosses ? addDays(date, 1) : date, end) as number;
  const a = resolveRecurring(s, zone);
  const b = resolveRecurring(e, zone);
  return b > a ? { start: a, end: b } : undefined;
}

/** Open intervals of one layer over [from, to), before blackouts. */
function layerOpen(layer: AvailabilityLayer, from: number, to: number): Interval[] {
  const weekly = layer.facts.filter(
    (f): f is Extract<AvailabilityFact, { kind: 'WEEKLY' }> => f.kind === 'WEEKLY',
  );
  const open = layer.facts.filter(
    (f): f is Extract<AvailabilityFact, { kind: 'DATE_OPEN' }> => f.kind === 'DATE_OPEN',
  );
  const closed = new Set(layer.facts.flatMap((f) => (f.kind === 'DATE_CLOSED' ? [f.date] : [])));
  const out: Interval[] = [];
  // One day of padding on each side: a window of the previous local date may cross midnight.
  const first = addDays(localDateOf(from, layer.zone), -1);
  const last = addDays(localDateOf(to, layer.zone), 1);
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (closed.has(date)) continue;
    const exceptions = open.filter((f) => f.date === date);
    const windows: { start: string; end: string }[] =
      exceptions.length > 0
        ? exceptions
        : weekly.length === 0
          ? [{ start: '00:00', end: '24:00' }]
          : weekly.filter(
              (w) =>
                w.weekday === isoWeekday(date) &&
                (w.validFrom === undefined || date >= w.validFrom) &&
                (w.validTo === undefined || date <= w.validTo),
            );
    for (const w of windows) {
      const i = windowInstants(date, w.start, w.end, layer.zone);
      if (i !== undefined) out.push(i);
    }
  }
  return intersect(union(out), [{ start: from, end: to }]);
}

function blackouts(layer: AvailabilityLayer): Interval[] {
  return layer.facts.flatMap((f) =>
    f.kind === 'BLACKOUT' || f.kind === 'MAINTENANCE' ? [{ start: f.startsAt, end: f.endsAt }] : [],
  );
}

/** Effective available intervals over [from, to) (sorted, disjoint, touching intervals merged). */
export function effectiveAvailability(
  input: AvailabilityInput,
  from: number,
  to: number,
): Interval[] {
  if (input.status !== 'ACTIVE' || to <= from) return [];
  const open = intersect(
    layerOpen(input.resource, from, to),
    layerOpen(input.competition, from, to),
  );
  return subtract(open, [...blackouts(input.resource), ...blackouts(input.competition)]);
}

/**
 * Is the resource intrinsically available for the whole interval? Resource availability only —
 * NOT scheduled contests, participants or dependencies (later 05E phases).
 */
export function isResourceAvailable(
  input: AvailabilityInput,
  i: Interval,
): { available: boolean; gaps: Interval[] } {
  const avail = effectiveAvailability(input, i.start, i.end);
  return { available: covers(avail, i), gaps: subtract([i], avail) };
}
