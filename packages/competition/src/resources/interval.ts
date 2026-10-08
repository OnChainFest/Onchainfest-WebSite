/**
 * The one canonical interval primitive for scheduling (ONCF-05E, ADR-0068): half-open
 * [start, end) over epoch milliseconds. 09:00–10:00 and 10:00–11:00 do NOT overlap; 09:00–10:00
 * and 09:59–10:30 do. Every later 05E phase (conflicts, proposals) uses these functions; no store
 * or route compares intervals itself.
 */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

export function interval(start: number, end: number): Interval {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new RangeError('an interval needs end > start');
  return { start, end };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Sorted, disjoint union; touching intervals ([a,b) + [b,c)) merge into one. */
export function union(list: readonly Interval[]): Interval[] {
  const sorted = list
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.start <= last.end)
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, i.end) };
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** Intersection of two interval sets. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const x = union(a);
  const y = union(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const p = x[i] as Interval;
    const q = y[j] as Interval;
    const start = Math.max(p.start, q.start);
    const end = Math.min(p.end, q.end);
    if (end > start) out.push({ start, end });
    if (p.end < q.end) i += 1;
    else j += 1;
  }
  return out;
}

/** `a` minus every interval of `b`. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const cut = union(b);
  const out: Interval[] = [];
  for (const piece of union(a)) {
    let cursor = piece.start;
    for (const c of cut) {
      if (c.end <= cursor || c.start >= piece.end) continue;
      if (c.start > cursor) out.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
      if (cursor >= piece.end) break;
    }
    if (cursor < piece.end) out.push({ start: cursor, end: piece.end });
  }
  return out;
}

/** True when `set` covers every instant of `i` (no gap). */
export function covers(set: readonly Interval[], i: Interval): boolean {
  return subtract([i], set).length === 0;
}
