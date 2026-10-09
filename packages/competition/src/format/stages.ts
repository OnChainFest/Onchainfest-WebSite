import type { ContestType } from '../catalog';
import { FormatEngineError } from './engine';
import { type PlanBuilder, type PlanContestV2, type PlanEntry, type PlanSlotV2 } from './plan-v2';
import { bracketSeedOrder } from './single-elimination';

/**
 * Stage primitives (ONCF-05A §4): KNOCKOUT, ROUND_ROBIN, FIELD and HEATS. Pure and sport-neutral:
 * they place entrants into structure from a seed order and flat parameters, and know nothing about
 * sets, time, pins or strokes. Every format engine is a composition of these.
 */

/** A slot occupant before slot numbering: a participant or a dependency on another stage. */
export type SlotRef = Omit<PlanSlotV2, 'slot'>;

export const participantRef = (participantId: string): SlotRef => ({
  source: 'PARTICIPANT',
  participantId,
});

function roundLabel(roundsFromEnd: number): string {
  if (roundsFromEnd === 0) return 'Final';
  if (roundsFromEnd === 1) return 'Semifinal';
  if (roundsFromEnd === 2) return 'Quarterfinal';
  return `Round of ${2 ** (roundsFromEnd + 1)}`;
}

export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

// ───────────────────────────── KNOCKOUT ─────────────────────────────

type Feed = { kind: 'REF'; ref: SlotRef } | { kind: 'WINNER'; contestKey: string };

const toSlot = (feed: Feed, slot: number): PlanSlotV2 =>
  feed.kind === 'REF'
    ? { slot, ...feed.ref }
    : { slot, source: 'WINNER_OF_CONTEST', contestKey: feed.contestKey };

/**
 * A seeded knockout bracket over `entrants` (seed 1 first). Standard placement (seeds 1 and 2 only
 * meet in the final); byes go to the top seeds and are structural (no contest, no result). With
 * `thirdPlace`, the semifinal losers meet in a play-off when both semifinals are real contests.
 */
export function knockoutStage(
  b: PlanBuilder,
  stageKey: string,
  entrants: readonly SlotRef[],
  opts: { drawSize: number; thirdPlace: boolean; contestType: ContestType },
): void {
  const n = entrants.length;
  const size = opts.drawSize;
  if (size < n || size !== nextPowerOfTwo(size) || size < 2)
    throw new FormatEngineError(
      'DRAW_SIZE',
      `draw size ${size} must be a power of two ≥ the number of entrants (${n})`,
    );
  const totalRounds = Math.log2(size);
  let feeds: (Feed | undefined)[] = bracketSeedOrder(size).map((seed) => {
    const ref = seed <= n ? entrants[seed - 1] : undefined;
    return ref === undefined ? undefined : { kind: 'REF', ref };
  });
  let semis: string[] = [];
  for (let r = 1; r <= totalRounds; r++) {
    const contests: PlanContestV2[] = [];
    const next: (Feed | undefined)[] = [];
    for (let j = 0; j < feeds.length / 2; j++) {
      const a = feeds[2 * j];
      const c = feeds[2 * j + 1];
      if (a !== undefined && c !== undefined) {
        const key = `${stageKey}-r${r}-c${j + 1}`;
        contests.push({
          key,
          sequence: b.nextContestSequence(),
          contestType: opts.contestType,
          slots: [toSlot(a, 1), toSlot(c, 2)],
        });
        next.push({ kind: 'WINNER', contestKey: key });
      } else next.push(a ?? c);
    }
    if (r === totalRounds - 1) semis = contests.map((c) => c.key);
    if (r === totalRounds && opts.thirdPlace && semis.length === 2) {
      b.round({
        key: `${stageKey}-r${r}-3p`,
        roundType: 'KNOCKOUT',
        label: 'Third place',
        stageKey,
        byes: [],
        contests: [
          {
            key: `${stageKey}-r${r}-3p-c1`,
            sequence: b.nextContestSequence(),
            contestType: opts.contestType,
            slots: semis.map((k, i) => ({
              slot: i + 1,
              source: 'LOSER_OF_CONTEST',
              contestKey: k,
            })),
          },
        ],
      });
    }
    b.round({
      key: `${stageKey}-r${r}`,
      roundType: r === totalRounds ? 'FINAL' : 'KNOCKOUT',
      label: roundLabel(totalRounds - r),
      stageKey,
      byes: [],
      contests,
    });
    feeds = next;
  }
}

/**
 * Stepladder over qualifying seats 1..K (seat 1 = best): K vs K−1, the winner meets K−2, …, and
 * the last climber meets seat 1 in the final. A degenerate seeded knockout (bowling finals).
 */
export function stepladderStage(
  b: PlanBuilder,
  stageKey: string,
  seats: readonly SlotRef[],
  contestType: ContestType,
): void {
  const k = seats.length;
  if (k < 2) throw new FormatEngineError('FIELD_SIZE', 'a stepladder needs at least 2 seats');
  let climber: Feed = { kind: 'REF', ref: seats[k - 1] as SlotRef };
  for (let seat = k - 1, m = 1; seat >= 1; seat--, m++) {
    const key = `${stageKey}-m${m}`;
    const isFinal = seat === 1;
    b.round({
      key: `${stageKey}-r${m}`,
      roundType: isFinal ? 'FINAL' : 'KNOCKOUT',
      label: isFinal ? 'Final' : `Stepladder match ${m}`,
      stageKey,
      byes: [],
      contests: [
        {
          key,
          sequence: b.nextContestSequence(),
          contestType,
          slots: [toSlot({ kind: 'REF', ref: seats[seat - 1] as SlotRef }, 1), toSlot(climber, 2)],
        },
      ],
    });
    climber = { kind: 'WINNER', contestKey: key };
  }
}

// ───────────────────────────── ROUND_ROBIN ─────────────────────────────

/** Group sizes as even as possible (differ by at most one), larger groups first. */
export function evenGroupSizes(n: number, groupCount: number): number[] {
  if (groupCount < 1 || groupCount > n)
    throw new FormatEngineError('GROUPS', `cannot split ${n} entrants into ${groupCount} groups`);
  const base = Math.floor(n / groupCount);
  const extra = n % groupCount;
  return Array.from({ length: groupCount }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Serpentine fill: seeds 1..g go to groups 1..g, the next row back from g..1, and so on, skipping
 * full groups. With `higherSeedsToSmallerGroups` (FIP), smaller groups are filled first in each row.
 */
export function serpentineGroups(
  seedOrder: readonly string[],
  sizes: readonly number[],
  higherSeedsToSmallerGroups: boolean,
): string[][] {
  const groups: string[][] = sizes.map(() => []);
  const rowOrder = sizes
    .map((size, i) => ({ size, i }))
    .sort((x, y) => (higherSeedsToSmallerGroups ? x.size - y.size || x.i - y.i : x.i - y.i))
    .map((x) => x.i);
  let row = 0;
  let pos = 0;
  for (const id of seedOrder) {
    for (;;) {
      const order = row % 2 === 0 ? rowOrder : [...rowOrder].reverse();
      const gi = order[pos] as number;
      pos += 1;
      if (pos === order.length) {
        pos = 0;
        row += 1;
      }
      if ((groups[gi] as string[]).length < (sizes[gi] as number)) {
        (groups[gi] as string[]).push(id);
        break;
      }
    }
  }
  return groups;
}

/** Circle-method pairings for one group (each pair once; byes on the round, never as contests). */
export function circlePairings(
  members: readonly string[],
): { pairs: [string, string][]; byes: string[] }[] {
  let circle: (string | null)[] = [...members];
  if (circle.length % 2 === 1) circle.push(null);
  const m = circle.length;
  const rounds: { pairs: [string, string][]; byes: string[] }[] = [];
  for (let r = 1; r <= m - 1; r++) {
    const pairs: [string, string][] = [];
    const byes: string[] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = circle[i] ?? null;
      const c = circle[m - 1 - i] ?? null;
      if (a === null || c === null) {
        const present = a ?? c;
        if (present !== null) byes.push(present);
      } else pairs.push([a, c]);
    }
    rounds.push({ pairs, byes });
    circle = [circle[0] ?? null, circle[m - 1] ?? null, ...circle.slice(1, m - 1)];
  }
  return rounds;
}

export const groupLetter = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : `${String.fromCharCode(65 + Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`;

/** Round-robin groups. Two-entrant groups may play each other twice (FIP). */
export function roundRobinStage(
  b: PlanBuilder,
  stageKey: string,
  groups: readonly (readonly string[])[],
  opts: { contestType: ContestType; repeatTwoEntrantGroups: boolean },
): void {
  groups.forEach((members, gi) => {
    const groupKey = `g${gi + 1}`;
    const legs = members.length === 2 && opts.repeatTwoEntrantGroups ? 2 : 1;
    const pairings = circlePairings(members);
    let r = 0;
    for (let leg = 1; leg <= legs; leg++) {
      for (const { pairs, byes } of pairings) {
        r += 1;
        const roundKey = `${stageKey}-${groupKey}-r${r}`;
        b.round({
          key: roundKey,
          roundType: 'GROUP',
          label: groups.length > 1 ? `Group ${groupLetter(gi)} · Round ${r}` : `Round ${r}`,
          stageKey,
          ...(groups.length > 1 ? { groupKey } : {}),
          byes,
          contests: pairs.map(([x, y], ci) => {
            const [first, second] = leg === 2 ? [y, x] : [x, y];
            return {
              key: `${roundKey}-c${ci + 1}`,
              sequence: b.nextContestSequence(),
              contestType: opts.contestType,
              ...(groups.length > 1 ? { partitionKey: groupKey } : {}),
              slots: [
                { slot: 1, source: 'PARTICIPANT', participantId: first },
                { slot: 2, source: 'PARTICIPANT', participantId: second },
              ],
            };
          }),
        });
      }
    }
  });
}

/**
 * Knockout entry list from group ranks. Group winners take seeds 1..g; each later rank is placed so
 * that a qualifier never meets its own group in the first knockout round and sits in the half
 * opposite its group winner (1A–2B for two groups; with four groups A1–C2, B1–D2, C1–A2, D1–B2).
 */
export function crossoverEntrants(
  stageKey: string,
  groupCount: number,
  qualifiersPerGroup: number,
  bestRankedExtra: number,
): SlotRef[] {
  const total = groupCount * qualifiersPerGroup + bestRankedExtra;
  const size = nextPowerOfTwo(total);
  const order = bracketSeedOrder(size);
  const half = (seed: number) => (order.indexOf(seed) < size / 2 ? 0 : 1);
  const groupOfSeed: (number | undefined)[] = [];
  const refs: SlotRef[] = [];
  for (let gi = 0; gi < groupCount; gi++) {
    refs.push({ source: 'RANK_FROM_STAGE', stageKey, groupKey: `g${gi + 1}`, rank: 1 });
    groupOfSeed[gi + 1] = gi;
  }
  for (let rank = 2; rank <= qualifiersPerGroup; rank++) {
    const pending = Array.from({ length: groupCount }, (_, i) => i);
    for (let k = 0; k < groupCount; k++) {
      const seed = refs.length + 1;
      const opp = size + 1 - seed;
      const oppGroup = opp <= total ? groupOfSeed[opp] : undefined;
      const winnerHalf = (gi: number) => half(gi + 1);
      const pick =
        pending.find((gi) => gi !== oppGroup && winnerHalf(gi) !== half(seed)) ??
        pending.find((gi) => gi !== oppGroup) ??
        (pending[0] as number);
      pending.splice(pending.indexOf(pick), 1);
      groupOfSeed[seed] = pick;
      refs.push({ source: 'RANK_FROM_STAGE', stageKey, groupKey: `g${pick + 1}`, rank });
    }
  }
  for (let o = 1; o <= bestRankedExtra; o++)
    refs.push({
      source: 'BEST_RANKED_FROM_STAGE',
      stageKey,
      rank: qualifiersPerGroup + 1,
      ordinal: o,
    });
  return refs;
}

// ───────────────────────────── FIELD / HEATS ─────────────────────────────

/** Consecutive blocks of `capacity` in seed order (waves, tee groups, squads). */
export function blocks<T>(items: readonly T[], capacity: number): T[][] {
  if (capacity < 1) throw new FormatEngineError('CONFIG', 'capacity must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += capacity) out.push(items.slice(i, i + capacity));
  return out;
}

/** Centre-out lane order for 1-based lanes: 8 lanes → 4,5,3,6,2,7,1,8 (World Aquatics Art. 3.2.5). */
export function centreOutLanes(lanes: number): number[] {
  const centre = Math.ceil(lanes / 2);
  const order = [centre];
  for (let d = 1; order.length < lanes; d++) {
    if (centre + d <= lanes) order.push(centre + d);
    if (centre - d >= 1 && order.length < lanes) order.push(centre - d);
  }
  return order;
}

/**
 * Heat composition from an order fastest-first. Returns heats in RUN order (heat 1 = slowest), each
 * fastest-first. CIRCLE (World Aquatics Art. 3.2): the last `circleK` heats are circle-seeded
 * (fastest in the last heat, next in the one before, …) and earlier heats are filled in blocks with
 * the slower entrants, the first heat keeping at least `minPerHeat`. ZIGZAG (World Athletics TR 20):
 * seeds snake across all heats.
 */
export function composeHeats(
  fastestFirst: readonly string[],
  lanes: number,
  method: 'CIRCLE' | 'ZIGZAG',
  circleK: number,
  minPerHeat: number,
): string[][] {
  const n = fastestFirst.length;
  const h = Math.ceil(n / lanes);
  if (h <= 1) return [[...fastestFirst]];
  if (method === 'ZIGZAG') {
    const heats: string[][] = Array.from({ length: h }, () => []);
    fastestFirst.forEach((id, i) => {
      const row = Math.floor(i / h);
      const col = i % h;
      (heats[row % 2 === 0 ? col : h - 1 - col] as string[]).push(id);
    });
    return heats;
  }
  const k = Math.min(circleK, h);
  const circleCount = h === k ? n : k * lanes;
  const circled: string[][] = Array.from({ length: k }, () => []);
  fastestFirst.slice(0, circleCount).forEach((id, i) => {
    (circled[k - 1 - (i % k)] as string[]).push(id);
  });
  const rest = fastestFirst.slice(circleCount);
  // Earlier heats: blocks from the slow end, so heat 1 holds the slowest (possibly partial) block.
  const early: string[][] = [];
  const slowFirst = [...rest].reverse();
  const firstSize = rest.length % lanes === 0 ? lanes : rest.length % lanes;
  let cursor = 0;
  let size = firstSize;
  while (cursor < slowFirst.length) {
    early.push(slowFirst.slice(cursor, cursor + size).reverse());
    cursor += size;
    size = lanes;
  }
  // Keep at least `minPerHeat` in the first heat by moving the slowest of the next heat into it.
  const first = early[0];
  const second = early[1] ?? circled[0];
  while (
    first !== undefined &&
    second !== undefined &&
    first.length < minPerHeat &&
    second.length > minPerHeat
  ) {
    first.unshift(second.pop() as string);
  }
  return [...early, ...circled];
}

/** Lane slots for one heat: the k-th fastest in the heat gets `laneOrder[k]`. */
export function laneSlots(
  heatFastestFirst: readonly string[],
  laneOrder: readonly number[],
): PlanSlotV2[] {
  return heatFastestFirst
    .map((participantId, i) => ({
      slot: laneOrder[i] as number,
      source: 'PARTICIPANT' as const,
      participantId,
    }))
    .sort((x, y) => x.slot - y.slot);
}

/** Field entries in start order (optionally at a fixed start interval). */
export function fieldEntries(order: readonly string[], intervalSeconds?: number): PlanEntry[] {
  return order.map((participantId, i) => ({
    participantId,
    position: i + 1,
    ...(intervalSeconds === undefined ? {} : { startOffsetSeconds: i * intervalSeconds }),
  }));
}
