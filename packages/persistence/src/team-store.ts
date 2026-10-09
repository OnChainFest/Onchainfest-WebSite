import { canTransition, TeamMembershipLifecycle, type TeamMembershipStatus } from '@br/competition';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import { activeTeamMembers, canActForAthlete, isTeamManager } from './competition-store';
import { currentStatus, text, transitionError } from './competition-support';
import type { Db } from './db';
import {
  hasOrgPermission,
  identityIdempotency,
  loadControlFacts,
  lockKeys,
  recordAudit,
} from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

export type TeamKind = 'PERSISTENT' | 'EVENT_PAIR' | 'EVENT_SQUAD';

/**
 * Teams (BRT-01 §5.6): competition-side identities — never Organizations. Management is an
 * explicit TeamManager relation (the creator's SELF person); wallets, organization roles and
 * sports authority never manage a team. Membership is temporal and needs the athlete side's
 * consent unless the manager already controls that athlete (SELF / confirmed guardian).
 */
export class TeamStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  /** `organizationId` is an affiliation label; setting it requires ORG_MANAGE_COMPETITIONS there. */
  async createTeam(input: {
    actorAccountId: string;
    teamKind: TeamKind;
    displayName: string;
    organizationId?: string;
    idempotencyKey: string;
  }): Promise<{ teamId: string; created: boolean }> {
    if (!['PERSISTENT', 'EVENT_PAIR', 'EVENT_SQUAD'].includes(input.teamKind))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid team kind');
    const name = text(input.displayName, 80, 'displayName');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ teamId: string }>(ctx, {
        command: 'CreateTeam',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          teamKind: input.teamKind,
          displayName: name,
          organizationId: input.organizationId,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (!facts.accountActive || facts.selfPersonId === undefined)
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      if (
        input.organizationId !== undefined &&
        !(await hasOrgPermission(
          ctx,
          input.actorAccountId,
          input.organizationId,
          'ORG_MANAGE_COMPETITIONS',
        ))
      ) {
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      const teamId = newId();
      await sql`INSERT INTO competition.team (id, team_kind, organization_id, created_by_account_id, recorded_at)
        VALUES (${teamId}, ${input.teamKind}, ${input.organizationId ?? null}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.team_profile (team_id, display_name, updated_at) VALUES (${teamId}, ${name}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.team_manager (team_id, person_id, recorded_at) VALUES (${teamId}, ${facts.selfPersonId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'TeamCreated',
        aggregateType: 'TEAM',
        aggregateId: teamId as Uuid,
        payload: { teamKind: input.teamKind },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'team.created',
        targetType: 'TEAM',
        targetId: teamId,
      });
      await idem.record({ teamId });
      return { teamId, created: true };
    });
  }

  /** Manager proposes an athlete; ACTIVE immediately if the manager controls the athlete. */
  async addMember(input: {
    actorAccountId: string;
    teamId: string;
    athleteId: string;
    role?: string;
    idempotencyKey: string;
  }): Promise<{ membershipId: string; status: TeamMembershipStatus; created: boolean }> {
    if (input.role !== undefined && !/^[A-Z][A-Z_]{1,31}$/.test(input.role))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid member role');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        membershipId: string;
        status: TeamMembershipStatus;
      }>(ctx, {
        command: 'AddTeamMember',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { teamId: input.teamId, athleteId: input.athleteId, role: input.role },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!(await isTeamManager(ctx, input.actorAccountId, input.teamId)))
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      await lockKeys(ctx, `team-member:${input.teamId}:${input.athleteId}`);
      const { rows: athlete } = await sql<{
        status: string;
      }>`SELECT status FROM identity.v_athlete_current WHERE athlete_id = ${input.athleteId}`.execute(
        ctx.trx,
      );
      if (athlete[0]?.status !== 'ACTIVE')
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'athlete not found');
      const { rows: open } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM competition.team_membership m JOIN competition.v_team_membership_current v ON v.team_membership_id = m.id
        WHERE m.team_id = ${input.teamId} AND m.athlete_id = ${input.athleteId} AND v.status IN ('PROPOSED', 'ACTIVE')`.execute(
        ctx.trx,
      );
      if ((open[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'the athlete is already a (proposed) member',
        );
      const status: TeamMembershipStatus = (await canActForAthlete(
        ctx,
        input.actorAccountId,
        input.athleteId,
      ))
        ? 'ACTIVE'
        : 'PROPOSED';
      const membershipId = newId();
      await sql`INSERT INTO competition.team_membership (id, team_id, athlete_id, member_role, proposed_by_account_id, recorded_at)
        VALUES (${membershipId}, ${input.teamId}, ${input.athleteId}, ${input.role ?? null}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO competition.team_membership_status_change (id, team_membership_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${membershipId}, ${status}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: status === 'ACTIVE' ? 'TeamMembershipActivated' : 'TeamMembershipProposed',
        aggregateType: 'TEAM_MEMBERSHIP',
        aggregateId: membershipId as Uuid,
        payload: { teamId: input.teamId },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: `team.member-${status.toLowerCase()}`,
        targetType: 'TEAM',
        targetId: input.teamId,
      });
      await idem.record({ membershipId, status });
      return { membershipId, status, created: true };
    });
  }

  /** The athlete side (SELF or confirmed guardian) accepts or declines a proposal. */
  async respond(input: {
    actorAccountId: string;
    membershipId: string;
    accept: boolean;
  }): Promise<{ status: TeamMembershipStatus }> {
    return this.tx(async (ctx) => {
      const m = await this.load(ctx, input.membershipId);
      if (!(await canActForAthlete(ctx, input.actorAccountId, m.athleteId)))
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      const to: TeamMembershipStatus = input.accept ? 'ACTIVE' : 'DECLINED';
      if (!canTransition(TeamMembershipLifecycle, m.status, to))
        throw transitionError('team membership', m.status, to);
      await this.append(ctx, input.membershipId, to, input.actorAccountId);
      await emitEvent(ctx, {
        eventType: input.accept ? 'TeamMembershipActivated' : 'TeamMembershipDeclined',
        aggregateType: 'TEAM_MEMBERSHIP',
        aggregateId: input.membershipId as Uuid,
        payload: { teamId: m.teamId },
      });
      return { status: to };
    });
  }

  /** Ends a membership prospectively (manager or athlete side). History is kept. */
  async endMembership(input: { actorAccountId: string; membershipId: string }): Promise<void> {
    await this.tx(async (ctx) => {
      const m = await this.load(ctx, input.membershipId);
      const allowed =
        (await isTeamManager(ctx, input.actorAccountId, m.teamId)) ||
        (await canActForAthlete(ctx, input.actorAccountId, m.athleteId));
      if (!allowed) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      if (!canTransition(TeamMembershipLifecycle, m.status, 'ENDED'))
        throw transitionError('team membership', m.status, 'ENDED');
      await this.append(ctx, input.membershipId, 'ENDED', input.actorAccountId);
      await emitEvent(ctx, {
        eventType: 'TeamMembershipEnded',
        aggregateType: 'TEAM_MEMBERSHIP',
        aggregateId: input.membershipId as Uuid,
        payload: { teamId: m.teamId },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'team.member-ended',
        targetType: 'TEAM',
        targetId: m.teamId,
      });
    });
  }

  /**
   * ONCF-05B team reads (for pair / squad entry). Teams the caller manages, each with its members'
   * current membership status. Athletes are returned as ids; the API names them under the roster
   * rule (only PUBLIC / AUTHENTICATED profiles), exactly like registrations.
   */
  myTeams(input: { actorAccountId: string }) {
    return this.tx(async (ctx) => {
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (!facts.accountActive || facts.selfPersonId === undefined) return [];
      const { rows } = await sql<{
        team_id: string;
        team_kind: TeamKind;
        display_name: string;
        recorded_at: Date;
      }>`
        SELECT t.id AS team_id, t.team_kind, p.display_name, t.recorded_at FROM competition.team t
        JOIN competition.team_manager m ON m.team_id = t.id JOIN competition.team_profile p ON p.team_id = t.id
        WHERE m.person_id = ${facts.selfPersonId} ORDER BY t.recorded_at DESC LIMIT 200`.execute(
        ctx.trx,
      );
      const out = [];
      for (const t of rows) {
        const { rows: members } = await sql<{
          id: string;
          athlete_id: string;
          status: TeamMembershipStatus;
        }>`
          SELECT m.id, m.athlete_id, c.status FROM competition.team_membership m
          JOIN competition.v_team_membership_current c ON c.team_membership_id = m.id
          WHERE m.team_id = ${t.team_id} AND c.status IN ('PROPOSED', 'ACTIVE') ORDER BY m.recorded_at, m.id`.execute(
          ctx.trx,
        );
        out.push({
          teamId: t.team_id,
          teamKind: t.team_kind,
          displayName: t.display_name,
          createdAt: t.recorded_at.toISOString(),
          members: members.map((m) => ({
            membershipId: m.id,
            athleteId: m.athlete_id,
            status: m.status,
          })),
        });
      }
      return out;
    });
  }

  /** Memberships of athletes the caller may act for (SELF / confirmed guardian): pending first. */
  myMemberships(input: { actorAccountId: string }) {
    return this.tx(async (ctx) => {
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (!facts.accountActive || facts.selfPersonId === undefined) return [];
      const persons = [facts.selfPersonId, ...facts.activeDependentPersonIds];
      const { rows } = await sql<{
        id: string;
        team_id: string;
        athlete_id: string;
        status: TeamMembershipStatus;
        display_name: string;
        team_kind: TeamKind;
      }>`
        SELECT m.id, m.team_id, m.athlete_id, c.status, p.display_name, t.team_kind FROM competition.team_membership m
        JOIN competition.v_team_membership_current c ON c.team_membership_id = m.id
        JOIN identity.athlete a ON a.id = m.athlete_id
        JOIN competition.team t ON t.id = m.team_id JOIN competition.team_profile p ON p.team_id = m.team_id
        WHERE a.person_id = ANY(${persons}::uuid[]) AND c.status IN ('PROPOSED', 'ACTIVE')
        ORDER BY (c.status = 'PROPOSED') DESC, m.recorded_at DESC LIMIT 200`.execute(ctx.trx);
      return rows.map((r) => ({
        membershipId: r.id,
        teamId: r.team_id,
        teamName: r.display_name,
        teamKind: r.team_kind,
        athleteId: r.athlete_id,
        status: r.status,
      }));
    });
  }

  /** Athlete ids with an ACTIVE membership at `at` (default: now). */
  members(teamId: string, at?: Date): Promise<string[]> {
    return this.tx((ctx) => activeTeamMembers(ctx, teamId, at ?? ctx.txTime));
  }

  private async load(ctx: TxContext, membershipId: string) {
    await lockKeys(ctx, `team-membership:${membershipId}`);
    const { rows } = await sql<{ team_id: string; athlete_id: string }>`
      SELECT team_id, athlete_id FROM competition.team_membership WHERE id = ${membershipId}`.execute(
      ctx.trx,
    );
    if (rows[0] === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'membership not found');
    const status = (await currentStatus(
      ctx,
      'competition.v_team_membership_current',
      'team_membership_id',
      membershipId,
    )) as TeamMembershipStatus;
    return { teamId: rows[0].team_id, athleteId: rows[0].athlete_id, status };
  }

  private async append(
    ctx: TxContext,
    membershipId: string,
    status: TeamMembershipStatus,
    actor: string,
  ): Promise<void> {
    await sql`INSERT INTO competition.team_membership_status_change (id, team_membership_id, status, actor_account_id, recorded_at)
      VALUES (${newId()}, ${membershipId}, ${status}, ${actor}, ${ctx.txTime})`.execute(ctx.trx);
  }
}
