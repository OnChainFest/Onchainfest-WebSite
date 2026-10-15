'use server';

import { redirect } from 'next/navigation';
import type { AuthErrorCode } from '../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../_lib/platform';
import { currentVersions, scheduleVersions } from '../../../../../../_lib/schedule';
import { context, errorCode, field, to, UUID_RE } from '../../../action-support';

/**
 * ONCF-L3 scheduling actions over the ONCF-05E-C/E/F commands: open a draft, commit a reviewed
 * proposal into it, publish it, discard it. Each re-verifies the session, validates before any call
 * and sends the canonical command with an idempotency key. COMP_MANAGE_SCHEDULE, the proposal hash,
 * the conflict report and every state rule are decided by the API; refusals come back as a fixed
 * vocabulary code. Nothing here places a match or writes an assignment directly.
 */

type Failure = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

/** A refusal in organizer words. `step` picks the meaning of codes that depend on the command. */
function scheduleError(
  result: Failure,
  step: 'draft' | 'commit' | 'publish' | 'discard',
): AuthErrorCode {
  if (result.kind !== 'error') return errorCode(result, 'tournament');
  switch (result.code) {
    case 'FORBIDDEN':
      return 'schedule_not_permitted';
    case 'NOT_FOUND':
      return 'schedule_not_found';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'form_resubmitted';
    case 'ALREADY_EXISTS':
      return 'schedule_draft_exists';
    case 'CONCURRENCY_CONFLICT':
      // commit: the proposal no longer matches (PROPOSAL_STALE); publish: the report or base did.
      return step === 'commit' ? 'schedule_proposal_stale' : 'schedule_report_stale';
    case 'INVALID_TRANSITION':
      return step === 'commit'
        ? 'schedule_not_committable'
        : step === 'publish'
          ? 'schedule_publish_blocked'
          : 'schedule_transition';
    case 'INVALID_INPUT':
      return step === 'publish' ? 'schedule_acknowledge_mismatch' : 'schedule_invalid';
    default:
      return result.status === 403 ? 'schedule_not_permitted' : 'schedule_invalid';
  }
}

async function scope(form: FormData) {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const id = field(form, 'competitionId');
  if (!UUID_RE.test(id)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  return { slug, token, id, back: `tournaments/${id}/schedule` };
}

/** A version id from the form, which must be this competition's current draft. */
function versionOf(form: FormData, slug: string, back: string): string {
  const versionId = field(form, 'versionId');
  if (!UUID_RE.test(versionId)) to(slug, back, { error: 'schedule_not_found' });
  return versionId;
}

/**
 * "Generate a proposal": the preview needs the open draft, so one is opened when there is none
 * (POST …/schedule/drafts, idempotent). Generation itself is the page's read-only preview — no
 * proposal is stored; the page shows it and the commit re-computes it under the hash.
 */
export async function generateAction(form: FormData): Promise<never> {
  const { slug, token, id, back } = await scope(form);
  const target = field(form, 'scope');
  if (target !== 'all' && !UUID_RE.test(target)) to(slug, back, { error: 'schedule_invalid' });
  const list = await scheduleVersions(token, id);
  if (list.kind !== 'ok') to(slug, back, { error: scheduleError(list, 'draft') });
  if (currentVersions(list.data.items).draft === null) {
    const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/schedule/drafts`, {
      idempotencyKey: idempotencyKey(field(form, 'key')),
    });
    // A draft opened meanwhile (another tab, another organizer) is the one to review.
    if (r.kind !== 'ok' && !(r.kind === 'error' && r.code === 'ALREADY_EXISTS'))
      to(slug, back, { error: scheduleError(r, 'draft') });
  }
  redirect(`/app/orgs/${slug}/${back}?review=${target}#proposal`);
}

/** Opens a draft from the published schedule (to place matches added since, then publish again). */
export async function openDraftAction(form: FormData): Promise<never> {
  const { slug, token, id, back } = await scope(form);
  const r = await apiRequest(token, 'POST', `/v1/competitions/${id}/schedule/drafts`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
  });
  if (r.kind !== 'ok') to(slug, back, { error: scheduleError(r, 'draft') });
  to(slug, back, { notice: 'schedule_draft_opened' });
}

/**
 * Commits the reviewed proposal into the draft: only its hash and its own request scope are sent.
 * The API recomputes the proposal under the schedule lock; a different hash is PROPOSAL_STALE and a
 * proposal that doesn't place every match is refused — nothing is written either way.
 */
export async function commitProposalAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const versionId = versionOf(form, slug, back);
  const proposalHash = field(form, 'proposalHash');
  const target = field(form, 'scope');
  if (!/^sha256:[0-9a-f]{64}$/.test(proposalHash)) to(slug, back, { error: 'schedule_invalid' });
  if (target !== 'all' && !UUID_RE.test(target)) to(slug, back, { error: 'schedule_invalid' });
  const r = await apiRequest(token, 'POST', `/v1/schedule-versions/${versionId}/proposals/commit`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { proposalHash, ...(target === 'all' ? {} : { scope: { eventIds: [target] } }) },
  });
  if (r.kind !== 'ok') to(slug, back, { error: scheduleError(r, 'commit') });
  to(slug, back, { notice: 'schedule_committed' });
}

/**
 * Publishes the draft against the conflict report the organizer reviewed: its hash, the draft's
 * base version and — only when the organizer confirmed them — every warning's key. The API refuses
 * hard conflicts, a changed report or base, and an acknowledgement that isn't exactly the warnings.
 */
export async function publishAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const versionId = versionOf(form, slug, back);
  const reportHash = field(form, 'reportHash');
  const baseVersionId = field(form, 'baseVersionId');
  const warnings = form.getAll('warning').filter((v): v is string => typeof v === 'string');
  if (!/^sha256:[0-9a-f]{64}$/.test(reportHash)) to(slug, back, { error: 'schedule_invalid' });
  if (baseVersionId !== '' && !UUID_RE.test(baseVersionId))
    to(slug, back, { error: 'schedule_invalid' });
  if (warnings.some((k) => !/^sha256:[0-9a-f]{64}$/.test(k)) || warnings.length > 1000)
    to(slug, back, { error: 'schedule_invalid' });
  if (warnings.length > 0 && field(form, 'acknowledge') !== 'yes')
    to(slug, back, { error: 'schedule_acknowledge_required' });
  const r = await apiRequest(token, 'POST', `/v1/schedule-versions/${versionId}/publish`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: {
      baseVersionId: baseVersionId === '' ? null : baseVersionId,
      reportHash,
      acknowledgedConflictKeys: warnings,
    },
  });
  if (r.kind !== 'ok') to(slug, back, { error: scheduleError(r, 'publish') });
  to(slug, back, { notice: 'schedule_published' });
}

/** Discards the draft (terminal); the published schedule, if any, stays as it is. */
export async function discardAction(form: FormData): Promise<never> {
  const { slug, token, back } = await scope(form);
  const versionId = versionOf(form, slug, back);
  const reason = field(form, 'reason').trim();
  if (reason.length < 1 || reason.length > 500) to(slug, back, { error: 'reason_required' });
  const r = await apiRequest(token, 'POST', `/v1/schedule-versions/${versionId}/discard`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { reason },
  });
  if (r.kind !== 'ok') to(slug, back, { error: scheduleError(r, 'discard') });
  to(slug, back, { notice: 'schedule_discarded' });
}
