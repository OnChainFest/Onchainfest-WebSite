import { CanonicalError, type ContentHash } from '@br/canonical';
import type { Mark, RecordStanding, TiePolicy } from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { compareUnder } from './engine';
import { recordIntegrity } from './snapshot';

/**
 * Deterministic chronological replay of ONE category's record history (BRT-01 RC-1…RC-3, disputes
 * §5.3). Record state is never a pointer chain: it is a pure function of the append-only facts —
 * every mark that was validly ratified (RATIFIED / CANONICAL at some point), whether it has since
 * been RESCINDED or replaced by a correction (valid = false), its exact value and its SPORTING time.
 *
 *   order   valid marks by (effectiveFrom, ratification order, id)
 *   walk    first mark → current; strictly better → the current holder(s) end at its effectiveFrom
 *           and it becomes current; exactly equal → SHARED: co-current, FIRST_ACHIEVED: never
 *           current (the first achiever keeps it); worse → never current
 *
 * After a rescission the SAME replay over the surviving marks yields the restored current record,
 * including any intermediate marks (A → B → C → D with B and D invalid ⇒ C current, A and C's
 * periods recomputed) — never "previousMarkId and stop". Pending marks never take part (RC-2).
 */
export interface ReplayMark {
  readonly recordMarkId: string;
  readonly value: Mark;
  readonly effectiveFrom: string;
  /** Ratification order (the platform tie-break after the sporting time). */
  readonly ratifiedSeq: number;
  readonly standing: RecordStanding;
  /** false once RESCINDED or replaced by a correction mark. */
  readonly valid: boolean;
}

export interface ReplayInput {
  readonly categoryId: string;
  readonly tiePolicy: TiePolicy;
  readonly comparator: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  readonly marks: readonly ReplayMark[];
}

export interface ReplayMarkState {
  readonly recordMarkId: string;
  /** Held record standing now (effectiveTo open). */
  readonly current: boolean;
  /** Whether it ever held the record in the replayed history (false: never current). */
  readonly held: boolean;
  /** When its holding ended (the displacing mark's effectiveFrom), or its own time if never held. */
  readonly effectiveTo?: string;
  /** The mark that ended (or pre-empted) its holding. */
  readonly supersededBy?: string;
  readonly cause?: 'BETTER_MARK' | 'EQUAL_FIRST_ACHIEVED' | 'NOT_BETTER';
}

export interface ReplayResult {
  readonly replayHash: ContentHash;
  /** Current holders (all exactly equal values; ≥ 2 only under SHARED). */
  readonly current: readonly string[];
  readonly marks: readonly ReplayMarkState[];
}

export const MAX_REPLAY_MARKS = 10_000;

export function replayRecordHistory(input: ReplayInput): ReplayResult {
  if (input.marks.length > MAX_REPLAY_MARKS)
    throw recordIntegrity('REPLAY_TOO_LARGE', 'record history exceeds the replay bound');
  let replayHash: ContentHash;
  let normalized: ReplayInput;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.recordReplay,
      SchemaRef.recordReplayInput.id,
      SchemaRef.recordReplayInput.version,
      input,
    );
    replayHash = r.contentHash;
    normalized = r.normalized as unknown as ReplayInput;
  } catch (err) {
    if (err instanceof CanonicalError)
      throw recordIntegrity('REPLAY_INPUT_NOT_CANONICAL', `${err.code} at ${err.path}`);
    throw err;
  }
  const valid = normalized.marks
    .filter((m) => m.valid)
    .sort((a, b) => {
      const t = Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom);
      if (t !== 0) return t;
      if (a.ratifiedSeq !== b.ratifiedSeq) return a.ratifiedSeq - b.ratifiedSeq;
      return a.recordMarkId < b.recordMarkId ? -1 : a.recordMarkId > b.recordMarkId ? 1 : 0;
    });
  const state = new Map<string, ReplayMarkState>();
  let current: ReplayMark[] = [];
  for (const m of valid) {
    const head = current[0];
    if (head === undefined) {
      current = [m];
      continue;
    }
    const c = compareUnder(normalized.comparator, m.value.value, head.value.value);
    if (c > 0) {
      for (const x of current)
        state.set(x.recordMarkId, {
          recordMarkId: x.recordMarkId,
          current: false,
          held: true,
          effectiveTo: m.effectiveFrom,
          supersededBy: m.recordMarkId,
          cause: 'BETTER_MARK',
        });
      current = [m];
    } else if (c === 0 && normalized.tiePolicy === 'SHARED') {
      current.push(m);
    } else {
      state.set(m.recordMarkId, {
        recordMarkId: m.recordMarkId,
        current: false,
        held: false,
        effectiveTo: m.effectiveFrom,
        supersededBy: head.recordMarkId,
        cause: c === 0 ? 'EQUAL_FIRST_ACHIEVED' : 'NOT_BETTER',
      });
    }
  }
  for (const x of current)
    state.set(x.recordMarkId, { recordMarkId: x.recordMarkId, current: true, held: true });
  const marks = valid.map((m) => state.get(m.recordMarkId) as ReplayMarkState);
  return {
    replayHash,
    current: current.map((m) => m.recordMarkId).sort(),
    marks,
  };
}
