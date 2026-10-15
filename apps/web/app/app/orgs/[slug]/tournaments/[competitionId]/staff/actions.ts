'use server';

import type { AuthErrorCode } from '../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../_lib/platform';
import { isStaffRole } from '../../../../../../_lib/staff';
import { context, errorCode, field, to, UUID_RE } from '../../../action-support';

/**
 * ONCF-L1 competition staff actions. Same shape as the tournament actions: re-verify the session
 * and the caller's membership, call the canonical route, redirect with a fixed-vocabulary code.
 * COMP_MANAGE_STAFF, duplicates and ended assignments are decided by the competition store.
 */

function staffError(result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): AuthErrorCode {
  if (result.kind !== 'error') return errorCode(result, 'tournament');
  switch (result.code) {
    case 'FORBIDDEN':
      return 'staff_not_permitted';
    case 'ALREADY_EXISTS':
      return 'staff_duplicate';
    case 'NOT_FOUND':
      return 'staff_not_found';
    case 'INVALID_TRANSITION':
      return 'staff_already_removed';
    case 'INVALID_INPUT':
      return 'staff_invalid';
    default:
      return result.status === 403 ? 'staff_not_permitted' : 'staff_invalid';
  }
}

function competitionId(form: FormData, slug: string): string {
  const id = field(form, 'competitionId');
  if (!UUID_RE.test(id)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  return id;
}

export async function addStaffAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const back = `tournaments/${id}/staff`;
  const personId = field(form, 'personId');
  const role = field(form, 'role');
  if (!UUID_RE.test(personId) || !isStaffRole(role)) to(slug, back, { error: 'staff_invalid' });
  const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/staff`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { personId, role },
  });
  if (r.kind !== 'ok') to(slug, back, { error: staffError(r) });
  to(slug, back, { notice: 'staff_added' });
}

export async function removeStaffAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = competitionId(form, slug);
  const back = `tournaments/${id}/staff`;
  const staffId = field(form, 'staffId');
  if (!UUID_RE.test(staffId)) to(slug, back, { error: 'staff_not_found' });
  const r = await apiRequest(token, 'DELETE', `/v1/competition-staff/${staffId}`);
  if (r.kind !== 'ok') to(slug, back, { error: staffError(r) });
  to(slug, back, { notice: 'staff_removed' });
}
