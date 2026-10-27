import type { ConflictOfInterestChecker } from '@br/authority';
import type { ScoreSheet } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  RecognitionLevel,
  type ResultVersionContent,
  type ResultVersionStatus,
  type Uuid,
} from '@br/domain';
import { sql } from 'kysely';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import {
  competitionParticipationChecker,
  personParticipatesInCompetition,
} from './competition-participation';
import { loadCompetition, loadEvent, requireCompPermission } from './competition-support';
import type { Db } from './db';
import type { ScoringStore } from './scoring-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * ONCF-05D contest-result lifecycle over the API (ADR-0064). Two gates, never merged:
 *  · operational — the caller is staff of the competition (COMP_VIEW_PRIVATE);
 *  · sporting   — the ResultLedger authorizes the caller's own PERSON principal against Authority
 *    Engine grants (SUBMIT_RESULT, ACCEPT_RESULT, DECLARE_OFFICIAL, CORRECT_RESULT) for exactly
 *    this contest's hierarchy path. No COMP_* permission ever grants a sporting capability.
 * Score sheets are validated under the pinned ruleset (05C) and become the canonical content the
 * ledger hashes; the principal is derived server-side from the account (SELF person only), never
 * taken from the request.
 *
 * Conflict of interest (BRT-03R, fail closed): an explicitly injected checker answers when one is
 * given. Otherwise, with `participationIndex` (ADR-0077 §2.5, the production composition), each
 * action builds a `competition-participation/1` checker for the actor from database facts. Without
 * either, conflict-sensitive actions are refused.
 */
export class ContestResultService {
  private readonly db: Db;
  private readonly scoring: ScoringStore;
  private readonly conflictChecker: ConflictOfInterestChecker | undefined;
  private readonly resolver: CompetitionHierarchyResolver;
  private readonly participationIndex: boolean;

  constructor(
    db: Db,
    scoring: ScoringStore,
    options: { conflictChecker?: ConflictOfInterestChecker; participationIndex?: boolean } = {},
  ) {
    this.db = db;
    this.scoring = scoring;
    this.conflictChecker = options.conflictChecker;
    this.resolver = new CompetitionHierarchyResolver(db);
    this.participationIndex =
      options.conflictChecker === undefined && options.participationIndex === true;
  }

  /** Competition staff gate + the caller's own PERSON principal (created on first use). */
  private async actor(accountId: string, contestId: string) {
    const contest = await inTransaction(this.db, ModuleRole.competition, async (ctx) => {
      const { rows } = await sql<{ event_id: string; discipline_ref: string }>`
        SELECT c.event_id, d.code || '@' || dv.version AS discipline_ref
        FROM competition.contest c JOIN competition.event e ON e.id = c.event_id
        JOIN sports.discipline_version dv ON dv.id = e.discipline_version_id
        JOIN sports.discipline d ON d.id = dv.discipline_id WHERE c.id = ${contestId}`.execute(
        ctx.trx,
      );
      const c = rows[0];
      if (c === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
      const e = await loadEvent(ctx, c.event_id);
      await requireCompPermission(
        ctx,
        accountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      return { ...c, competition_id: e.competitionId };
    });
    const self = await inTransaction(this.db, ModuleRole.identity, async (ctx) => {
      const { rows } = await sql<{ p: string | null; person_id: string }>`
        SELECT identity.ensure_person_principal(${accountId}::uuid, apc.person_id) AS p, apc.person_id
        FROM identity.account_person_control apc
        WHERE apc.account_id = ${accountId} AND apc.control_kind = 'SELF'
        ORDER BY apc.recorded_at LIMIT 1`.execute(ctx.trx);
      return rows[0];
    });
    if (self?.p === undefined || self.p === null)
      throw new DomainError(DomainErrorCode.FORBIDDEN, 'acting on results needs your own person', {
        reason: 'NO_PERSON_PRINCIPAL',
      });
    const principalId = self.p as Uuid;
    let conflictChecker = this.conflictChecker;
    if (this.participationIndex) {
      const participates = await inTransaction(this.db, ModuleRole.competition, (ctx) =>
        personParticipatesInCompetition(ctx, self.person_id, contest.competition_id),
      );
      conflictChecker = competitionParticipationChecker({
        principalId,
        competitionId: contest.competition_id,
        participates,
      });
    }
    // WP-P0-3 (D-16): every command's ledger is bound to this account, so the ledger re-checks
    // its current OWNER / ADMIN role inside the write transaction (ADR-0079). COMP_VIEW_PRIVATE
    // above only keeps non-staff out early; it is not the result-staff check.
    const ledger = createCompetitionResultLedger(this.db, {
      ...(conflictChecker === undefined ? {} : { conflictChecker }),
      actorAccountId: accountId,
    });
    return { principalId, disciplineRef: contest.discipline_ref, ledger };
  }

  private scope(contestId: string, recognitionLevel: string) {
    if (!(Object.values(RecognitionLevel) as string[]).includes(recognitionLevel))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'unknown recognition level');
    return this.resolver.scopeOf('CONTEST', contestId, {
      recognitionLevel: recognitionLevel as RecognitionLevel,
    });
  }

  private async validated(actorAccountId: string, contestId: string, sheet: ScoreSheet) {
    const v = await this.scoring.validateScoreSheet({ actorAccountId, contestId, sheet });
    if (!v.ok)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'the score sheet is not valid under the pinned ruleset',
        {
          reason: 'SCORE_SHEET_INVALID',
          issues: v.issues.slice(0, 20),
        },
      );
    return v;
  }

  /** Validates a score sheet and submits it as a new version (T2, SUBMIT_RESULT). */
  async submit(input: {
    actorAccountId: string;
    contestId: string;
    sheet: ScoreSheet;
    recognitionLevel: string;
    idempotencyKey: string;
  }) {
    const v = await this.validated(input.actorAccountId, input.contestId, input.sheet);
    const a = await this.actor(input.actorAccountId, input.contestId);
    const scope = await this.scope(input.contestId, input.recognitionLevel);
    // D-P3: the contest's Result identity, the draft and T2 commit together or not at all, so a
    // refused caller (no current OWNER / ADMIN role, no or a stale grant, closed or unplayed
    // contest) leaves nothing behind.
    const out = await a.ledger.submitContent({
      scopeType: 'CONTEST',
      scopeTargetId: input.contestId as Uuid,
      authorPrincipalId: a.principalId,
      disciplineVersionRef: a.disciplineRef,
      content: v.content,
      actorPrincipalId: a.principalId,
      scope,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      resultVersionId: out.resultVersionId,
      status: out.status,
      contentHash: out.contentHash,
    };
  }

  private async contestOfVersion(resultVersionId: string): Promise<string> {
    const contestId = await inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const { rows } = await sql<{ contest_id: string }>`
        SELECT r.scope_target_id AS contest_id FROM results.result_version v JOIN results.result r ON r.id = v.result_id
        WHERE v.id = ${resultVersionId} AND r.scope_type = 'CONTEST'`.execute(ctx.trx);
      return rows[0]?.contest_id;
    });
    if (contestId === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
    return contestId;
  }

  /** T3 (ACCEPT_RESULT) or T5 (DECLARE_OFFICIAL). */
  async transition(input: {
    actorAccountId: string;
    resultVersionId: string;
    toStatus: 'PROVISIONAL' | 'OFFICIAL';
    recognitionLevel: string;
    idempotencyKey: string;
  }) {
    if (!/^[0-9a-f-]{36}$/.test(input.resultVersionId))
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'result version not found');
    const contestId = await this.contestOfVersion(input.resultVersionId);
    const a = await this.actor(input.actorAccountId, contestId);
    const out = await a.ledger.transition({
      resultVersionId: input.resultVersionId as Uuid,
      toStatus: input.toStatus,
      actorPrincipalId: a.principalId,
      scope: await this.scope(contestId, input.recognitionLevel),
      idempotencyKey: input.idempotencyKey,
    });
    return { resultVersionId: out.resultVersionId, status: out.status };
  }

  /** Atomic correction (CORRECT_RESULT + ACCEPT_RESULT): the new version supersedes the current one. */
  async correct(input: {
    actorAccountId: string;
    contestId: string;
    sheet: ScoreSheet;
    supersedesVersionId: string;
    reason: string;
    recognitionLevel: string;
    idempotencyKey: string;
  }) {
    const v = await this.validated(input.actorAccountId, input.contestId, input.sheet);
    const a = await this.actor(input.actorAccountId, input.contestId);
    const scope = await this.scope(input.contestId, input.recognitionLevel);
    // D-P3: as for `submit`, nothing persists unless the correction itself commits.
    const out = await a.ledger.correctContent({
      scopeType: 'CONTEST',
      scopeTargetId: input.contestId as Uuid,
      authorPrincipalId: a.principalId,
      disciplineVersionRef: a.disciplineRef,
      content: v.content,
      supersedesVersionId: input.supersedesVersionId as Uuid,
      actorPrincipalId: a.principalId,
      scope,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      resultVersionId: out.resultVersionId,
      supersededVersionId: out.supersededVersionId,
      status: out.status,
      contentHash: out.contentHash,
    };
  }

  /**
   * The contest's result versions and their lifecycle (competition staff). Each version carries
   * its stored canonical content (ONCF-L5), so staff can see the score they accept, declare
   * official or correct; nothing is re-derived here.
   */
  async contestResult(input: { actorAccountId: string; contestId: string }) {
    await inTransaction(this.db, ModuleRole.competition, async (ctx) => {
      const { rows } = await sql<{
        event_id: string;
      }>`SELECT event_id FROM competition.contest WHERE id = ${input.contestId}`.execute(ctx.trx);
      if (rows[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
      const e = await loadEvent(ctx, rows[0].event_id);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
    });
    return inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const { rows } = await sql<{
        id: string;
        version_number: number;
        content_hash: string;
        status: ResultVersionStatus;
        supersedes_version_id: string | null;
        current: boolean;
        content: ResultVersionContent;
        recorded_at: Date;
      }>`
        SELECT v.id, v.version_number, v.content_hash, st.current_status AS status, v.supersedes_version_id,
               rs.current_version_id = v.id AS current, v.content, v.recorded_at
        FROM results.result r JOIN results.result_version v ON v.result_id = r.id
        JOIN results.result_version_state st ON st.result_version_id = v.id
        JOIN results.result_state rs ON rs.result_id = r.id
        WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ${input.contestId}
        ORDER BY v.version_number DESC`.execute(ctx.trx);
      return {
        contestId: input.contestId,
        versions: rows.map((r) => ({
          resultVersionId: r.id,
          versionNumber: r.version_number,
          contentHash: r.content_hash,
          status: r.status,
          current: r.current === true,
          supersedesVersionId: r.supersedes_version_id,
          content: r.content,
          recordedAt: r.recorded_at.toISOString(),
        })),
      };
    });
  }
}
