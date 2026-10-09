import { describe, expect, it } from 'vitest';
import { decodeTarget, encodeTarget, provenanceLine, reasonLabel } from './advancement';

describe('ONCF-05D advancement helpers (labels only; the API decides)', () => {
  it('targets round-trip through one form field and malformed values are refused', () => {
    const slot = {
      kind: 'SLOT' as const,
      contestId: '00000000-0000-4000-8000-000000000001',
      slot: 2,
    };
    const field = { kind: 'FIELD' as const, transitionKey: 't1', ordinal: 8 };
    expect(decodeTarget(encodeTarget(slot))).toEqual(slot);
    expect(decodeTarget(encodeTarget(field))).toEqual(field);
    expect(decodeTarget('slot:not-a-uuid:1')).toBeUndefined();
    expect(decodeTarget('field:t1:0')).toBeUndefined();
  });
  it('explains provenance from structured data, never inventing anything', () => {
    const name = () => 'Semifinal · #2';
    expect(
      provenanceLine(
        {
          family: 'DIRECT_WINNER',
          source: { kind: 'WINNER_OF_CONTEST', contestId: 'c' },
          result: { contestId: 'c', resultVersionId: 'v', status: 'OFFICIAL', outcome: 'WIN' },
        },
        name,
      ),
    ).toBe('Winner of Semifinal · #2 · official result');
    expect(
      provenanceLine(
        {
          family: 'GROUP_RANK',
          source: { kind: 'RANK_FROM_STAGE', stageKey: 's1', groupKey: 'g2', rank: 1 },
          classification: { stageKey: 's1', position: 1, tied: false },
        },
        name,
      ),
    ).toBe('Group rank: group 2 · place 1 · classified 1');
    expect(
      provenanceLine(
        {
          family: 'CUT',
          source: { kind: 'QUALIFIER', transitionKey: 't1', ordinal: 3 },
          classification: { stageKey: 's1', position: 2, tied: true, throughRound: 2 },
          decidedBy: 'SEED',
        },
        name,
      ),
    ).toBe('Cut: field place 3 · classified 2= after round 2 · tie broken by seed');
    expect(reasonLabel('RESULT_NOT_OFFICIAL')).toBe('Result not official yet');
    expect(reasonLabel(null)).toBeNull();
  });
});
