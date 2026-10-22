'use server';

import type { AuthErrorCode } from '../../../../../../_lib/auth/messages';
import { idempotencyKey } from '../../../../../../_lib/onboarding-input';
import { apiRequest, type ApiResult } from '../../../../../../_lib/platform';
import {
  RECOGNITION_LEVEL,
  TRANSITIONS,
  type ResultContent,
  type TransitionKey,
} from '../../../../../../_lib/results';
import { checkSheet, contestResults } from '../../../../../../_lib/results-api';
import { isEntryFamily, issueText, sheetFromForm } from '../../../../../../_lib/score-sheet';
import { context, field, to, UUID_RE } from '../../../action-support';

/**
 * ONCF-L5 result commands, each sent once to the existing ResultLedger route: enter (T2), correct
 * (T7 + T2 + T3, atomic), accept (T3) and declare official (T5). The API validates the sheet under
 * the pinned ruleset, authorizes the caller's own principal against its result-authority grant
 * (ADR-0077), and serializes every write on the result's ledger stream. Before entering anything
 * the action re-reads the match's result and runs the API's pure sheet check, so the organizer
 * confirms the exact score the API will record (its content hash) — and a screen that went stale
 * meanwhile never writes. Refusals are never retried.
 */

type Failure = Exclude<ApiResult<unknown>, { kind: 'ok' }>;

export interface EntryState {
  readonly kind: 'idle' | 'review' | 'error';
  readonly error?: AuthErrorCode;
  /** Sheet problems, already in organizer words. */
  readonly issues?: readonly string[];
  /** The API-validated content the organizer is about to record, and its hash. */
  readonly content?: ResultContent;
  readonly hash?: string;
  /** What was typed, so the form re-renders with it. */
  readonly values: Readonly<Record<string, string>>;
  readonly nextKey: string;
  /** Bumped on every answer: the form remounts with `values`. */
  readonly seq: number;
}

const SHEET_FIELD = /^(set|tb|per|ot|hole)\d{1,2}[ab]?$|^(mtb|reg|tot)[ab]$|^(endedBy|ending)$/;

function failure(r: Failure): AuthErrorCode {
  if (r.kind !== 'error') return 'platform_unavailable';
  switch (r.code) {
    case 'AUTHORITY_DENIED':
      return 'result_no_authority';
    case 'FORBIDDEN':
      return 'result_not_permitted';
    case 'INVALID_INPUT':
      return 'result_invalid';
    case 'CURRENT_VERSION_CONFLICT':
    case 'CONCURRENCY_CONFLICT':
    case 'IMMUTABLE':
      return 'result_changed';
    case 'INVALID_TRANSITION':
      // ONCF-L6: the category was completed or cancelled meanwhile; its results are frozen.
      // WP-P0-1: the match is not in progress or completed (not started, cancelled or voided).
      return r.reason === 'RESULTS_FROZEN'
        ? 'result_frozen'
        : r.reason === 'CONTEST_NOT_PLAYABLE'
          ? 'result_match_not_playable'
          : 'result_blocked';
    case 'NOT_FOUND':
      return 'result_not_found';
    default:
      return r.status === 403 ? 'result_not_permitted' : 'unknown';
  }
}

/** Check (validate + show what will be recorded), then record exactly that: enter or correct. */
export async function entryAction(prev: EntryState, form: FormData): Promise<EntryState> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const values: Record<string, string> = {};
  for (const [k, v] of form.entries())
    if (SHEET_FIELD.test(k) && typeof v === 'string') values[k] = v.slice(0, 8);
  values.reason = field(form, 'reason').slice(0, 200);
  const base = { values, nextKey: prev.nextKey, seq: prev.seq + 1 };
  const fail = (error: AuthErrorCode, fresh = false): EntryState => ({
    kind: 'error',
    error,
    ...base,
    ...(fresh ? { nextKey: idempotencyKey('') } : {}),
  });

  const competitionId = field(form, 'competitionId');
  const contestId = field(form, 'contestId');
  if (!UUID_RE.test(competitionId) || !UUID_RE.test(contestId)) return fail('result_not_found');
  const family = field(form, 'family');
  if (!isEntryFamily(family)) return fail('result_unsupported');
  const correcting = field(form, 'mode') === 'correct';
  const supersedes = field(form, 'supersedes');
  if (correcting && !UUID_RE.test(supersedes)) return fail('result_not_found');
  const reason = values.reason.trim();
  if (correcting && reason === '') return fail('result_reason_required');

  const parsed = sheetFromForm(family, (n) => values[n] ?? '');
  if ('issues' in parsed) return { kind: 'error', issues: parsed.issues.map(issueText), ...base };

  // The match's result as it is now — not as it was when the page rendered.
  const now = await contestResults(token, contestId);
  if (now.kind !== 'ok') return fail(failure(now));
  const current = now.data.versions.find((v) => v.current) ?? null;
  if (!correcting && now.data.versions.length > 0) return fail('result_entered_meanwhile');
  if (correcting && current?.resultVersionId !== supersedes) return fail('result_changed');

  const check = await checkSheet(token, contestId, parsed.sheet);
  if (check.kind !== 'ok') return fail(failure(check));
  if (!check.data.ok)
    return { kind: 'error', issues: check.data.issues.slice(0, 8).map(issueText), ...base };
  if (correcting && current?.contentHash === check.data.contentHash)
    return fail('result_same_as_current');

  const review: EntryState = {
    kind: 'review',
    content: check.data.content,
    hash: check.data.contentHash,
    ...base,
  };
  if (field(form, 'intent') !== 'record') return review;
  // Recording needs the summary the organizer saw: a changed score is checked again first.
  if (field(form, 'hash') !== check.data.contentHash)
    return { ...review, error: 'result_review_changed' };

  const r = await apiRequest(
    token,
    'POST',
    correcting
      ? `/v1/contests/${contestId}/results/corrections`
      : `/v1/contests/${contestId}/results`,
    {
      idempotencyKey: idempotencyKey(field(form, 'key')),
      body: correcting
        ? {
            sheet: parsed.sheet,
            supersedesVersionId: supersedes,
            reason,
            recognitionLevel: RECOGNITION_LEVEL,
          }
        : { sheet: parsed.sheet, recognitionLevel: RECOGNITION_LEVEL },
    },
  );
  if (r.kind !== 'ok') return fail(failure(r), true);
  to(slug, `tournaments/${competitionId}/results`, {
    notice: correcting ? 'result_corrected' : 'result_entered',
  });
}

/** Accept (→ provisional) or declare official, once; on a refusal, says whether it was stale. */
export async function transitionAction(form: FormData): Promise<never> {
  const slug = field(form, 'slug');
  const { token } = await context(slug);
  const competitionId = field(form, 'competitionId');
  if (!UUID_RE.test(competitionId)) to(slug, 'tournaments', { error: 'tournament_not_found' });
  const back = `tournaments/${competitionId}/results`;
  const step = field(form, 'step');
  if (!Object.hasOwn(TRANSITIONS, step)) to(slug, back, { error: 'result_blocked' });
  const t = TRANSITIONS[step as TransitionKey];
  const versionId = field(form, 'versionId');
  const contestId = field(form, 'contestId');
  if (!UUID_RE.test(versionId) || !UUID_RE.test(contestId))
    to(slug, back, { error: 'result_not_found' });
  if (t.final && field(form, 'confirm') !== 'yes')
    to(slug, back, { error: 'result_confirm_required' });
  const r = await apiRequest(token, 'POST', `/v1/result-versions/${versionId}/${t.path}`, {
    idempotencyKey: idempotencyKey(field(form, 'key')),
    body: { recognitionLevel: RECOGNITION_LEVEL },
  });
  if (r.kind === 'ok')
    to(slug, back, { notice: step === 'accept' ? 'result_accepted' : 'result_official' });
  let error = failure(r);
  if (
    r.kind === 'error' &&
    r.reason !== 'RESULTS_FROZEN' &&
    r.reason !== 'CONTEST_NOT_PLAYABLE' &&
    ['INVALID_TRANSITION', 'CONCURRENCY_CONFLICT', 'CURRENT_VERSION_CONFLICT'].includes(
      r.code ?? '',
    )
  ) {
    // Read once: done already (another tab, another staff member), overtaken, or not possible.
    const now = await contestResults(token, contestId);
    if (now.kind === 'ok') {
      const v = now.data.versions.find((x) => x.resultVersionId === versionId);
      const reached = t.to === 'PROVISIONAL' ? ['PROVISIONAL', 'OFFICIAL'] : ['OFFICIAL'];
      if (v !== undefined && reached.includes(v.status)) error = 'result_already_done';
      else if (now.data.versions.some((x) => x.current && x.resultVersionId !== versionId))
        error = 'result_changed';
    }
  }
  to(slug, back, { error });
}
