'use server';

import type { AuthErrorCode } from '../../../../../../../../_lib/auth/messages';
import { decodeTarget } from '../../../../../../../../_lib/advancement';
import { idempotencyKey } from '../../../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../../../_lib/platform';
import { context, field, to, UUID_RE } from '../../../../../action-support';

/**
 * ONCF-05D advancement commands. Each is a single API command decided server-side (permission
 * COMP_GENERATE_STRUCTURE, preview hash, downstream state, eligibility, duplicates). The page
 * never mutates a slot: it confirms a preview it showed, or records a reasoned override.
 */

function code(r: Exclude<ApiResult<unknown>, { kind: 'ok' }>): AuthErrorCode {
  if (r.kind === 'unavailable' || r.kind === 'unauthenticated') return 'platform_unavailable';
  switch (r.code) {
    case 'FORBIDDEN':
      return 'not_permitted';
    case 'CONCURRENCY_CONFLICT':
      return 'advancement_changed';
    case 'INVALID_TRANSITION':
      return 'advancement_blocked';
    case 'INVALID_INPUT':
      return 'advancement_invalid';
    case 'NOT_FOUND':
      return 'tournament_not_found';
    default:
      return r.status === 403 ? 'not_permitted' : 'unknown';
  }
}

function ids(form: FormData, slug: string) {
  const competitionId = field(form, 'competitionId');
  const eventId = field(form, 'eventId');
  if (!UUID_RE.test(competitionId) || !UUID_RE.test(eventId))
    to(slug, 'tournaments', { error: 'tournament_not_found' });
  return { eventId, back: `tournaments/${competitionId}/categories/${eventId}/progression` };
}

export async function commitUnitAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  const unitKey = field(form, 'unitKey');
  const previewHash = field(form, 'previewHash');
  if (!/^[a-z]+:[A-Za-z0-9:_-]{1,120}$/.test(unitKey) || !/^sha256:[0-9a-f]{64}$/.test(previewHash))
    to(slug, back, { error: 'advancement_invalid' });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/advancement/commit`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { units: [{ unitKey, previewHash }] },
  });
  if (r.kind !== 'ok') to(slug, back, { error: code(r) });
  to(slug, back, { notice: 'advancement_committed' });
}

export async function overrideAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  const target = decodeTarget(field(form, 'target'));
  const participant = field(form, 'participantId');
  const reason = field(form, 'reason').trim();
  if (target === undefined || (participant !== '' && !UUID_RE.test(participant)))
    to(slug, back, { error: 'advancement_invalid' });
  if (reason.length === 0) to(slug, back, { error: 'advancement_reason' });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/advancement/overrides`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { target, participantId: participant === '' ? null : participant, reason },
  });
  if (r.kind !== 'ok') to(slug, back, { error: code(r) });
  to(slug, back, { notice: 'advancement_overridden' });
}

export async function revokeOverrideAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const { eventId, back } = ids(form, slug);
  const target = decodeTarget(field(form, 'target'));
  const reason = field(form, 'reason').trim();
  if (target === undefined) to(slug, back, { error: 'advancement_invalid' });
  if (reason.length === 0) to(slug, back, { error: 'advancement_reason' });
  const r = await apiRequest(token, 'POST', `/v1/events/${eventId}/advancement/overrides/revoke`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { target, reason },
  });
  if (r.kind !== 'ok') to(slug, back, { error: code(r) });
  to(slug, back, { notice: 'advancement_override_revoked' });
}
