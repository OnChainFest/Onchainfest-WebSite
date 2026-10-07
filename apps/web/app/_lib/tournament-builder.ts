import type {
  Catalog,
  ManagedCompetition,
  CatalogDisciplineVersion,
  CatalogFormatVersion,
  CompetitionStatus,
  EntrantKind,
  EventStatus,
} from './tournaments';

/**
 * ONCF-03B organizer Tournament Builder helpers. Pure, so the category builder (client) and the
 * server actions share them. Nothing here decides a rule: the lifecycle comes from the API's
 * `nextStatuses`, edit windows from its `editable` flags, valid sport/discipline/format pairs from
 * the catalog's `compatibleFormatVersionIds`, and every command is re-validated by the API.
 */

// ───────────────────────────── lifecycle commands ─────────────────────────────

/**
 * The command that performs each advertised competition transition (`/v1/competitions/:id/<cmd>`)
 * and the competition permission it needs, so a button is only offered to callers the API would
 * accept. A transition the server does not list in `nextStatuses` is never rendered.
 */
export const COMPETITION_COMMANDS: Partial<
  Record<CompetitionStatus, { command: string; permission: string; label: string }>
> = {
  PUBLISHED: { command: 'publish', permission: 'COMP_PUBLISH', label: 'Publish tournament' },
  ACTIVE: { command: 'activate', permission: 'COMP_EDIT', label: 'Start tournament' },
  COMPLETED: { command: 'complete', permission: 'COMP_EDIT', label: 'Mark completed' },
  CANCELLED: { command: 'cancel', permission: 'COMP_CANCEL', label: 'Cancel tournament' },
};

/**
 * Category transitions handled in the builder. Field lock, start and completion belong to draws and
 * operations (later phases), so they are not offered here even when advertised.
 */
export const EVENT_COMMANDS: Partial<
  Record<EventStatus, { command: string; permission: string; label: string }>
> = {
  REGISTRATION_OPEN: {
    command: 'open-registration',
    permission: 'COMP_OPEN_REGISTRATION',
    label: 'Open registration',
  },
  REGISTRATION_CLOSED: {
    command: 'close-registration',
    permission: 'COMP_CLOSE_REGISTRATION',
    label: 'Close registration',
  },
  CANCELLED: { command: 'cancel', permission: 'COMP_CANCEL', label: 'Cancel category' },
};

/** Advertised transitions the caller may perform, in the server's order. */
export function offeredTransitions<S extends string>(
  nextStatuses: readonly S[],
  commands: Partial<Record<S, { command: string; permission: string; label: string }>>,
  permissions: readonly string[],
): { status: S; command: string; label: string }[] {
  return nextStatuses.flatMap((status) => {
    const c = commands[status];
    return c !== undefined && permissions.includes(c.permission)
      ? [{ status, command: c.command, label: c.label }]
      : [];
  });
}

export const COMPETITION_STATUS_LABEL: Record<CompetitionStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ACTIVE: 'Live',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  DRAFT: 'Draft',
  REGISTRATION_OPEN: 'Registration open',
  REGISTRATION_CLOSED: 'Registration closed',
  FIELD_LOCKED: 'Field locked',
  IN_PROGRESS: 'In play',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** The usual path through each lifecycle, for the visual status track (display only). */
export const COMPETITION_TRACK: readonly CompetitionStatus[] = [
  'DRAFT',
  'PUBLISHED',
  'ACTIVE',
  'COMPLETED',
];
export const EVENT_TRACK: readonly EventStatus[] = [
  'DRAFT',
  'REGISTRATION_OPEN',
  'REGISTRATION_CLOSED',
  'FIELD_LOCKED',
  'IN_PROGRESS',
  'COMPLETED',
];

// ───────────────────────────── catalog ─────────────────────────────

export interface CatalogSport {
  readonly code: string;
  readonly name: string;
  readonly disciplines: number;
}

/** Sports that have at least one discipline with a runnable (compatible) format. */
export function catalogSports(catalog: Catalog): CatalogSport[] {
  const sports = new Map<string, CatalogSport>();
  for (const d of catalog.disciplineVersions) {
    if (compatibleFormats(catalog, d.disciplineVersionId).length === 0) continue;
    const s = sports.get(d.sport.code);
    sports.set(d.sport.code, {
      code: d.sport.code,
      name: d.sport.name,
      disciplines: (s?.disciplines ?? 0) + 1,
    });
  }
  return [...sports.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function disciplinesFor(catalog: Catalog, sportCode: string): CatalogDisciplineVersion[] {
  return catalog.disciplineVersions.filter(
    (d) =>
      d.sport.code === sportCode && compatibleFormats(catalog, d.disciplineVersionId).length > 0,
  );
}

/**
 * Formats the catalog says can run a discipline version: listed in its
 * `compatibleFormatVersionIds` and backed by an engine in this build (`contestType` not null).
 */
export function compatibleFormats(
  catalog: Catalog,
  disciplineVersionId: string,
): CatalogFormatVersion[] {
  const d = catalog.disciplineVersions.find((x) => x.disciplineVersionId === disciplineVersionId);
  if (d === undefined) return [];
  const ids = new Set(d.compatibleFormatVersionIds);
  return catalog.formatVersions.filter((f) => ids.has(f.formatVersionId) && f.contestType !== null);
}

/** True only for a combination the catalog offers. The API re-checks it on create. */
export function validCombination(
  catalog: Catalog,
  choice: { disciplineVersionId: string; formatVersionId: string; entrantKind: string },
): boolean {
  const d = catalog.disciplineVersions.find(
    (x) => x.disciplineVersionId === choice.disciplineVersionId,
  );
  return (
    d !== undefined &&
    (d.participantKinds as readonly string[]).includes(choice.entrantKind) &&
    compatibleFormats(catalog, d.disciplineVersionId).some(
      (f) => f.formatVersionId === choice.formatVersionId,
    )
  );
}

export function entrantLabel(kind: EntrantKind, lineup: { min: number; max: number }): string {
  if (kind === 'INDIVIDUAL') return 'Individual players';
  const n = lineup.min === lineup.max ? `${lineup.min}` : `${lineup.min}–${lineup.max}`;
  return `Teams of ${n}`;
}

// ───────────────────────────── format configuration ─────────────────────────────

export type ConfigField =
  | { kind: 'boolean'; name: string; required: boolean; default?: boolean; description?: string }
  | {
      kind: 'integer';
      name: string;
      required: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
      description?: string;
    }
  | {
      kind: 'enum';
      name: string;
      required: boolean;
      options: string[];
      default?: string;
      description?: string;
    }
  | {
      kind: 'text';
      name: string;
      required: boolean;
      maxLength?: number;
      default?: string;
      description?: string;
    };

/**
 * Controls for a format's `configurationSchema` (a flat BR object schema). An empty `properties`
 * means the format takes no configuration and the event is created with `{}`. A schema with nested
 * objects or arrays is reported as unsupported rather than guessed at.
 */
export function configFields(
  schema: Record<string, unknown> | null | undefined,
): { kind: 'fields'; fields: ConfigField[] } | { kind: 'unsupported' } {
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  const fields: ConfigField[] = [];
  for (const [name, p] of Object.entries(props)) {
    const base = {
      name,
      required: required.has(name),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
    };
    if (p.type === 'boolean')
      fields.push({
        kind: 'boolean',
        ...base,
        ...(typeof p.default === 'boolean' ? { default: p.default } : {}),
      });
    else if (p.type === 'integer')
      fields.push({
        kind: 'integer',
        ...base,
        ...(typeof p.minimum === 'number' ? { minimum: p.minimum } : {}),
        ...(typeof p.maximum === 'number' ? { maximum: p.maximum } : {}),
        ...(typeof p.default === 'number' ? { default: p.default } : {}),
      });
    else if (p.type === 'string' && Array.isArray(p.enum))
      fields.push({
        kind: 'enum',
        ...base,
        options: p.enum as string[],
        ...(typeof p.default === 'string' ? { default: p.default } : {}),
      });
    else if (p.type === 'string')
      fields.push({
        kind: 'text',
        ...base,
        ...(typeof p.maxLength === 'number' ? { maxLength: p.maxLength } : {}),
        ...(typeof p.default === 'string' ? { default: p.default } : {}),
      });
    else return { kind: 'unsupported' };
  }
  return { kind: 'fields', fields };
}

/** Form values (`cfg.<name>`) → the format configuration object; blanks are omitted. */
export function configFromForm(
  fields: readonly ConfigField[],
  form: FormData,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = form.get(`cfg.${f.name}`);
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (f.kind === 'boolean') out[f.name] = v === 'on' || v === 'true';
    else if (v === '') continue;
    else if (f.kind === 'integer') out[f.name] = Number.parseInt(v, 10);
    else out[f.name] = v;
  }
  return out;
}

// ───────────────────────────── time ─────────────────────────────

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function wallClock(instantMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    y: get('year'),
    mo: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

function offsetMs(instantMs: number, timeZone: string): number {
  const w = wallClock(instantMs, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(instantMs / 1000) * 1000;
}

export function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A `datetime-local` value read as wall-clock time in `timeZone` → an ISO-8601 UTC instant (the API
 * accepts only explicit offsets). '' → null; anything unparseable → undefined.
 */
export function zonedToInstant(local: string, timeZone: string): string | null | undefined {
  const v = local.trim();
  if (v === '') return null;
  const m = LOCAL_RE.exec(v);
  if (m === null || !validTimeZone(timeZone)) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let instant = guess - offsetMs(guess, timeZone);
  const second = offsetMs(instant, timeZone);
  if (second !== guess - instant) instant = guess - second;
  return Number.isNaN(instant) ? undefined : new Date(instant).toISOString();
}

/** An instant → the `datetime-local` value it shows as in `timeZone` ('' for null). */
export function instantToZoned(iso: string | null, timeZone: string): string {
  if (iso === null) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !validTimeZone(timeZone)) return '';
  const w = wallClock(ms, timeZone);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}T${p(w.h)}:${p(w.mi)}`;
}

export function dayParts(
  iso: string | null,
  timeZone: string,
): { day: string; month: string } | null {
  if (iso === null || !validTimeZone(timeZone)) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    day: new Intl.DateTimeFormat('en', { day: '2-digit', timeZone }).format(d),
    month: new Intl.DateTimeFormat('en', { month: 'short', timeZone }).format(d).toUpperCase(),
  };
}

/** "12–14 Oct 2026", "30 Oct – 2 Nov 2026" or null when no dates are set. */
export function dateRange(
  startsAt: string | null,
  endsAt: string | null,
  timeZone: string,
): string | null {
  if (!validTimeZone(timeZone)) return null;
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...o, timeZone }).format(new Date(iso));
  if (startsAt === null && endsAt === null) return null;
  if (startsAt === null || endsAt === null) {
    const one = (startsAt ?? endsAt) as string;
    return `${startsAt === null ? 'Until ' : ''}${fmt(one, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }
  const [sy, ey] = [fmt(startsAt, { year: 'numeric' }), fmt(endsAt, { year: 'numeric' })];
  const [sm, em] = [fmt(startsAt, { month: 'short' }), fmt(endsAt, { month: 'short' })];
  const [sd, ed] = [fmt(startsAt, { day: 'numeric' }), fmt(endsAt, { day: 'numeric' })];
  if (sy !== ey) return `${sd} ${sm} ${sy} – ${ed} ${em} ${ey}`;
  if (sm !== em) return `${sd} ${sm} – ${ed} ${em} ${ey}`;
  if (sd !== ed) return `${sd}–${ed} ${sm} ${ey}`;
  return `${sd} ${sm} ${ey}`;
}

export function dateTime(iso: string | null, timeZone: string): string | null {
  if (iso === null || !validTimeZone(timeZone)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/** IANA zones for pickers, with UTC first (not every runtime lists it). */
export function timeZones(): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return ['UTC', ...zones.filter((z) => z !== 'UTC')];
}

/** A readable address from a name (the API normalizes and re-validates it). */
export function slugSuggestion(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

/** Stable hue (0–359) from a code, for generated sport artwork. Purely decorative. */
export function hueFor(code: string): number {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// ───────────────────────────── builder progress ─────────────────────────────

export interface ReviewItem {
  readonly key: string;
  readonly label: string;
  readonly done: boolean;
}

/**
 * Readiness hints for the Review step, from stored data only. They are advice, not rules: the API
 * alone decides whether a tournament can be published.
 */
export function reviewChecklist(data: ManagedCompetition): ReviewItem[] {
  const p = data.competition.profile;
  const live = data.events.filter((e) => e.status !== 'CANCELLED');
  return [
    { key: 'dates', label: 'Tournament dates set', done: p.startsAt !== null && p.endsAt !== null },
    { key: 'venue', label: 'Venue set', done: p.locationLabel !== null },
    { key: 'categories', label: 'At least one category', done: live.length > 0 },
    {
      key: 'windows',
      label: 'Every category has a registration window',
      done:
        live.length > 0 &&
        live.every(
          (e) =>
            e.settings.registrationOpensAt !== null && e.settings.registrationClosesAt !== null,
        ),
    },
  ];
}

export function builderSteps(data: ManagedCompetition, base: string) {
  const review = reviewChecklist(data);
  const ok = (k: string) => review.find((r) => r.key === k)?.done === true;
  const live = data.events.filter((e) => e.status !== 'CANCELLED');
  const published = data.competition.status !== 'DRAFT';
  const done = {
    identity: ok('dates') && ok('venue'),
    categories: ok('categories'),
    configuration: ok('windows'),
    review: review.every((r) => r.done),
    publish: published,
  };
  const order = ['identity', 'categories', 'configuration', 'review', 'publish'] as const;
  const firstOpen = order.find((k) => !done[k]);
  const state = (k: (typeof order)[number]) =>
    done[k] ? ('done' as const) : k === firstOpen ? ('current' as const) : ('todo' as const);
  const pending = live.filter(
    (e) => e.settings.registrationOpensAt === null || e.settings.registrationClosesAt === null,
  ).length;
  return [
    {
      key: 'identity',
      label: 'Identity',
      detail: done.identity ? 'Name · dates · venue' : 'Add dates and venue',
      state: state('identity'),
      href: `${base}/edit`,
    },
    {
      key: 'categories',
      label: 'Categories',
      detail:
        live.length === 0
          ? 'None yet'
          : `${live.length} ${live.length === 1 ? 'category' : 'categories'}`,
      state: state('categories'),
      href: '#categories',
    },
    {
      key: 'configuration',
      label: 'Configuration',
      detail:
        live.length === 0
          ? 'Capacity · windows'
          : pending === 0
            ? 'All configured'
            : `${pending} to configure`,
      state: state('configuration'),
      href: '#categories',
    },
    {
      key: 'review',
      label: 'Review',
      detail: `${review.filter((r) => r.done).length}/${review.length} ready`,
      state: state('review'),
      href: '#review',
    },
    {
      key: 'publish',
      label: 'Publish',
      detail: published ? COMPETITION_STATUS_LABEL[data.competition.status] : 'Draft',
      state: state('publish'),
      href: '#publish',
    },
  ];
}

export const GENDER_LABEL: Record<string, string> = {
  OPEN: 'Open',
  MEN: 'Men',
  WOMEN: 'Women',
  MIXED: 'Mixed',
};

/** Declared category labels as display chips (labels only; nothing is inferred or verified). */
export function categoryChips(category: Record<string, unknown>): string[] {
  const chips: string[] = [];
  const g = category.genderCategory;
  if (typeof g === 'string') chips.push(GENDER_LABEL[g] ?? g);
  const age = category.ageCategory as { label?: unknown } | undefined;
  if (typeof age?.label === 'string') chips.push(age.label);
  for (const k of ['skillClass', 'division', 'weightClass', 'classification'])
    if (typeof category[k] === 'string') chips.push(category[k] as string);
  if (Array.isArray(category.customLabels))
    for (const l of category.customLabels) if (typeof l === 'string') chips.push(l);
  return chips;
}
