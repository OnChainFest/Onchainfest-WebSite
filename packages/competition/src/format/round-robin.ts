import {
  assertEngineInput,
  type CompetitionFormatEngine,
  type FormatEngineInput,
  type PlanContest,
  type PlanDocument,
  type PlanRound,
} from './engine';

/**
 * ROUND_ROBIN v1 — standard circle (Berger-style rotation) method.
 *
 * - Every participant meets every other participant exactly once: n(n−1)/2 contests.
 * - Odd n: a BYE placeholder completes the circle; each participant sits out exactly one round.
 *   A bye is recorded on the round (`byes`), never as a contest or a result.
 * - Seed 1 stays fixed; the others rotate one position per round. Deterministic for a given seed
 *   order. No standings are computed (a schedule is not a ranking).
 */
export const roundRobinV1: CompetitionFormatEngine = {
  id: 'round-robin',
  version: 1,
  displayName: 'Round robin',
  configurationSchema: { type: 'object', properties: {}, additionalProperties: false },
  contestType: 'MATCH',
  minParticipants: 2,
  maxParticipants: 64,
  generate(input: FormatEngineInput): PlanDocument {
    assertEngineInput(this, input);
    let circle: (string | null)[] = [...input.seedOrder];
    if (circle.length % 2 === 1) circle.push(null);
    const m = circle.length;
    const rounds: PlanRound[] = [];
    let sequence = 0;
    for (let r = 1; r <= m - 1; r++) {
      const contests: PlanContest[] = [];
      const byes: string[] = [];
      for (let i = 0; i < m / 2; i++) {
        const a = circle[i] ?? null;
        const b = circle[m - 1 - i] ?? null;
        if (a === null || b === null) {
          const present = a ?? b;
          if (present !== null) byes.push(present);
          continue;
        }
        sequence += 1;
        contests.push({
          key: `r${r}-c${contests.length + 1}`,
          sequence,
          contestType: this.contestType,
          slots: [
            { slot: 1, source: 'PARTICIPANT', participantId: a },
            { slot: 2, source: 'PARTICIPANT', participantId: b },
          ],
        });
      }
      rounds.push({
        key: `r${r}`,
        sequence: r,
        roundType: 'GROUP',
        label: `Round ${r}`,
        byes,
        contests,
      });
      // rotate: keep position 0, move the last element to position 1
      circle = [circle[0] ?? null, circle[m - 1] ?? null, ...circle.slice(1, m - 1)];
    }
    return { engineId: this.id, engineVersion: this.version, rounds };
  },
};
