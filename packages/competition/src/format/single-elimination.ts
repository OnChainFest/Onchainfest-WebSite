import {
  assertEngineInput,
  type CompetitionFormatEngine,
  type FormatEngineInput,
  type PlanContest,
  type PlanDocument,
  type PlanRound,
  type PlanSlot,
} from './engine';

/**
 * Standard bracket placement for a power-of-two size: seed 1 and seed 2 can only meet in the
 * final, 1–4 in the semifinal, and so on. order(2k) = ⋃_{s ∈ order(k)} [s, 2k + 1 − s].
 */
export function bracketSeedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const k2 = order.length * 2;
    order = order.flatMap((s) => [s, k2 + 1 - s]);
  }
  return order;
}

function roundLabel(roundsFromEnd: number): string {
  if (roundsFromEnd === 0) return 'Final';
  if (roundsFromEnd === 1) return 'Semifinal';
  if (roundsFromEnd === 2) return 'Quarterfinal';
  return `Round of ${2 ** (roundsFromEnd + 1)}`;
}

/** Occupant of a bracket position after a round: a concrete participant or a contest's winner. */
type Feed = { kind: 'PARTICIPANT'; participantId: string } | { kind: 'WINNER'; contestKey: string };

/**
 * SINGLE_ELIMINATION v1.
 *
 * - n ≥ 2 participants; the bracket is expanded to the next power of two.
 * - Byes: a top seed whose first-round opponent position is empty is placed directly into its
 *   round-2 slot as a PARTICIPANT. A bye is a structural consequence of seeding, not a contest
 *   and not a result — no winner is fabricated.
 * - Every later slot is WINNER_OF_CONTEST(previous contest); nothing is resolved at generation.
 * - Contest keys keep stable bracket positions: "r{round}-c{position}" (positions of byes are
 *   skipped, so keys need not be contiguous). Exactly n − 1 contests; exactly one final.
 */
export const singleEliminationV1: CompetitionFormatEngine = {
  id: 'single-elimination',
  version: 1,
  displayName: 'Single elimination',
  configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
  contestType: 'MATCH',
  minParticipants: 2,
  maxParticipants: 256,
  generate(input: FormatEngineInput): PlanDocument {
    assertEngineInput(this, input);
    const n = input.seedOrder.length;
    let size = 1;
    while (size < n) size *= 2;
    const totalRounds = Math.log2(size);
    const bySeed = (seed: number): string | undefined =>
      seed <= n ? input.seedOrder[seed - 1] : undefined;

    // Round-1 feeds per first-round position pair.
    const positions = bracketSeedOrder(size);
    let feeds: (Feed | undefined)[] = positions.map((seed) => {
      const id = bySeed(seed);
      return id === undefined ? undefined : { kind: 'PARTICIPANT', participantId: id };
    });

    const rounds: PlanRound[] = [];
    let sequence = 0;
    for (let r = 1; r <= totalRounds; r++) {
      const contests: PlanContest[] = [];
      const next: (Feed | undefined)[] = [];
      for (let j = 0; j < feeds.length / 2; j++) {
        const a = feeds[2 * j];
        const b = feeds[2 * j + 1];
        if (a !== undefined && b !== undefined) {
          const key = `r${r}-c${j + 1}`;
          const slot = (feed: Feed, slotNo: number): PlanSlot =>
            feed.kind === 'PARTICIPANT'
              ? { slot: slotNo, source: 'PARTICIPANT', participantId: feed.participantId }
              : { slot: slotNo, source: 'WINNER_OF_CONTEST', contestKey: feed.contestKey };
          sequence += 1;
          contests.push({
            key,
            sequence,
            contestType: this.contestType,
            slots: [slot(a, 1), slot(b, 2)],
          });
          next.push({ kind: 'WINNER', contestKey: key });
        } else {
          // Bye (only possible in round 1): the present participant advances structurally.
          next.push(a ?? b);
        }
      }
      rounds.push({
        key: `r${r}`,
        sequence: r,
        roundType: r === totalRounds ? 'FINAL' : 'KNOCKOUT',
        label: roundLabel(totalRounds - r),
        byes: [],
        contests,
      });
      feeds = next;
    }
    return { engineId: this.id, engineVersion: this.version, rounds };
  },
};
