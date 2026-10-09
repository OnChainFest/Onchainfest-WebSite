'use server';

import type { AuthErrorCode } from '../../../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../../../_lib/platform';
import {
  lockedField,
  seedableAttributes,
  seedingRequest,
} from '../../../../../../../../_lib/structure';
import {
  catalogDiscipline,
  managedCompetition,
  tournamentCatalog,
} from '../../../../../../../../_lib/tournaments';
import { context, field, to, UUID_RE } from '../../../../../action-support';

/**
 * ONCF-05B structure commands: lock the field, seed it, generate the structure. Each is a single,
 * immutable API command (once per category); the API decides permissions (COMP_LOCK_FIELD,
 * COMP_GENERATE_STRUCTURE), preconditions and every rule. Nothing here is trusted for authority.
 */

type Command = 'lock-field' | 'seed' | 'generate-plan';

/** API refusal → message code, worded for the structure step that was attempted. */
function structureErrorCode(
  r: Exclude<ApiResult<unknown>, { kind: 'ok' }>,
  command: Command,
): AuthErrorCode {
  if (r.kind === 'unavailable' || r.kind === 'unauthenticated') return 'platform_unavailable';
  switch (r.code) {
    case 'FORBIDDEN':
      return 'not_permitted';
    case 'ALREADY_EXISTS':
      return 'structure_done';
    case 'INVALID_TRANSITION':
      return 'tournament_transition';
    case 'NOT_FOUND':
      return 'tournament_not_found';
    case 'INVALID_INPUT':
      return command === 'lock-field'
        ? 'field_incomplete'
        : command === 'seed'
          ? 'seeding_invalid'
          : 'plan_invalid';
    default:
      return r.status === 403 ? 'not_permitted' : 'unknown';
  }
}

function ids(form: FormData, slug: string) {
  const competitionId = field(form, 'competitionId');
  const eventId = field(form, 'eventId');
  if (!UUID_RE.test(competitionId)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  if (!UUID_RE.test(eventId))
    to(slug, `tournaments/${competitionId}`, { error: 'tournament_not_found' });
  return {
    competitionId,
    eventId,
    back: `tournaments/${competitionId}/categories/${eventId}/structure`,
  };
}

export async function lockFieldAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/lock-field`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
  });
  if (r.kind !== 'ok') to(slug, back, { error: structureErrorCode(r, 'lock-field') });
  to(slug, back, { notice: 'field_locked' });
}

export async function seedFieldAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { competitionId, eventId, back } = ids(form, slug);
  // The seed form only names participants of the locked field and attributes the discipline
  // declares; both are re-read here rather than trusted from the form.
  const [participants, detail, catalog] = await Promise.all([
    lockedField(token, eventId),
    managedCompetition(token, competitionId),
    tournamentCatalog(),
  ]);
  if (participants.kind !== 'ok')
    to(slug, back, { error: structureErrorCode(participants, 'seed') });
  if (detail.kind !== 'ok') to(slug, back, { error: structureErrorCode(detail, 'seed') });
  const event = detail.data.events.find((e) => e.id === eventId);
  if (event === undefined)
    to(slug, `tournaments/${competitionId}`, { error: 'tournament_not_found' });
  const discipline =
    catalog.kind === 'ok'
      ? catalogDiscipline(catalog.data, event.discipline.code, event.discipline.version)
      : undefined;
  const built = seedingRequest(
    (name) => field(form, name),
    participants.data.items,
    seedableAttributes(discipline?.entryAttributes),
  );
  if (built.kind === 'error') to(slug, back, { error: built.code });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/seed`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: built.body,
  });
  if (r.kind !== 'ok') to(slug, back, { error: structureErrorCode(r, 'seed') });
  to(slug, back, { notice: 'field_seeded' });
}

export async function generatePlanAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  if (field(form, 'confirm') !== 'yes') to(slug, back, { error: 'missing_fields' });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/generate-plan`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
  });
  if (r.kind !== 'ok') to(slug, back, { error: structureErrorCode(r, 'generate-plan') });
  to(slug, back, { notice: 'plan_generated' });
}

/**
 * ONCF-05C: pins the category's scoring (ruleset + optional classification template). The API
 * checks permission (COMP_EDIT), publication, capability fit and that the field is not locked.
 */
export async function pinScoringAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  const rulesetVersionId = field(form, 'rulesetVersionId');
  const templateVersionId = field(form, 'classificationTemplateVersionId');
  const policyVersionId = field(form, 'advancementPolicyVersionId');
  // ONCF-05E-B: the form re-sends the whole pin, so the pinned SchedulingProfile is carried over
  // unchanged (it is not chosen here; omitting it would silently unpin it).
  const profileVersionId = field(form, 'schedulingProfileVersionId');
  if (profileVersionId !== '' && !UUID_RE.test(profileVersionId))
    to(slug, back, { error: 'scoring_invalid' });
  if (policyVersionId !== '' && !UUID_RE.test(policyVersionId))
    to(slug, back, { error: 'scoring_invalid' });
  if (!UUID_RE.test(rulesetVersionId)) to(slug, back, { error: 'missing_fields' });
  if (templateVersionId !== '' && !UUID_RE.test(templateVersionId))
    to(slug, back, { error: 'scoring_invalid' });
  const r = await apiRequest(token, 'PUT', `/v1/events/${eventId}/scoring`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: {
      rulesetVersionId,
      ...(templateVersionId === '' ? {} : { classificationTemplateVersionId: templateVersionId }),
      ...(policyVersionId === '' ? {} : { advancementPolicyVersionId: policyVersionId }),
      ...(profileVersionId === '' ? {} : { schedulingProfileVersionId: profileVersionId }),
    },
  });
  if (r.kind !== 'ok') {
    const code =
      r.kind === 'error' && r.code === 'INVALID_TRANSITION'
        ? 'scoring_frozen'
        : r.kind === 'error' && r.code === 'INVALID_INPUT'
          ? 'scoring_invalid'
          : r.kind === 'error' && (r.code === 'FORBIDDEN' || r.status === 403)
            ? 'not_permitted'
            : 'platform_unavailable';
    to(slug, back, { error: code });
  }
  to(slug, back, { notice: 'scoring_pinned' });
}
