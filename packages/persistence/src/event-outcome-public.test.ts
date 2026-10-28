import { describe, expect, it } from 'vitest';
import { publicMatchScoring } from './event-outcome-store';

// D-P4: the public score marks of an official result: participants, outcomes and marks only.
describe('publicMatchScoring', () => {
  const mark = (metricId: string, value: string) => ({
    metricId,
    value,
    unit: 'games',
    precision: 0,
  });
  it('keeps the family, outcomes and marks, and never an athlete id', () => {
    const out = publicMatchScoring('SETS_OF_GAMES', {
      entries: [
        {
          participantId: 'p1' as never,
          outcome: 'WIN',
          rank: 1,
          primaryMark: mark('sog.sets_won', '2'),
        },
        { participantId: 'p2' as never, outcome: 'LOSS' },
      ],
      performances: [
        {
          participantId: 'p1' as never,
          athleteId: 'a1' as never,
          ordinal: 1,
          mark: mark('sog.set_games', '6'),
          valid: true,
        },
        { participantId: 'p2' as never, ordinal: 1, mark: mark('sog.set_games', '3') },
      ],
    });
    expect(out).toEqual({
      family: 'SETS_OF_GAMES',
      content: {
        entries: [
          { participantId: 'p1', outcome: 'WIN', primaryMark: mark('sog.sets_won', '2') },
          { participantId: 'p2', outcome: 'LOSS' },
        ],
        performances: [
          { participantId: 'p1', ordinal: 1, mark: mark('sog.set_games', '6') },
          { participantId: 'p2', ordinal: 1, mark: mark('sog.set_games', '3') },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain('a1');
  });

  it('a result without performances has none', () => {
    expect(
      publicMatchScoring('TIMED_PERIODS', {
        entries: [{ participantId: 'p1' as never, outcome: 'WIN' }],
      }).content.performances,
    ).toEqual([]);
  });
});
