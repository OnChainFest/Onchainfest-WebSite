'use server';

import type { AuthErrorCode, AuthNoticeCode } from '../../../../_lib/auth/messages';
import {
  idempotencyKey,
  normalizeSlugInput,
  slugFromName,
} from '../../../../_lib/onboarding-input';
import { apiRequest } from '../../../../_lib/platform';
import {
  configFields,
  configFromForm,
  validCombination,
  validTimeZone,
  zonedToInstant,
} from '../../../../_lib/tournament-builder';
import {
  managedCompetition,
  tournamentCatalog,
  type ManagedEvent,
} from '../../../../_lib/tournaments';
import { context, errorCode, field, optional, to, UUID_RE } from '../action-support';

/**
 * ONCF-03B tournament actions. Same shape as the ONCF-02 organization actions: re-verify the
 * session, resolve the caller's own membership of the organization, call the canonical
 * Competition / Event route and redirect with a fixed-vocabulary code. The competition store is
 * the authority for every permission (ORG_MANAGE_COMPETITIONS, COMP_EDIT, COMP_PUBLISH,
 * COMP_OPEN_REGISTRATION…), edit window and lifecycle transition; nothing is decided here.
 */

const COMPETITION_NOTICE = {
  publish: 'published',
  activate: 'tournament_started',
  complete: 'tournament_completed',
  cancel: 'tournament_cancelled',
} as const satisfies Record<string, AuthNoticeCode>;

const EVENT_NOTICE = {
  'open-registration': 'registration_opened',
  'close-registration': 'registration_closed',
  cancel: 'category_cancelled',
} as const satisfies Record<string, AuthNoticeCode>;

const GENDERS = ['OPEN', 'MEN', 'WOMEN', 'MIXED'];

class InputError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

function instant(form: FormData, name: string, tz: string): string | null {
  const v = zonedToInstant(field(form, name), tz);
  if (v === undefined) throw new InputError('tournament_invalid');
  return v;
}

function timezone(form: FormData, fallback?: string): string {
  const tz = field(form, 'timezone').trim() || fallback || '';
  if (!validTimeZone(tz)) throw new InputError('tournament_invalid');
  return tz;
}

/** The competition profile body (PUT replaces it whole, so every field is sent). */
function profileFromForm(form: FormData) {
  const name = field(form, 'name').trim();
  if (name === '') throw new InputError('missing_fields');
  const tz = timezone(form);
  const region = field(form, 'regionCode').trim().toUpperCase();
  return {
    name,
    description: optional(field(form, 'description')),
    locationLabel: optional(field(form, 'locationLabel')),
    regionCode: region === '' ? null : region,
    timezone: tz,
    startsAt: instant(form, 'startsAt', tz),
    endsAt: instant(form, 'endsAt', tz),
    website: optional(field(form, 'website')),
  };
}

/**
 * Category labels from the form, layered over the category being edited so labels this builder
 * doesn't edit (weight class, classification) are kept.
 */
function categoryFromForm(form: FormData, base: Record<string, unknown> = {}) {
  const c: Record<string, unknown> = { ...base };
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete c[key];
    else c[key] = value;
  };
  const gender = field(form, 'genderCategory');
  set('genderCategory', GENDERS.includes(gender) ? gender : undefined);
  const ageLabel = field(form, 'ageLabel').trim();
  const age = (name: string) => {
    const v = field(form, name).trim();
    return v === '' ? undefined : Number.parseInt(v, 10);
  };
  set(
    'ageCategory',
    ageLabel === ''
      ? undefined
      : Object.fromEntries(
          Object.entries({ label: ageLabel, minAge: age('minAge'), maxAge: age('maxAge') }).filter(
            ([, v]) => v !== undefined,
          ),
        ),
  );
  for (const key of ['skillClass', 'division']) set(key, optional(field(form, key)) ?? undefined);
  const labels = [
    ...new Set(
      field(form, 'customLabels')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== ''),
    ),
  ];
  set('customLabels', labels.length === 0 ? undefined : labels.slice(0, 8));
  return c;
}

/** Event settings body (PUT replaces it whole). Capacity/mode come from `locked` when frozen. */
function settingsFromForm(
  form: FormData,
  competitionTz: string,
  base?: ManagedEvent,
): Record<string, unknown> {
  const name = field(form, 'name').trim();
  if (name === '') throw new InputError('missing_fields');
  const tz = timezone(form, competitionTz);
  const frozen = base !== undefined && !base.editable.capacityAndRegistrationMode;
  const capRaw = field(form, 'capacity').trim();
  const capacity = capRaw === '' ? null : Number.parseInt(capRaw, 10);
  if (capacity !== null && !Number.isInteger(capacity)) throw new InputError('tournament_invalid');
  const mode = field(form, 'registrationMode');
  return {
    name,
    category: categoryFromForm(form, base?.settings.category),
    capacity: frozen ? base.settings.capacity : capacity,
    registrationMode: frozen
      ? base.settings.registrationMode
      : mode === 'ORGANIZER_APPROVAL'
        ? 'ORGANIZER_APPROVAL'
        : 'AUTO_CONFIRM',
    registrationOpensAt: instant(form, 'registrationOpensAt', tz),
    registrationClosesAt: instant(form, 'registrationClosesAt', tz),
    startsAt: instant(form, 'startsAt', tz),
    endsAt: instant(form, 'endsAt', tz),
    timezone: tz,
  };
}

function inputError(err: unknown): AuthErrorCode {
  if (err instanceof InputError) return err.code;
  throw err;
}

function competitionId(form: FormData, slug: string): string {
  const id = field(form, 'competitionId');
  if (!UUID_RE.test(id)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  return id;
}

// ───────────────────────────── tournament ─────────────────────────────

export async function createTournamentAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token, org } = await context(slug);
  let profile: ReturnType<typeof profileFromForm>;
  try {
    profile = profileFromForm(form);
  } catch (err) {
    to(slug, 'tournaments/new', { error: inputError(err) });
  }
  const address = normalizeSlugInput(field(form, 'address'));
  if (address === null) to(slug, 'tournaments/new', { error: 'profile_address_invalid' });
  const r = await apiRequest<{ competitionId: string; slug: string }>(
    token,
    'POST',
    '/v1/competitions',
    {
      idempotencyKey: idempotencyKey(field(form, 'key')),
      body: {
        organizerOrganizationId: org.organizationId,
        slug: address !== '' ? address : slugFromName(profile.name),
        profile,
      },
    },
  );
  if (r.kind !== 'ok') to(slug, 'tournaments/new', { error: errorCode(r, 'tournament') });
  to(slug, `tournaments/${r.data.competitionId}`, { notice: 'tournament_created' });
}

export async function updateTournamentAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const back = `tournaments/${id}/edit`;
  let profile: ReturnType<typeof profileFromForm>;
  try {
    profile = profileFromForm(form);
  } catch (err) {
    to(slug, back, { error: inputError(err) });
  }
  const address = normalizeSlugInput(field(form, 'address'));
  if (address === null) to(slug, back, { error: 'profile_address_invalid' });
  const r = await apiRequest(token, 'PUT', `/v1/competitions/${id}/profile`, { body: profile });
  if (r.kind !== 'ok') to(slug, back, { error: errorCode(r, 'tournament') });
  if (address !== '' && address !== field(form, 'currentAddress')) {
    const s = await apiRequest(token, 'PUT', `/v1/competitions/${id}/slug`, {
      body: { slug: address },
    });
    if (s.kind !== 'ok') to(slug, back, { error: errorCode(s, 'tournament') });
  }
  to(slug, `tournaments/${id}`, { notice: 'tournament_updated' });
}

/** Performs one advertised competition transition. The store refuses anything else. */
export async function tournamentTransitionAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const command = field(form, 'command');
  const back = `tournaments/${id}`;
  if (!Object.hasOwn(COMPETITION_NOTICE, command))
    to(slug, back, { error: 'tournament_transition' });
  const reason = field(form, 'reason').trim();
  if (command === 'cancel' && reason === '') to(slug, back, { error: 'reason_required' });
  const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/${command}`, {
    ...(command === 'cancel' ? { body: { reason: reason.slice(0, 500) } } : {}),
  });
  if (r.kind !== 'ok') to(slug, back, { error: errorCode(r, 'tournament') });
  to(slug, back, { notice: COMPETITION_NOTICE[command as keyof typeof COMPETITION_NOTICE] });
}

// ───────────────────────────── categories ─────────────────────────────

export async function addCategoryAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const back = `tournaments/${id}/categories/new`;
  const choice = {
    disciplineVersionId: field(form, 'disciplineVersionId'),
    formatVersionId: field(form, 'formatVersionId'),
    entrantKind: field(form, 'entrantKind'),
  };
  const [catalog, detail] = await Promise.all([tournamentCatalog(), managedCompetition(token, id)]);
  if (catalog.kind !== 'ok') to(slug, back, { error: 'platform_unavailable' });
  if (detail.kind !== 'ok') to(slug, back, { error: errorCode(detail, 'tournament') });
  // Never send a combination the catalog doesn't offer (the API would refuse it too).
  if (!validCombination(catalog.data, choice)) to(slug, back, { error: 'catalog_combination' });
  const format = catalog.data.formatVersions.find(
    (f) => f.formatVersionId === choice.formatVersionId,
  );
  const schema = configFields(format?.configurationSchema);
  if (schema.kind === 'unsupported') to(slug, back, { error: 'catalog_combination' });
  let settings: Record<string, unknown>;
  try {
    settings = settingsFromForm(form, detail.data.competition.profile.timezone);
  } catch (err) {
    to(slug, back, { error: inputError(err) });
  }
  const address = normalizeSlugInput(field(form, 'address'));
  if (address === null) to(slug, back, { error: 'profile_address_invalid' });
  const r = await apiRequest<{ eventId: string }>(token, 'POST', `/v1/competitions/${id}/events`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: {
      slug: address !== '' ? address : slugFromName(String(settings.name)),
      ...choice,
      // The canonical empty configuration when the format declares no properties.
      formatConfig: configFromForm(schema.fields, form),
      settings,
    },
  });
  if (r.kind !== 'ok') to(slug, back, { error: errorCode(r, 'tournament') });
  to(slug, `tournaments/${id}`, { notice: 'category_added' });
}

export async function updateCategoryAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const eventId = field(form, 'eventId');
  if (!UUID_RE.test(eventId)) to(slug, `tournaments/${id}`, { error: 'tournament_not_found' });
  const back = `tournaments/${id}/categories/${eventId}`;
  // The stored settings are the base: frozen capacity/mode and unedited labels are resent as is.
  const detail = await managedCompetition(token, id);
  if (detail.kind !== 'ok') to(slug, back, { error: errorCode(detail, 'tournament') });
  const event = detail.data.events.find((e) => e.id === eventId);
  if (event === undefined) to(slug, `tournaments/${id}`, { error: 'tournament_not_found' });
  let settings: Record<string, unknown>;
  try {
    settings = settingsFromForm(form, detail.data.competition.profile.timezone, event);
  } catch (err) {
    to(slug, back, { error: inputError(err) });
  }
  const r = await apiRequest(token, 'PUT', `/v1/events/${eventId}/settings`, { body: settings });
  if (r.kind !== 'ok') to(slug, back, { error: errorCode(r, 'tournament') });
  to(slug, back, { notice: 'category_updated' });
}

/** Performs one advertised category transition (open/close registration, cancel). */
export async function categoryTransitionAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const eventId = field(form, 'eventId');
  if (!UUID_RE.test(eventId)) to(slug, `tournaments/${id}`, { error: 'tournament_not_found' });
  const back = `tournaments/${id}/categories/${eventId}`;
  const command = field(form, 'command');
  if (!Object.hasOwn(EVENT_NOTICE, command)) to(slug, back, { error: 'tournament_transition' });
  const reason = field(form, 'reason').trim();
  if (command === 'cancel' && reason === '') to(slug, back, { error: 'reason_required' });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/${command}`, {
    ...(command === 'cancel' ? { body: { reason: reason.slice(0, 500) } } : {}),
  });
  if (r.kind !== 'ok') to(slug, back, { error: errorCode(r, 'tournament') });
  to(slug, back, { notice: EVENT_NOTICE[command as keyof typeof EVENT_NOTICE] });
}
