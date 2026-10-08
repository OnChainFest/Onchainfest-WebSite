/**
 * Server-side wall-clock ↔ instant conversion (ONCF-05E, ADR-0068). The authoritative conversion
 * for scheduling; the web helper is presentation only.
 *
 *   · A wall-clock time is a local date + time in an IANA zone, without an offset.
 *   · NORMAL   — exactly one instant has that wall-clock time.
 *   · SKIPPED  — no instant has it (spring-forward gap).
 *   · REPEATED — two instants have it (fall-back fold).
 * Recurring rules (`resolveRecurring`): SKIPPED moves forward by the gap; REPEATED takes the
 * earlier occurrence — deterministic, never an error. One-off input (`resolveStrict`): SKIPPED is
 * refused (LOCAL_TIME_SKIPPED); REPEATED is refused (LOCAL_TIME_AMBIGUOUS) unless an explicit
 * offset picks one of the two instants. Nothing is silently guessed.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** IANA zone: "Area/Location[/…]" or "UTC", known to the runtime's tz database. */
export function ianaZoneIssue(zone: string): string | undefined {
  if (zone !== 'UTC' && !/^[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(zone))
    return 'an IANA zone such as America/Costa_Rica (no abbreviations or bare offsets)';
  try {
    formatter(zone);
  } catch {
    return 'unknown IANA zone';
  }
  return undefined;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = cache.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    cache.set(zone, f);
  }
  return f;
}

/** The wall-clock time an instant shows in `zone`, encoded as UTC milliseconds. */
export function wallClockMs(instant: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
}

function offsetAt(instant: number, zone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockMs(whole, zone) - whole;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

/** "YYYY-MM-DD" + "HH:MM" (24:00 = next day 00:00) → wall-clock ms, or undefined when invalid. */
export function localMs(date: string, time: string): number | undefined {
  const d = DATE_RE.exec(date);
  if (d === null || !TIME_RE.test(time)) return undefined;
  const [h, m] = time.split(':').map(Number) as [number, number];
  const ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, m);
  const back = new Date(ms - h * 3_600_000 - m * MINUTE);
  // Reject impossible dates (2026-02-30) by round-tripping the date part.
  if (
    back.getUTCFullYear() !== Number(d[1]) ||
    back.getUTCMonth() !== Number(d[2]) - 1 ||
    back.getUTCDate() !== Number(d[3])
  )
    return undefined;
  return ms;
}

export function isLocalDate(date: string): boolean {
  return localMs(date, '00:00') !== undefined;
}

export function isLocalTime(time: string): boolean {
  return TIME_RE.test(time);
}

/** Minutes after midnight ("24:00" → 1440). */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function addDays(date: string, days: number): string {
  const ms = localMs(date, '00:00') as number;
  return new Date(ms + days * DAY).toISOString().slice(0, 10);
}

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(localMs(date, '00:00') as number).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The local date an instant falls on in `zone`. */
export function localDateOf(instant: number, zone: string): string {
  return new Date(wallClockMs(instant, zone)).toISOString().slice(0, 10);
}

export type Resolution =
  | { readonly kind: 'NORMAL'; readonly instants: readonly [number] }
  | { readonly kind: 'REPEATED'; readonly instants: readonly [number, number] }
  | { readonly kind: 'SKIPPED'; readonly instants: readonly []; readonly gapMinutes: number };

/** Every instant whose wall-clock time in `zone` is `wall` (wall-clock ms). */
export function resolve(wall: number, zone: string): Resolution {
  const offsets = [
    ...new Set([offsetAt(wall - DAY, zone), offsetAt(wall, zone), offsetAt(wall + DAY, zone)]),
  ];
  const valid = [
    ...new Set(offsets.map((o) => wall - o).filter((t) => wallClockMs(t, zone) === wall)),
  ].sort((a, b) => a - b);
  if (valid.length === 1) return { kind: 'NORMAL', instants: [valid[0] as number] };
  if (valid.length >= 2)
    return { kind: 'REPEATED', instants: [valid[0] as number, valid[valid.length - 1] as number] };
  const before = offsetAt(wall - DAY, zone);
  const after = offsetAt(wall + DAY, zone);
  return { kind: 'SKIPPED', instants: [], gapMinutes: Math.round((after - before) / MINUTE) };
}

/** Recurring-rule resolution: skipped → forward by the gap; repeated → earlier occurrence. */
export function resolveRecurring(wall: number, zone: string): number {
  const r = resolve(wall, zone);
  if (r.kind !== 'SKIPPED') return r.instants[0];
  // The offset in force before the gap maps the missing wall time to (wall + gap).
  return wall - offsetAt(wall - DAY, zone);
}

export type StrictResolution =
  | { readonly ok: true; readonly instant: number }
  | {
      readonly ok: false;
      readonly code:
        'LOCAL_TIME_SKIPPED' | 'LOCAL_TIME_AMBIGUOUS' | 'OFFSET_MISMATCH' | 'INVALID_LOCAL_TIME';
    };

/**
 * One-off organizer input. `offsetMinutes` (e.g. -300 for UTC-05:00) is optional; when given it
 * must be the zone's real offset at that wall-clock time, and it disambiguates a repeated time.
 */
export function resolveStrict(
  date: string,
  time: string,
  zone: string,
  offsetMinutes?: number,
): StrictResolution {
  const wall = localMs(date, time);
  if (wall === undefined || time === '24:00') return { ok: false, code: 'INVALID_LOCAL_TIME' };
  const r = resolve(wall, zone);
  if (r.kind === 'SKIPPED') return { ok: false, code: 'LOCAL_TIME_SKIPPED' };
  if (offsetMinutes !== undefined) {
    const match = r.instants.find((t) => wall - t === offsetMinutes * MINUTE);
    return match === undefined
      ? { ok: false, code: 'OFFSET_MISMATCH' }
      : { ok: true, instant: match };
  }
  if (r.kind === 'REPEATED') return { ok: false, code: 'LOCAL_TIME_AMBIGUOUS' };
  return { ok: true, instant: r.instants[0] };
}
