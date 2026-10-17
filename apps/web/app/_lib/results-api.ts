import { apiRequest, type ApiResult } from './platform';
import type { ResultContent, ResultVersion } from './results';
import type { SheetIssue } from './score-sheet';

/**
 * ONCF-L5 result reads and the pure score-sheet check, over the existing ResultLedger routes
 * (COMP_VIEW_PRIVATE). Writes go through the results page's server actions; nothing here decides.
 */

export function contestResults(
  token: string,
  contestId: string,
): Promise<ApiResult<{ contestId: string; versions: ResultVersion[] }>> {
  return apiRequest(token, 'GET', `/v1/contests/${contestId}/results`);
}

export type SheetCheck =
  { ok: true; content: ResultContent; contentHash: string } | { ok: false; issues: SheetIssue[] };

/** Validates a sheet under the contest's pinned ruleset. Writes nothing (ONCF-05C). */
export function checkSheet(
  token: string,
  contestId: string,
  sheet: Record<string, unknown>,
): Promise<ApiResult<SheetCheck>> {
  return apiRequest(token, 'POST', `/v1/contests/${contestId}/score-sheets/validate`, {
    body: { sheet },
  });
}
