import type { CheckerResult, ConflictOfInterestChecker } from '@br/authority';
import type { AuthorityScope, Instant, Uuid } from '@br/domain';
import { sql } from 'kysely';
import type { TxContext } from './tx';

/** Recorded in every authorization decision and proof digest that this checker answers. */
export const COMPETITION_PARTICIPATION_CHECKER_ID = 'competition-participation/1';

/**
 * ADR-0077 §2.5: does the person take part in the competition? This covers BRT-01 rule 7
 * (SELF_PARTICIPANT, TEAM_MEMBER_OF_PARTICIPANT, LINEUP_MEMBER_OF_PARTICIPANT), widened to the whole
 * competition. It counts any registration, participant entry, membership of a registered team, frozen
 * roster entry or declared lineup entry of the person's athlete in any of the competition's events,
 * whatever its status. Over-inclusion can only deny authority, never grant it. A person without an
 * athlete cannot be a participant. Runs as br_competition.
 */
export async function personParticipatesInCompetition(
  ctx: TxContext,
  personId: string,
  competitionId: string,
): Promise<boolean> {
  const { rows } = await sql<{ participates: boolean }>`
    WITH me AS (SELECT id FROM identity.athlete WHERE person_id = ${personId}),
         ev AS (SELECT id FROM competition.event WHERE competition_id = ${competitionId})
    SELECT EXISTS (
      SELECT 1 FROM competition.registration r
      WHERE r.event_id IN (SELECT id FROM ev) AND r.athlete_id IN (SELECT id FROM me)
      UNION ALL
      SELECT 1 FROM competition.participant p
      WHERE p.event_id IN (SELECT id FROM ev) AND p.athlete_id IN (SELECT id FROM me)
      UNION ALL
      SELECT 1 FROM competition.registration r
      JOIN competition.team_membership tm ON tm.team_id = r.team_id
      WHERE r.event_id IN (SELECT id FROM ev) AND tm.athlete_id IN (SELECT id FROM me)
      UNION ALL
      SELECT 1 FROM competition.participant_roster_member prm
      JOIN competition.participant p ON p.id = prm.participant_id
      WHERE p.event_id IN (SELECT id FROM ev) AND prm.athlete_id IN (SELECT id FROM me)
      UNION ALL
      SELECT 1 FROM competition.lineup_member lm
      JOIN competition.lineup l ON l.id = lm.lineup_id
      JOIN competition.contest c ON c.id = l.contest_id
      WHERE c.event_id IN (SELECT id FROM ev) AND lm.athlete_id IN (SELECT id FROM me)
    ) AS participates`.execute(ctx.trx);
  return rows[0]?.participates === true;
}

/**
 * A checker that answers for exactly one principal and one competition, from a participation fact
 * read just before the authority decision. Any other principal, or a scope that does not name
 * exactly that competition, is UNAVAILABLE (fail closed).
 */
export function competitionParticipationChecker(input: {
  readonly principalId: Uuid;
  readonly competitionId: string;
  readonly participates: boolean;
}): ConflictOfInterestChecker {
  return {
    id: COMPETITION_PARTICIPATION_CHECKER_ID,
    check(principalId: Uuid, scope: AuthorityScope, _atTime: Instant): CheckerResult {
      if (principalId !== input.principalId) return 'UNAVAILABLE';
      const competitions = scope.competition ?? [];
      if (competitions.length !== 1 || competitions[0] !== input.competitionId)
        return 'UNAVAILABLE';
      return input.participates ? 'CONFLICTED' : 'CLEAR';
    },
  };
}

/**
 * The PLATFORM grantor of an ADR-0077 grant: a PLATFORM principal never takes part in a
 * competition. It is CLEAR for that principal only and UNAVAILABLE for everyone else.
 */
export function platformGrantorChecker(platformPrincipalId: Uuid): ConflictOfInterestChecker {
  return {
    id: 'platform-grantor/1',
    check: (principalId: Uuid): CheckerResult =>
      principalId === platformPrincipalId ? 'CLEAR' : 'UNAVAILABLE',
  };
}
