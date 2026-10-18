'use server';

import type { AuthErrorCode } from '../../../../../../_lib/auth/messages';
import { operationOf, operationPath, type Operation } from '../../../../../../_lib/operations';
import { apiRequest, type ApiResult } from '../../../../../../_lib/platform';
import { eventBracket } from '../../../../../../_lib/schedule';
import { managedCompetition } from '../../../../../../_lib/tournaments';
import { context, errorCode, field, to, UUID_RE } from '../../../action-support';

/**
 * ONCF-L4 operations: one action for every lifecycle command the workspace offers — tournament
 * activate/complete/cancel, category start/complete/cancel, match start/complete/cancel/void —
 * each sent once to its existing route. The session is re-verified, the reason and the explicit
 * confirmation of final operations are checked before any call, and the API decides permission and
 * transition under its lifecycle locks. A refusal is never retried: when the API says the
 * transition isn't possible, the target's current status is read once to tell the organizer
 * whether someone else got there first, it was already done, or something it needs isn't ready.
 */

type Failure = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

const L6_ERRORS: Readonly<Record<string, AuthErrorCode>> = {
  CONTESTS_OPEN: 'operation_contests_open',
  RESULTS_NOT_OFFICIAL: 'operation_results_not_official',
  OUTCOME_UNDECIDED: 'operation_outcome_undecided',
  NO_COMPLETED_EVENT: 'operation_no_completed_category',
  EVENT_FINISHED: 'operation_event_finished',
  OUTCOME_INPUTS_CHANGED: 'operation_stale',
};

const STATUS_RE = /^[A-Z_]{1,32}$/;

/** The target's status as the API reports it now (null: can't tell). Read-only. */
async function currentStatus(
  token: string,
  competitionId: string,
  o: Operation,
  targetId: string,
  eventId: string,
): Promise<string | null> {
  const m = await managedCompetition(token, competitionId);
  if (m.kind !== 'ok') return null;
  if (o.target === 'competition') return m.data.competition.status;
  if (o.target === 'category') return m.data.events.find((e) => e.id === targetId)?.status ?? null;
  const event = m.data.events.find((e) => e.id === eventId);
  if (event === undefined) return null;
  const b = await eventBracket(m.data.competition.slug, event.slug);
  if (b.kind !== 'ok') return null;
  for (const r of b.data.rounds)
    for (const c of r.contests) if (c.contestId === targetId) return c.status;
  return null;
}

async function operationError(
  r: Failure,
  o: Operation,
  read: () => Promise<string | null>,
  shown: string,
): Promise<AuthErrorCode> {
  if (r.kind !== 'error') return errorCode(r, 'tournament');
  switch (r.code) {
    case 'FORBIDDEN':
      return 'operation_not_permitted';
    case 'NOT_FOUND':
      return 'operation_not_found';
    case 'INVALID_INPUT':
      return o.reason ? 'reason_required' : 'operation_invalid';
    case 'INVALID_TRANSITION':
    case 'CONCURRENCY_CONFLICT': {
      // ONCF-L6 (ADR-0078): completion and freeze refusals say exactly what is missing.
      const known = r.reason === undefined || r.reason === null ? undefined : L6_ERRORS[r.reason];
      if (known !== undefined) return known;
      const now = await read();
      if (now === null || shown === '') return 'tournament_transition';
      if (now === o.result) return 'operation_already_done';
      return now !== shown ? 'operation_stale' : 'operation_blocked';
    }
    default:
      return r.status === 403 ? 'operation_not_permitted' : 'operation_invalid';
  }
}

export async function operateAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = field(form, 'competitionId');
  if (!UUID_RE.test(id)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  const back = `tournaments/${id}/operations`;
  const o = operationOf(field(form, 'target'), field(form, 'command'));
  if (o === null) to(slug, back, { error: 'operation_invalid' });
  const targetId = field(form, 'targetId');
  const eventId = field(form, 'eventId');
  if (!UUID_RE.test(targetId) || (o.target === 'competition' && targetId !== id))
    to(slug, back, { error: 'operation_invalid' });
  if (o.target === 'match' && !UUID_RE.test(eventId))
    to(slug, back, { error: 'operation_invalid' });
  const shown = STATUS_RE.test(field(form, 'from')) ? field(form, 'from') : '';
  const reason = field(form, 'reason').trim();
  if (o.reason && reason === '') to(slug, back, { error: 'reason_required' });
  if (o.reason && reason.length > 500) to(slug, back, { error: 'operation_invalid' });
  if (o.final && field(form, 'confirm') !== 'yes')
    to(slug, back, { error: 'operation_confirm_required' });
  const r = await apiRequest(token, 'POST', operationPath(o, targetId), {
    ...(o.reason ? { body: { reason } } : {}),
  });
  if (r.kind !== 'ok')
    to(slug, back, {
      error: await operationError(
        r,
        o,
        () => currentStatus(token, id, o, targetId, eventId),
        shown,
      ),
    });
  to(slug, back, { notice: o.notice });
}
