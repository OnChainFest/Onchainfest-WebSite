import { compareUtf16 } from '@br/canonical';
import type { RegroupingOrder } from './profile';

/**
 * Scheduling-unit keys (ONCF-05E-C, ADR-0073 B9): a unit is the set of contests that start
 * together. Its identity is derived from plan (05B), 05D and profile data only — never typed in,
 * never from sport identity:
 *
 *   contest not in a GROUPED_ENTRANTS stage            → contest:<contestId>
 *   GROUPED_ENTRANTS, plan partition key               → partition:<roundId>:<partitionKey>
 *   GROUPED_ENTRANTS, non-dynamic round, no key         → partition:<roundId>:<inherited key> — the
 *       same entrant's key in the nearest earlier round of the stage that has one; else a singleton
 *   GROUPED_ENTRANTS, dynamic round + profile regrouping → regroup:<roundId>:<n> — blocks of
 *       `groupSize` over the 05D field ordinals in `order`
 *   dynamic round without regrouping                    → contest:<contestId>
 *
 * 05E never splits or merges a plan partition; the inherited and regrouped units are pure functions
 * of the same inputs, so the same plan, 05D facts and profile version give the same keys.
 */

export interface UnitContestFacts {
  readonly contestId: string;
  readonly roundId: string;
  readonly roundSequence: number;
  readonly stageId: string | null;
  /** The stage's logistic partition method is GROUPED_ENTRANTS. */
  readonly grouped: boolean;
  /** The round's field is only known once a transition resolves (05D materialized it). */
  readonly dynamic: boolean;
  readonly partitionKey: string | null;
  /** The entrant of a per-entrant contest's PARTICIPANT slot (inheritance). */
  readonly participantId: string | null;
  /** The 05D field ordinal of a materialized dynamic per-entrant contest (regrouping). */
  readonly fieldOrdinal: number | null;
}

export interface UnitRegrouping {
  readonly groupSize: number;
  readonly order: RegroupingOrder;
}

export const contestUnitKey = (contestId: string) => `contest:${contestId}`;

export function deriveUnitKeys(
  contests: readonly UnitContestFacts[],
  regrouping?: UnitRegrouping,
): Map<string, string> {
  const out = new Map<string, string>();
  const keyed = contests.filter((c) => c.grouped && c.partitionKey !== null);
  // Regroups: per dynamic round, the ordinals in the declared order, cut into blocks.
  const regroup = new Map<string, number>();
  if (regrouping !== undefined) {
    const byRound = new Map<string, UnitContestFacts[]>();
    for (const c of contests)
      if (c.grouped && c.dynamic && c.partitionKey === null && c.fieldOrdinal !== null)
        byRound.set(c.roundId, [...(byRound.get(c.roundId) ?? []), c]);
    for (const members of byRound.values()) {
      const ordered = [...members].sort(
        (a, b) =>
          (regrouping.order === 'FIELD_ORDINAL_ASC'
            ? (a.fieldOrdinal as number) - (b.fieldOrdinal as number)
            : (b.fieldOrdinal as number) - (a.fieldOrdinal as number)) ||
          compareUtf16(a.contestId, b.contestId),
      );
      ordered.forEach((c, i) => regroup.set(c.contestId, Math.floor(i / regrouping.groupSize) + 1));
    }
  }
  for (const c of contests) {
    let key = contestUnitKey(c.contestId);
    if (c.grouped && c.partitionKey !== null) key = `partition:${c.roundId}:${c.partitionKey}`;
    else if (c.grouped && !c.dynamic && c.participantId !== null) {
      const earlier = keyed
        .filter(
          (x) =>
            x.stageId === c.stageId &&
            x.roundSequence < c.roundSequence &&
            x.participantId === c.participantId,
        )
        .sort((a, b) => b.roundSequence - a.roundSequence)[0];
      if (earlier !== undefined) key = `partition:${c.roundId}:${earlier.partitionKey as string}`;
    } else if (c.grouped && c.dynamic && regroup.has(c.contestId))
      key = `regroup:${c.roundId}:${regroup.get(c.contestId) as number}`;
    out.set(c.contestId, key);
  }
  return out;
}
