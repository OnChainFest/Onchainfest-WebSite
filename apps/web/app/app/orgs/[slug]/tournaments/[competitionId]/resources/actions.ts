'use server';

import type { AuthErrorCode } from '../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../_lib/platform';
import {
  isResourceType,
  parseAvailabilityForm,
  parseResourceForm,
  type FactInput,
  type ResourceView,
} from '../../../../../../_lib/resources';
import { validTimeZone } from '../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { orgContext } from '../../../../../../_lib/org-context';
import { context, errorCode, field, to, UUID_RE } from '../../../action-support';

/**
 * ONCF-L2 resources and availability actions. Same shape as the staff actions: re-verify the
 * session and the caller's membership, validate before any call, send the canonical ONCF-05E-A
 * command with an idempotency key, redirect with a fixed-vocabulary code. COMP_EDIT, label
 * uniqueness, duplicates, closed competitions and every domain rule are decided by the API.
 */

type Failure = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

function resourceError(result: Failure): AuthErrorCode {
  if (result.kind !== 'error') return errorCode(result, 'tournament');
  switch (result.code) {
    case 'FORBIDDEN':
      return 'resource_not_permitted';
    case 'ALREADY_EXISTS':
      return 'resource_duplicate_label';
    case 'NOT_FOUND':
      return 'resource_not_found';
    case 'INVALID_TRANSITION':
      return 'resource_transition';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'form_resubmitted';
    case 'INVALID_INPUT':
      return 'resource_invalid';
    default:
      return result.status === 403 ? 'resource_not_permitted' : 'resource_invalid';
  }
}

function availabilityError(result: Failure): AuthErrorCode {
  if (result.kind !== 'error') return errorCode(result, 'tournament');
  switch (result.code) {
    case 'FORBIDDEN':
      return 'availability_not_permitted';
    case 'ALREADY_EXISTS':
      return 'availability_duplicate';
    case 'NOT_FOUND':
      return 'availability_not_found';
    case 'INVALID_TRANSITION':
      return 'availability_transition';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'form_resubmitted';
    case 'INVALID_INPUT':
      return 'availability_invalid';
    default:
      return result.status === 403 ? 'availability_not_permitted' : 'availability_invalid';
  }
}

async function scope(form: FormData) {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = field(form, 'competitionId');
  if (!UUID_RE.test(id)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  return { slug, token, id, back: `tournaments/${id}/resources` };
}

const reasonOf = (form: FormData) => field(form, 'reason').trim();

export async function createResourceAction(form: FormData): Promise<never> {
  const { slug, token, id, back } = await scope(form);
  const typeCode = field(form, 'typeCode');
  if (!isResourceType(typeCode)) to(slug, back, { error: 'resource_type' });
  const parsed = parseResourceForm(form, typeCode);
  if (!parsed.ok) to(slug, back, { error: parsed.error });
  const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/resources`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { typeCode, ...parsed.value },
  });
  if (r.kind !== 'ok') to(slug, back, { error: resourceError(r) });
  to(slug, back, { notice: 'resource_created' });
}

/** PUT replaces the whole revision: the body is always complete (see `parseResourceForm`). */
export async function updateResourceAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const resourceId = field(form, 'resourceId');
  const typeCode = field(form, 'typeCode');
  if (!UUID_RE.test(resourceId)) to(slug, back, { error: 'resource_not_found' });
  if (!isResourceType(typeCode)) to(slug, back, { error: 'resource_type' });
  const parsed = parseResourceForm(form, typeCode);
  if (!parsed.ok) to(slug, back, { error: parsed.error });
  const r = await apiRequest(token, 'PUT', `/v1/resources/${resourceId}`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: parsed.value,
  });
  if (r.kind !== 'ok') to(slug, back, { error: resourceError(r) });
  to(slug, back, { notice: 'resource_updated' });
}

export async function resourceStatusAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const resourceId = field(form, 'resourceId');
  const command = field(form, 'command');
  if (!UUID_RE.test(resourceId)) to(slug, back, { error: 'resource_not_found' });
  if (command !== 'retire' && command !== 'reactivate')
    to(slug, back, { error: 'resource_invalid' });
  const reason = reasonOf(form);
  if (reason.length < 1 || reason.length > 500) to(slug, back, { error: 'reason_required' });
  const r = await apiRequest(token, 'POST', `/v1/resources/${resourceId}/${command}`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { reason },
  });
  if (r.kind !== 'ok') to(slug, back, { error: resourceError(r) });
  to(slug, back, {
    notice: command === 'retire' ? 'resource_retired' : 'resource_reactivated',
  });
}

/**
 * The layer a fact belongs to and the zone its local times are written in: the resource's own
 * zone (else the competition's), or the competition's for competition-wide facts. The resource
 * and the competition are read back from the API, never trusted from the form.
 */
async function layer(
  form: FormData,
  slug: string,
  token: string,
  id: string,
  back: string,
): Promise<{ resourceId: string | null; zone: string }> {
  const raw = field(form, 'resourceId');
  if (raw !== '' && !UUID_RE.test(raw)) to(slug, back, { error: 'resource_not_found' });
  const org = await orgContext(slug);
  if (org.kind !== 'ok') to(slug, 'tournaments', { error: 'tournament_not_found' });
  const t = await tournamentFor(org.ctx, id);
  if (t.kind !== 'ok')
    to(slug, back, {
      error: t.kind === 'unavailable' ? 'platform_unavailable' : 'tournament_not_found',
    });
  const competitionZone = t.data.competition.profile.timezone;
  if (raw === '') return { resourceId: null, zone: competitionZone };
  const r = await apiRequest<ResourceView>(token, 'GET', `/v1/resources/${raw}`);
  if (r.kind !== 'ok') to(slug, back, { error: resourceError(r) });
  if (r.data.competitionId !== id) to(slug, back, { error: 'resource_not_found' });
  const own = r.data.timezone;
  return {
    resourceId: raw,
    zone: own !== null && validTimeZone(own) ? own : competitionZone,
  };
}

/** One POST per fact; several weekdays get distinct keys derived from the form's key. */
async function addFacts(
  token: string,
  id: string,
  resourceId: string | null,
  facts: readonly FactInput[],
  key: string,
): Promise<{ added: number; failure: Failure | null }> {
  let added = 0;
  let failure: Failure | null = null;
  for (const fact of facts) {
    const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/availability`, {
      idempotencyKey:
        facts.length === 1 ? key : `${key}.d${fact.kind === 'WEEKLY' ? fact.weekday : 0}`,
      body: { resourceId, fact },
    });
    if (r.kind === 'ok') added += 1;
    else failure ??= r;
  }
  return { added, failure };
}

export async function addAvailabilityAction(form: FormData): Promise<never> {
  const { slug, token, id, back } = await scope(form);
  const target = await layer(form, slug, token, id, back);
  const parsed = parseAvailabilityForm(form, target.zone);
  if (!parsed.ok) to(slug, back, { error: parsed.error });
  const { added, failure } = await addFacts(
    token,
    id,
    target.resourceId,
    parsed.value,
    idempotencyKey(field(form, 'key')),
  );
  if (failure !== null)
    to(slug, back, { error: added > 0 ? 'availability_partial' : availabilityError(failure) });
  to(slug, back, { notice: 'availability_added' });
}

export async function revokeAvailabilityAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const availabilityId = field(form, 'availabilityId');
  if (!UUID_RE.test(availabilityId)) to(slug, back, { error: 'availability_not_found' });
  const reason = reasonOf(form);
  if (reason.length < 1 || reason.length > 500) to(slug, back, { error: 'reason_required' });
  const r = await apiRequest(token, 'POST', `/v1/availability/${availabilityId}/revoke`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { reason },
  });
  if (r.kind !== 'ok') to(slug, back, { error: availabilityError(r) });
  to(slug, back, { notice: 'availability_removed' });
}

/**
 * Changing declared hours: availability facts are immutable, so this is two commands — revoke the
 * old fact, then add the new one. They are NOT atomic: when the revoke succeeds and the add fails,
 * the organizer is told the old hours are gone and the new ones must be added again.
 */
export async function replaceAvailabilityAction(form: FormData): Promise<never> {
  const { slug, token, id, back } = await scope(form);
  const availabilityId = field(form, 'availabilityId');
  if (!UUID_RE.test(availabilityId)) to(slug, back, { error: 'availability_not_found' });
  const reason = reasonOf(form);
  if (reason.length < 1 || reason.length > 500) to(slug, back, { error: 'reason_required' });
  const target = await layer(form, slug, token, id, back);
  const parsed = parseAvailabilityForm(form, target.zone);
  if (!parsed.ok) to(slug, back, { error: parsed.error });
  const key = idempotencyKey(field(form, 'key'));
  const revoked = await apiRequest(token, 'POST', `/v1/availability/${availabilityId}/revoke`, {
    idempotencyKey: `${key}.revoke`,
    body: { reason },
  });
  if (revoked.kind !== 'ok') to(slug, back, { error: availabilityError(revoked) });
  const { failure } = await addFacts(token, id, target.resourceId, parsed.value, `${key}.add`);
  if (failure !== null) to(slug, back, { error: 'availability_replace_partial' });
  to(slug, back, { notice: 'availability_replaced' });
}
