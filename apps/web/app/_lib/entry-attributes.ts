import { getPublic } from './api';
import { apiRequest, type ApiResult } from './platform';
import { activeMembers, myTeams } from './teams';
import {
  catalogDiscipline,
  tournamentCatalog,
  type EntryAttributeSpec,
  type EventStatus,
} from './tournaments';

/**
 * ONCF-05B declared entry attributes (entry time, average, handicap index, bib, classification
 * points…). The discipline declares which keys exist, their type and bounds; the API validates and
 * freezes them at the field lock. Values are DECLARED by the entrant or organizer — never verified.
 * Helpers here only convert what a person types into the canonical string the API expects.
 */

export interface DeclaredAttribute {
  key: string;
  value: string;
  athleteId?: string;
}

export function entryAttributes(
  token: string,
  registrationId: string,
): Promise<ApiResult<{ items: DeclaredAttribute[] }>> {
  return apiRequest(token, 'GET', `/v1/registrations/${registrationId}/entry-attributes`);
}

/** Attributes can be declared until the field locks (the API re-checks). */
export function attributesEditable(status: EventStatus): boolean {
  return status === 'DRAFT' || status === 'REGISTRATION_OPEN' || status === 'REGISTRATION_CLOSED';
}

/**
 * Human label for a declared attribute key, derived from the key itself (keys come from the
 * catalog; nothing is hard-coded): `entryTimeMs` → "Entry time", `memberHandicapIndex` →
 * "Handicap index" (the member is shown next to it).
 */
export function attributeLabel(key: string): string {
  const base = key.replace(/^member(?=[A-Z])/, '').replace(/Ms$/, '');
  const words = base
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * "1:02.45" / "62.45" / "1:00:05" → milliseconds as a canonical integer string. Hundredths are
 * the finest unit people type; null when the text is not a duration.
 */
export function parseDuration(text: string): string | null {
  const t = text.trim();
  const m = /^(?:(\d{1,3}):)?(?:(\d{1,2}):)?(\d{1,5})(?:\.(\d{1,3}))?$/.exec(t);
  if (m === null) return null;
  const [, a, b, s, frac] = m;
  let hours = 0;
  let minutes = 0;
  if (a !== undefined && b !== undefined) {
    hours = Number(a);
    minutes = Number(b);
  } else if (a !== undefined) minutes = Number(a);
  const seconds = Number(s);
  if ((a !== undefined || b !== undefined) && seconds >= 60) return null;
  if (b !== undefined && minutes >= 60) return null;
  const ms = Number((frac ?? '').padEnd(3, '0'));
  return String(((hours * 60 + minutes) * 60 + seconds) * 1000 + ms);
}

/** Milliseconds → "h:mm:ss.hh" / "m:ss.hh" (display only). */
export function formatDuration(ms: string | number): string {
  const n = typeof ms === 'string' ? Number(ms) : ms;
  if (!Number.isFinite(n) || n < 0) return String(ms);
  const hundredths = Math.floor((n % 1000) / 10);
  const total = Math.floor(n / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = `${String(s).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Display a declared value according to its type. */
export function displayValue(
  spec: Pick<EntryAttributeSpec, 'valueType'> | undefined,
  value: string,
): string {
  return spec?.valueType === 'DURATION_MS' ? formatDuration(value) : value;
}

const DECIMAL = /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,9})?$/;
const INTEGER = /^-?(0|[1-9][0-9]{0,15})$/;

function cmp(a: string, b: string): number {
  return Number(a) - Number(b);
}

/**
 * Typed input → canonical value, or 'invalid'. Empty input means "no value" (null). Bounds are a
 * convenience check; the API is the authority.
 */
export function normalizeAttributeInput(
  spec: Pick<EntryAttributeSpec, 'valueType' | 'min' | 'max'>,
  raw: string,
): string | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;
  let v: string | null;
  switch (spec.valueType) {
    case 'DURATION_MS':
      v = parseDuration(t);
      break;
    case 'INTEGER':
      v = INTEGER.test(t) ? t : null;
      break;
    case 'DECIMAL':
      v = DECIMAL.test(t) ? t : null;
      break;
    default:
      v = t.length <= 64 ? t : null;
  }
  if (v === null) return 'invalid';
  if (spec.valueType !== 'TEXT') {
    if (spec.min !== undefined && cmp(v, spec.min) < 0) return 'invalid';
    if (spec.max !== undefined && cmp(v, spec.max) > 0) return 'invalid';
  }
  return v;
}

/** Form field name for an attribute (MEMBER scope carries the athlete). */
export function attributeField(key: string, athleteId?: string): string {
  return athleteId === undefined ? `attr.${key}` : `attr.${key}.${athleteId}`;
}

/** Placeholder hint per type. */
export function attributeHint(spec: Pick<EntryAttributeSpec, 'valueType' | 'min' | 'max'>): string {
  const range =
    spec.min !== undefined || spec.max !== undefined
      ? ` (${spec.min ?? '…'}–${spec.max ?? '…'})`
      : '';
  switch (spec.valueType) {
    case 'DURATION_MS':
      return 'm:ss.hh';
    case 'INTEGER':
      return `whole number${range}`;
    case 'DECIMAL':
      return `number${range}`;
    default:
      return 'text';
  }
}

// ───────────────────────────── page context ─────────────────────────────

export interface AttributeContext {
  specs: EntryAttributeSpec[];
  values: DeclaredAttribute[];
  /** ACTIVE team members (MEMBER-scope attributes), named under the roster rule. */
  members: { athleteId: string; label: string }[];
  editable: boolean;
}

/**
 * What a registration page needs to show and edit declared values: the pinned discipline's
 * attribute declarations (public event → catalog version), the current values, and — for team
 * entries the caller manages — the active members. null when the discipline declares none or a
 * read fails (the section is then simply not shown; nothing is guessed).
 */
export async function attributeContext(
  token: string,
  reg: {
    id: string;
    team: { id: string; name: string } | null;
    event: { slug: string; status: EventStatus };
    competition: { slug: string };
  },
): Promise<AttributeContext | null> {
  const [event, catalog, values] = await Promise.all([
    getPublic<{ event: { discipline: { code: string; version: number } } }>(
      `/v1/competitions/${encodeURIComponent(reg.competition.slug)}/events/${encodeURIComponent(reg.event.slug)}`,
    ),
    tournamentCatalog(),
    entryAttributes(token, reg.id),
  ]);
  if (event.kind !== 'ok' || catalog.kind !== 'ok' || values.kind !== 'ok') return null;
  const d = catalogDiscipline(
    catalog.data,
    event.data.event.discipline.code,
    event.data.event.discipline.version,
  );
  const specs = d?.entryAttributes ?? [];
  if (specs.length === 0) return null;
  let members: AttributeContext['members'] = [];
  if (reg.team !== null && specs.some((s) => s.scope === 'MEMBER')) {
    const teams = await myTeams(token);
    const team =
      teams.kind === 'ok' ? teams.data.items.find((t) => t.teamId === reg.team?.id) : undefined;
    members = (team === undefined ? [] : activeMembers(team)).map((m) => ({
      athleteId: m.athleteId,
      label: m.athlete?.displayName ?? 'Private athlete',
    }));
  }
  return {
    specs,
    values: values.data.items,
    members,
    editable: attributesEditable(reg.event.status),
  };
}

/** Changed values from the attributes form (only what differs from the rendered value is sent). */
export function changedAttributes(
  get: (name: string) => string,
  names: readonly string[],
  specs: readonly EntryAttributeSpec[],
):
  | { kind: 'ok'; attributes: { key: string; value: string | null; athleteId?: string }[] }
  | { kind: 'invalid' } {
  const out: { key: string; value: string | null; athleteId?: string }[] = [];
  for (const name of names) {
    const m = /^attr\.([a-z][A-Za-z0-9]{0,31})(?:\.([0-9a-f-]{36}))?$/.exec(name);
    if (m === null) continue;
    const [, key, athleteId] = m;
    const spec = specs.find((s) => s.key === key);
    if (spec === undefined || (spec.scope === 'MEMBER') !== (athleteId !== undefined)) continue;
    const value = normalizeAttributeInput(spec, get(name));
    if (value === 'invalid') return { kind: 'invalid' };
    const prev = get(`prev.${name}`);
    if ((value ?? '') === prev) continue;
    out.push({ key: key as string, value, ...(athleteId === undefined ? {} : { athleteId }) });
  }
  return { kind: 'ok', attributes: out };
}
