import type { AuthErrorCode } from './auth/messages';
import { apiRequest, type ApiResult } from './platform';
import { instantToZoned, validTimeZone, zonedToInstant } from './tournament-builder';
import {
  catalogDiscipline,
  type Catalog,
  type CompetitionStatus,
  type ManagedEvent,
} from './tournaments';

/**
 * ONCF-L2 resources and availability for the organizer area. Shapes mirror the ONCF-05E-A API
 * (`ResourceStore` in @br/persistence); every rule — validation, label uniqueness, precedence,
 * permissions, closed competitions — is decided by the API. What lives here is presentation and
 * form parsing, plus two mirrors of domain data that a test compares with @br/competition:
 *   · RESOURCE_TYPE_ATTRIBUTES / RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE (closed per-type schema);
 *   · `layerDeclares` (ADR-0074 D8 `layerDeclared`): only WEEKLY or DATE_OPEN facts declare time.
 *     The availability endpoints treat an undeclared layer as unrestricted, but scheduling never
 *     places a contest in undeclared time (NO_DECLARED_TIME), so "no rules" is shown as a problem.
 */

// ───────────────────────────── API shapes ─────────────────────────────

export type ResourceStatus = 'ACTIVE' | 'RETIRED';
export type OccupancyMode = 'EXCLUSIVE' | 'SHARED';

export interface ResourceView {
  resourceId: string;
  competitionId: string;
  typeCode: string;
  revision: number;
  label: string;
  attributes: Record<string, unknown>;
  capacity: number;
  occupancyMode: OccupancyMode;
  exclusivityKeys: string[];
  venueOrganizationId: string | null;
  locationLabel: string | null;
  timezone: string | null;
  status: ResourceStatus;
  updatedAt: string;
}

export type AvailabilityKind = 'WEEKLY' | 'DATE_OPEN' | 'DATE_CLOSED' | 'BLACKOUT' | 'MAINTENANCE';

export interface AvailabilityFactView {
  availabilityId: string;
  scope: 'COMPETITION' | 'RESOURCE';
  resourceId: string | null;
  kind: AvailabilityKind;
  weekday?: number;
  date?: string;
  start?: string;
  end?: string;
  validFrom?: string;
  validTo?: string;
  startsAt?: string;
  endsAt?: string;
  reason?: string;
  recordedAt: string;
}

export interface EffectiveAvailability {
  resourceId: string;
  timezone: string;
  status: ResourceStatus;
  intervals: { start: string; end: string }[];
}

export function competitionResources(
  token: string,
  competitionId: string,
): Promise<ApiResult<{ items: ResourceView[] }>> {
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/resources`);
}

/** Every current fact of the competition: each resource's and the competition-wide layer. */
export function competitionAvailability(
  token: string,
  competitionId: string,
): Promise<ApiResult<{ items: AvailabilityFactView[] }>> {
  return apiRequest(token, 'GET', `/v1/competitions/${competitionId}/availability`);
}

export function effectiveAvailability(
  token: string,
  resourceId: string,
  from: string,
  to: string,
): Promise<ApiResult<EffectiveAvailability>> {
  const q = new URLSearchParams({ from, to });
  return apiRequest(token, 'GET', `/v1/resources/${resourceId}/availability?${q.toString()}`);
}

/** The permission the resource store checks for every change (reads need COMP_VIEW_PRIVATE). */
export const canManageResources = (permissions: readonly string[]) =>
  permissions.includes('COMP_EDIT');

/** The store refuses every change once the competition is COMPLETED or CANCELLED. */
export const resourcesClosed = (status: CompetitionStatus) =>
  status === 'COMPLETED' || status === 'CANCELLED';

// ───────────────────────────── vocabulary (mirrors @br/competition) ─────────────────────────────

export const RESOURCE_TYPES = [
  'TENNIS_COURT',
  'PADEL_COURT',
  'BASKETBALL_COURT',
  'BASKETBALL_HALF_COURT',
  'BOWLING_LANE_PAIR',
  'POOL',
  'TRACK',
  'ROAD_COURSE',
  'OPEN_WATER_COURSE',
  'CYCLING_COURSE',
  'GOLF_COURSE',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const isResourceType = (v: string): v is ResourceType =>
  (RESOURCE_TYPES as readonly string[]).includes(v);

export const RESOURCE_TYPE_LABEL: Record<ResourceType, { one: string; many: string }> = {
  TENNIS_COURT: { one: 'Tennis court', many: 'Tennis courts' },
  PADEL_COURT: { one: 'Padel court', many: 'Padel courts' },
  BASKETBALL_COURT: { one: 'Basketball court', many: 'Basketball courts' },
  BASKETBALL_HALF_COURT: { one: 'Basketball half court', many: 'Basketball half courts' },
  BOWLING_LANE_PAIR: { one: 'Bowling lane pair', many: 'Bowling lane pairs' },
  POOL: { one: 'Pool', many: 'Pools' },
  TRACK: { one: 'Track', many: 'Tracks' },
  ROAD_COURSE: { one: 'Road course', many: 'Road courses' },
  OPEN_WATER_COURSE: { one: 'Open-water course', many: 'Open-water courses' },
  CYCLING_COURSE: { one: 'Cycling course', many: 'Cycling courses' },
  GOLF_COURSE: { one: 'Golf course', many: 'Golf courses' },
};

export const typeLabel = (code: string, n = 1) =>
  isResourceType(code) ? RESOURCE_TYPE_LABEL[code][n === 1 ? 'one' : 'many'] : code;

export type AttributeSpec =
  | { readonly kind: 'INT'; readonly min: number; readonly max: number }
  | { readonly kind: 'BOOL' }
  | { readonly kind: 'ENUM'; readonly values: readonly string[] }
  | {
      readonly kind: 'INT_LIST';
      readonly min: number;
      readonly max: number;
      readonly maxItems: number;
    }
  | { readonly kind: 'TEXT'; readonly maxLength: number };

/** Closed per-type attribute schema — the same data as RESOURCE_TYPE_ATTRIBUTES in @br/competition. */
export const RESOURCE_TYPE_ATTRIBUTES: Readonly<
  Record<ResourceType, Readonly<Record<string, AttributeSpec>>>
> = {
  TENNIS_COURT: {
    surface: { kind: 'ENUM', values: ['HARD', 'CLAY', 'GRASS', 'CARPET', 'OTHER'] },
    indoor: { kind: 'BOOL' },
    lights: { kind: 'BOOL' },
  },
  PADEL_COURT: { indoor: { kind: 'BOOL' }, lights: { kind: 'BOOL' } },
  BASKETBALL_COURT: { indoor: { kind: 'BOOL' } },
  BASKETBALL_HALF_COURT: { indoor: { kind: 'BOOL' } },
  BOWLING_LANE_PAIR: {
    firstLane: { kind: 'INT', min: 1, max: 199 },
    centerLabel: { kind: 'TEXT', maxLength: 60 },
  },
  POOL: {
    lanes: { kind: 'INT', min: 1, max: 12 },
    lengthMeters: { kind: 'ENUM', values: ['25', '50'] },
    indoor: { kind: 'BOOL' },
  },
  TRACK: {
    lanes: { kind: 'INT', min: 4, max: 10 },
    lengthMeters: { kind: 'ENUM', values: ['200', '400'] },
  },
  ROAD_COURSE: {
    distanceMeters: { kind: 'INT', min: 100, max: 500_000 },
    certified: { kind: 'BOOL' },
  },
  OPEN_WATER_COURSE: { distanceMeters: { kind: 'INT', min: 100, max: 100_000 } },
  CYCLING_COURSE: {
    distanceMeters: { kind: 'INT', min: 100, max: 500_000 },
    lapLengthMeters: { kind: 'INT', min: 100, max: 100_000 },
  },
  GOLF_COURSE: {
    holes: { kind: 'ENUM', values: ['9', '18'] },
    startingTees: { kind: 'INT_LIST', min: 1, max: 18, maxItems: 2 },
  },
};

/** The API's write-time default when `occupancyMode` is omitted (mirrors @br/competition). */
export const RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE: Readonly<Record<ResourceType, OccupancyMode>> = {
  TENNIS_COURT: 'EXCLUSIVE',
  PADEL_COURT: 'EXCLUSIVE',
  BASKETBALL_COURT: 'EXCLUSIVE',
  BASKETBALL_HALF_COURT: 'EXCLUSIVE',
  BOWLING_LANE_PAIR: 'EXCLUSIVE',
  POOL: 'EXCLUSIVE',
  TRACK: 'EXCLUSIVE',
  ROAD_COURSE: 'SHARED',
  OPEN_WATER_COURSE: 'SHARED',
  CYCLING_COURSE: 'SHARED',
  GOLF_COURSE: 'SHARED',
};

/** Organizer wording for each attribute; BOOL attributes name their two answers. */
export const ATTRIBUTE_LABEL: Record<
  string,
  { label: string; yes?: string; no?: string; hint?: string; values?: Record<string, string> }
> = {
  surface: {
    label: 'Surface',
    values: { HARD: 'Hard', CLAY: 'Clay', GRASS: 'Grass', CARPET: 'Carpet', OTHER: 'Other' },
  },
  indoor: { label: 'Indoor or outdoor', yes: 'Indoor', no: 'Outdoor' },
  lights: { label: 'Lights', yes: 'Has lights', no: 'No lights' },
  firstLane: { label: 'First lane number' },
  centerLabel: { label: 'Bowling centre' },
  lanes: { label: 'Lanes' },
  lengthMeters: {
    label: 'Length',
    values: { '25': '25 m', '50': '50 m', '200': '200 m', '400': '400 m' },
  },
  distanceMeters: { label: 'Distance (metres)' },
  certified: { label: 'Certification', yes: 'Certified course', no: 'Not certified' },
  lapLengthMeters: { label: 'Lap length (metres)' },
  holes: { label: 'Holes', values: { '9': '9 holes', '18': '18 holes' } },
  startingTees: { label: 'Starting tees', hint: 'One or two hole numbers, e.g. 1, 10' },
};

/** A stored attribute value as organizer text ("Indoor", "Clay", "1, 10"). */
export function attributeText(key: string, value: unknown): string {
  const l = ATTRIBUTE_LABEL[key];
  if (typeof value === 'boolean') return (value ? l?.yes : l?.no) ?? (value ? 'Yes' : 'No');
  if (Array.isArray(value)) return value.join(', ');
  const s = String(value);
  return l?.values?.[s] ?? s;
}

export const OCCUPANCY_LABEL: Record<OccupancyMode, { label: string; detail: string }> = {
  EXCLUSIVE: { label: 'Exclusive', detail: 'One match or session at a time' },
  SHARED: { label: 'Shared', detail: 'Several starts at once, within its capacity' },
};

// ───────────────────────────── readiness (mirrors ADR-0074 D8) ─────────────────────────────

/**
 * Does a layer DECLARE time? Exactly `layerDeclared` in @br/competition: any WEEKLY fact declares
 * all time; otherwise only DATE_OPEN dates do. DATE_CLOSED and blackouts never declare anything.
 */
export function layerDeclares(facts: readonly Pick<AvailabilityFactView, 'kind'>[]): boolean {
  return facts.some((f) => f.kind === 'WEEKLY' || f.kind === 'DATE_OPEN');
}

export type Readiness = 'ready' | 'no-hours' | 'retired';

export const READINESS_LABEL: Record<Readiness, { label: string; detail: string }> = {
  ready: {
    label: 'Hours declared',
    detail: 'Scheduling can use it during its declared hours.',
  },
  'no-hours': {
    label: 'No declared hours',
    detail: 'This resource will not be used by scheduling until hours are declared.',
  },
  retired: { label: 'Retired', detail: 'Never used by scheduling while retired.' },
};

/** A resource's own facts and the competition-wide layer, split from one competition listing. */
export function layersOf(facts: readonly AvailabilityFactView[], resourceId: string) {
  return {
    own: facts.filter((f) => f.resourceId === resourceId),
    competition: facts.filter((f) => f.resourceId === null),
  };
}

export function readinessOf(
  resource: Pick<ResourceView, 'resourceId' | 'status'>,
  facts: readonly AvailabilityFactView[],
): Readiness {
  if (resource.status === 'RETIRED') return 'retired';
  const { own, competition } = layersOf(facts, resource.resourceId);
  return layerDeclares(own) || layerDeclares(competition) ? 'ready' : 'no-hours';
}

/** The resource types the competition's categories can use, from the catalog's disciplines. */
export function categoryResourceTypes(
  events: readonly ManagedEvent[],
  catalog: Catalog | null,
): { event: ManagedEvent; types: ResourceType[] }[] {
  if (catalog === null) return [];
  return events
    .filter((e) => e.status !== 'CANCELLED')
    .map((event) => {
      const d = catalogDiscipline(catalog, event.discipline.code, event.discipline.version);
      return { event, types: (d?.capabilities?.resourceTypes ?? []).filter(isResourceType) };
    })
    .filter((x) => x.types.length > 0);
}

/** Types offered when adding a resource: the categories' types, or all of them when unknown. */
export function offeredTypes(needs: ReturnType<typeof categoryResourceTypes>): {
  types: ResourceType[];
  restricted: boolean;
} {
  const wanted = new Set(needs.flatMap((n) => n.types));
  return wanted.size === 0
    ? { types: [...RESOURCE_TYPES], restricted: false }
    : { types: RESOURCE_TYPES.filter((t) => wanted.has(t)), restricted: true };
}

export interface ResourceSummary {
  readonly active: number;
  readonly retired: number;
  readonly ready: number;
  /** ACTIVE resources without declared hours, by label. */
  readonly needHours: readonly string[];
  /** Categories with no ACTIVE resource of any type their discipline can use. */
  readonly missing: readonly { category: string; types: readonly ResourceType[] }[];
}

export function resourceSummary(
  resources: readonly ResourceView[],
  facts: readonly AvailabilityFactView[],
  needs: ReturnType<typeof categoryResourceTypes>,
): ResourceSummary {
  const active = resources.filter((r) => r.status === 'ACTIVE');
  const needHours = active.filter((r) => readinessOf(r, facts) === 'no-hours');
  const activeTypes = new Set(active.map((r) => r.typeCode));
  return {
    active: active.length,
    retired: resources.length - active.length,
    ready: active.length - needHours.length,
    needHours: needHours.map((r) => r.label),
    missing: needs
      .filter((n) => !n.types.some((t) => activeTypes.has(t)))
      .map((n) => ({ category: n.event.settings.name, types: n.types })),
  };
}

// ───────────────────────────── hours presentation ─────────────────────────────

export const WEEKDAYS = [
  { n: 1, short: 'Mon', long: 'Monday' },
  { n: 2, short: 'Tue', long: 'Tuesday' },
  { n: 3, short: 'Wed', long: 'Wednesday' },
  { n: 4, short: 'Thu', long: 'Thursday' },
  { n: 5, short: 'Fri', long: 'Friday' },
  { n: 6, short: 'Sat', long: 'Saturday' },
  { n: 7, short: 'Sun', long: 'Sunday' },
] as const;

const dayShort = (n: number) => WEEKDAYS[n - 1]?.short ?? String(n);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** "08:00–18:00", "22:00–02:00 next day"; 24:00 stays as declared (end of day). */
export function windowText(start: string, end: string): string {
  return end !== '24:00' && minutes(end) <= minutes(start)
    ? `${start}–${end} next day`
    : `${start}–${end}`;
}

/** A local date as "Sat 24 Oct" (+ " 2026" with `year`), in that order and without commas. */
function dateFmt(date: string, year = false): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(year ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).formatToParts(new Date(`${date}T00:00:00Z`));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return [get('weekday'), get('day'), get('month'), ...(year ? [get('year')] : [])].join(' ');
}

/** "Sat 24 Oct 2026" for a local date. */
export const dateText = (date: string) => dateFmt(date, true);

export interface WeeklyRow {
  readonly days: string;
  readonly windows: readonly string[];
  readonly validity: string | null;
}

/**
 * Weekly facts as rows a person reads at a glance: identical windows on consecutive weekdays merge
 * ("Mon–Fri 08:00–18:00"); a validity range keeps its own rows. Nothing is computed beyond display.
 */
export function weeklySummary(facts: readonly AvailabilityFactView[]): WeeklyRow[] {
  const weekly = facts.filter((f) => f.kind === 'WEEKLY');
  const groups = new Map<string, Map<number, string[]>>();
  for (const f of weekly) {
    const key = `${f.validFrom ?? ''}|${f.validTo ?? ''}`;
    const byDay = groups.get(key) ?? new Map<number, string[]>();
    const list = byDay.get(f.weekday ?? 0) ?? [];
    list.push(`${f.start ?? ''}|${f.end ?? ''}`);
    byDay.set(f.weekday ?? 0, list);
    groups.set(key, byDay);
  }
  const rows: WeeklyRow[] = [];
  for (const key of [...groups.keys()].sort()) {
    const byDay = groups.get(key) as Map<number, string[]>;
    const [from, until] = key.split('|') as [string, string];
    const validity =
      from === '' && until === ''
        ? null
        : from === ''
          ? `until ${dateText(until)}`
          : until === ''
            ? `from ${dateText(from)}`
            : `${dateText(from)} – ${dateText(until)}`;
    const sig = (d: number) => {
      const ws = [...new Set(byDay.get(d) ?? [])].sort((a, b) => minutes(a) - minutes(b));
      return ws.join(',');
    };
    let d = 1;
    while (d <= 7) {
      const s = sig(d);
      if (s === '') {
        d += 1;
        continue;
      }
      let last = d;
      while (last < 7 && sig(last + 1) === s) last += 1;
      rows.push({
        days:
          last === d
            ? dayShort(d)
            : last === d + 1
              ? `${dayShort(d)}, ${dayShort(last)}`
              : `${dayShort(d)}–${dayShort(last)}`,
        windows: s.split(',').map((w) => {
          const [a, b] = w.split('|') as [string, string];
          return windowText(a, b);
        }),
        validity,
      });
      d = last + 1;
    }
  }
  return rows;
}

/** One-line weekly summary for list rows ("Mon–Fri 08:00–18:00 · Sat 09:00–14:00"). */
export function weeklyLine(facts: readonly AvailabilityFactView[]): string | null {
  const rows = weeklySummary(facts);
  return rows.length === 0
    ? null
    : rows
        .map(
          (r) =>
            `${r.days} ${r.windows.join(', ')}${r.validity === null ? '' : ` (${r.validity})`}`,
        )
        .join(' · ');
}

/** A blackout/maintenance period in a zone: "Fri 23 Oct 14:00 – 16:00". */
export function periodText(startsAt: string, endsAt: string, zone: string): string {
  const a = instantToZoned(startsAt, zone);
  const b = instantToZoned(endsAt, zone);
  if (a === '' || b === '') return `${startsAt} – ${endsAt}`;
  const day = (local: string) => dateFmt(local.slice(0, 10));
  return a.slice(0, 10) === b.slice(0, 10)
    ? `${day(a)} ${a.slice(11)} – ${b.slice(11)}`
    : `${day(a)} ${a.slice(11)} – ${day(b)} ${b.slice(11)}`;
}

// ───────────────────────────── local dates and the 7-day preview ─────────────────────────────

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** The first previewed local date: the tournament's start, else today, in `zone`. */
export function previewAnchor(startsAt: string | null, zone: string, now: number): string {
  const local = instantToZoned(startsAt ?? new Date(now).toISOString(), zone);
  return local === '' ? new Date(now).toISOString().slice(0, 10) : local.slice(0, 10);
}

/** Start of a local date as an instant (a range bound, so the lenient converter is right here). */
export function dayStart(date: string, zone: string): string | null {
  const v = zonedToInstant(`${date}T00:00`, zone);
  return typeof v === 'string' ? v : null;
}

export interface PreviewDay {
  readonly date: string;
  readonly label: string;
  readonly windows: readonly string[];
}

/** Effective UTC intervals regrouped per local day in `zone` ("08:00–18:00"; "24:00" at midnight). */
export function previewDays(
  intervals: readonly { start: string; end: string }[],
  anchor: string,
  zone: string,
  days = 7,
): PreviewDay[] {
  const out: PreviewDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(anchor, i);
    const s = dayStart(date, zone);
    const e = dayStart(addDays(date, 1), zone);
    const windows: string[] = [];
    if (s !== null && e !== null) {
      const [ds, de] = [Date.parse(s), Date.parse(e)];
      for (const iv of intervals) {
        const a = Math.max(ds, Date.parse(iv.start));
        const b = Math.min(de, Date.parse(iv.end));
        if (b <= a) continue;
        const from = instantToZoned(new Date(a).toISOString(), zone).slice(11);
        const to = b === de ? '24:00' : instantToZoned(new Date(b).toISOString(), zone).slice(11);
        windows.push(`${from}–${to}`);
      }
    }
    out.push({
      date,
      label: dateFmt(date),
      windows,
    });
  }
  return out;
}

// ───────────────────────────── strict local time → instant (R1) ─────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isLocalDate = (v: string) => {
  const m = DATE_RE.exec(v);
  if (m === null) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
export const isLocalTime = (v: string) => TIME_RE.test(v);

/**
 * An IANA zone the resource API accepts: "Area/Location[/…]" or "UTC", known to the runtime — the
 * same rule as `ianaZoneIssue` in @br/competition (abbreviations such as CST are refused).
 */
export const isIanaZone = (zone: string) =>
  (zone === 'UTC' || /^[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(zone)) &&
  validTimeZone(zone);

export type StrictInstant =
  | { kind: 'ok'; instant: string }
  | { kind: 'invalid' }
  | { kind: 'skipped' }
  | { kind: 'ambiguous' };

/**
 * A one-off local date + time in `zone` → the one UTC instant it names (ISO-8601, `Z`). Strict, as
 * ADR-0068 requires for one-off input: a time inside a DST gap does not exist and is refused; a
 * time inside a DST fold names two instants and is refused. Nothing is shifted or guessed.
 */
export function strictLocalInstant(date: string, time: string, zone: string): StrictInstant {
  if (!isLocalDate(date) || !isLocalTime(time) || !isIanaZone(zone)) return { kind: 'invalid' };
  const local = `${date}T${time}`;
  const wall = Date.parse(`${local}:00Z`);
  const offsetAt = (t: number) => {
    const shown = instantToZoned(new Date(t).toISOString(), zone);
    return Date.parse(`${shown}:00Z`) - Math.floor(t / 60_000) * 60_000;
  };
  // Offsets around the wall time cover both sides of any transition within a day.
  const offsets = new Set([
    offsetAt(wall - 86_400_000),
    offsetAt(wall),
    offsetAt(wall + 86_400_000),
  ]);
  const hits = [...offsets]
    .map((o) => wall - o)
    .filter((t, i, all) => all.indexOf(t) === i)
    .filter((t) => instantToZoned(new Date(t).toISOString(), zone) === local);
  if (hits.length === 0) return { kind: 'skipped' };
  if (hits.length > 1) return { kind: 'ambiguous' };
  return { kind: 'ok', instant: new Date(hits[0] as number).toISOString() };
}

// ───────────────────────────── form parsing ─────────────────────────────

type Form = {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
};
const text = (form: Form, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The complete body of POST /resources (with `typeCode`) and PUT /resources/:id (without). */
export interface ResourceBody {
  label: string;
  attributes: Record<string, unknown>;
  capacity: number;
  occupancyMode: OccupancyMode;
  exclusivityKeys: string[];
  venueOrganizationId: string | null;
  locationLabel: string | null;
  timezone: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: AuthErrorCode };

/** One attribute from its form field (`attr.<key>`); '' = not specified (omitted). */
function attributeValue(spec: AttributeSpec, raw: string): { ok: boolean; value?: unknown } {
  if (raw === '') return { ok: true };
  switch (spec.kind) {
    case 'BOOL':
      return raw === 'true' || raw === 'false'
        ? { ok: true, value: raw === 'true' }
        : { ok: false };
    case 'ENUM':
      return spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false };
    case 'INT': {
      const n = Number(raw);
      return Number.isInteger(n) && n >= spec.min && n <= spec.max
        ? { ok: true, value: n }
        : { ok: false };
    }
    case 'TEXT':
      return raw.length <= spec.maxLength ? { ok: true, value: raw } : { ok: false };
    case 'INT_LIST': {
      const xs = raw
        .split(/[\s,]+/)
        .filter((x) => x !== '')
        .map(Number);
      return xs.length >= 1 &&
        xs.length <= spec.maxItems &&
        new Set(xs).size === xs.length &&
        xs.every((x) => Number.isInteger(x) && x >= spec.min && x <= spec.max)
        ? { ok: true, value: xs }
        : { ok: false };
    }
  }
}

/**
 * The resource form → the COMPLETE body. PUT /v1/resources/:id replaces every field (an omitted
 * field resets to its default), so edits must always send all of them; the venue organization is
 * not editable here and travels unchanged in a hidden field.
 */
export function parseResourceForm(form: Form, typeCode: ResourceType): Parsed<ResourceBody> {
  const label = text(form, 'label');
  if (label.length < 1 || label.length > 80) return { ok: false, error: 'resource_label' };
  const capRaw = text(form, 'capacity');
  const capacity = capRaw === '' ? 1 : Number(capRaw);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000)
    return { ok: false, error: 'resource_invalid' };
  const attributes: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(RESOURCE_TYPE_ATTRIBUTES[typeCode])) {
    const r = attributeValue(spec, text(form, `attr.${key}`));
    if (!r.ok) return { ok: false, error: 'resource_attribute' };
    if (r.value !== undefined) attributes[key] = r.value;
  }
  const modeRaw = text(form, 'occupancyMode');
  const occupancyMode: OccupancyMode =
    modeRaw === 'EXCLUSIVE' || modeRaw === 'SHARED'
      ? modeRaw
      : RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[typeCode];
  const keys = text(form, 'exclusivityKeys')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((k) => k !== '');
  if (keys.length > 8 || new Set(keys).size !== keys.length || !keys.every((k) => KEY_RE.test(k)))
    return { ok: false, error: 'resource_invalid' };
  const location = text(form, 'locationLabel');
  if (location.length > 120) return { ok: false, error: 'resource_invalid' };
  const zone = text(form, 'timezone');
  if (zone !== '' && !isIanaZone(zone)) return { ok: false, error: 'resource_timezone' };
  const venue = text(form, 'venueOrganizationId');
  if (venue !== '' && !/^[0-9a-f-]{36}$/.test(venue))
    return { ok: false, error: 'resource_invalid' };
  return {
    ok: true,
    value: {
      label,
      attributes,
      capacity,
      occupancyMode,
      exclusivityKeys: keys.sort(),
      venueOrganizationId: venue === '' ? null : venue,
      locationLabel: location === '' ? null : location,
      timezone: zone === '' ? null : zone,
    },
  };
}

export type FactInput =
  | {
      kind: 'WEEKLY';
      weekday: number;
      start: string;
      end: string;
      validFrom?: string;
      validTo?: string;
    }
  | { kind: 'DATE_OPEN'; date: string; start: string; end: string }
  | { kind: 'DATE_CLOSED'; date: string }
  | { kind: 'BLACKOUT' | 'MAINTENANCE'; startsAt: string; endsAt: string; reason: string };

/** start–end of a local window; `untilMidnight` makes the end 24:00 (a time input can't say it). */
function localWindow(form: Form): Parsed<{ start: string; end: string }> {
  const start = text(form, 'start');
  const end = form.get('untilMidnight') === 'on' ? '24:00' : text(form, 'end');
  if (!isLocalTime(start) || !(isLocalTime(end) || end === '24:00'))
    return { ok: false, error: 'availability_time' };
  if (end !== '24:00' && minutes(end) === minutes(start))
    return { ok: false, error: 'availability_window_empty' };
  return { ok: true, value: { start, end } };
}

/**
 * The hours forms → availability facts (one per selected weekday for WEEKLY). `zone` is the layer's
 * effective zone: blackout and maintenance times are entered there and converted strictly.
 */
export function parseAvailabilityForm(form: Form, zone: string): Parsed<FactInput[]> {
  const kind = text(form, 'kind');
  switch (kind) {
    case 'WEEKLY': {
      const days = [
        ...new Set(
          form
            .getAll('weekday')
            .map((d) => Number(d))
            .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
        ),
      ].sort();
      if (days.length === 0) return { ok: false, error: 'availability_weekday' };
      const w = localWindow(form);
      if (!w.ok) return w;
      const validFrom = text(form, 'validFrom');
      const validTo = text(form, 'validTo');
      if (
        (validFrom !== '' && !isLocalDate(validFrom)) ||
        (validTo !== '' && !isLocalDate(validTo))
      )
        return { ok: false, error: 'availability_invalid' };
      if (validFrom !== '' && validTo !== '' && validTo < validFrom)
        return { ok: false, error: 'availability_dates' };
      return {
        ok: true,
        value: days.map((weekday) => ({
          kind: 'WEEKLY' as const,
          weekday,
          ...w.value,
          ...(validFrom === '' ? {} : { validFrom }),
          ...(validTo === '' ? {} : { validTo }),
        })),
      };
    }
    case 'DATE_OPEN': {
      const date = text(form, 'date');
      if (!isLocalDate(date)) return { ok: false, error: 'availability_invalid' };
      const w = localWindow(form);
      return w.ok ? { ok: true, value: [{ kind: 'DATE_OPEN', date, ...w.value }] } : w;
    }
    case 'DATE_CLOSED': {
      const date = text(form, 'date');
      return isLocalDate(date)
        ? { ok: true, value: [{ kind: 'DATE_CLOSED', date }] }
        : { ok: false, error: 'availability_invalid' };
    }
    case 'BLACKOUT':
    case 'MAINTENANCE': {
      const reason = text(form, 'reason');
      if (reason.length < 1 || reason.length > 500) return { ok: false, error: 'reason_required' };
      const startDate = text(form, 'startDate');
      const endDate = text(form, 'endDate') || startDate;
      const a = strictLocalInstant(startDate, text(form, 'startTime'), zone);
      const b = strictLocalInstant(endDate, text(form, 'endTime'), zone);
      for (const x of [a, b]) {
        if (x.kind === 'skipped') return { ok: false, error: 'availability_time_skipped' };
        if (x.kind === 'ambiguous') return { ok: false, error: 'availability_time_ambiguous' };
        if (x.kind === 'invalid') return { ok: false, error: 'availability_time' };
      }
      if (a.kind !== 'ok' || b.kind !== 'ok') return { ok: false, error: 'availability_time' };
      if (Date.parse(b.instant) <= Date.parse(a.instant))
        return { ok: false, error: 'availability_period_order' };
      return { ok: true, value: [{ kind, startsAt: a.instant, endsAt: b.instant, reason }] };
    }
    default:
      return { ok: false, error: 'availability_invalid' };
  }
}
