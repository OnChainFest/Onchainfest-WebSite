import type { ResultVersionContent } from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { scoreContest } from './execute';
import {
  STATUS_OUTCOME,
  type EntryStatus,
  type GolfEntry,
  type PinfallEntry,
  type ScoreSheet,
  type ScoringContext,
  type ScoringOutcome,
  type TimedEntry,
} from './types';

/**
 * Reading stored content back (ONCF-05C). Content in the ResultLedger is the canonical score
 * representation; to classify it, the ruleset re-derives the score sheet from the content's
 * entries and Performances (the documented ordinal layout), re-validates it, and requires the
 * re-normalized content to equal the stored content exactly. Anything else — hand-edited marks,
 * an impossible score, content written under another ruleset — fails closed (CONTENT_NOT_CANONICAL),
 * so an invalid score can never be classified.
 */

type Perf = NonNullable<ResultVersionContent['performances']>[number];

/**
 * The ResultLedger's own content hash (`br:result-version-content@1`, BR-JSON canonical form): set
 * order and default members are canonicalized, so equality means "the same canonical content".
 * Content that does not even canonicalize can never match.
 */
function canonicalHash(content: unknown): string | undefined {
  try {
    return platformCanonicalizer().hashCanonical(
      DomainTag.resultVersionContent,
      SchemaRef.resultVersionContent.id,
      SchemaRef.resultVersionContent.version,
      content,
    ).contentHash;
  } catch {
    return undefined;
  }
}

/** Key-order independent, deterministic JSON (diagnostics). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const OUTCOME_STATUS = Object.fromEntries(
  Object.entries(STATUS_OUTCOME).map(([s, o]) => [o, s as EntryStatus]),
) as Record<string, EntryStatus>;

function perfsOf(content: ResultVersionContent, participantId: string): Perf[] {
  return (content.performances ?? []).filter((p) => p.participantId === participantId);
}
const at = (ps: readonly Perf[], ordinal: number): number | undefined => {
  const p = ps.find((x) => x.ordinal === ordinal);
  return p === undefined ? undefined : Number(p.mark.value);
};
const range = (ps: readonly Perf[], from: number, to: number): number[] =>
  ps
    .filter((p) => p.ordinal >= from && p.ordinal <= to)
    .sort((x, y) => x.ordinal - y.ordinal)
    .map((p) => Number(p.mark.value));

function sheetFromContent(
  ctx: ScoringContext,
  content: ResultVersionContent,
): ScoreSheet | undefined {
  const family = ctx.ruleset.family;
  const outcome = (id: string) => content.entries.find((e) => e.participantId === id)?.outcome;
  const [a, b] = ctx.participants as readonly [string, string];
  switch (family) {
    case 'SETS_OF_GAMES': {
      const loserWo = [a, b].findIndex((id) => outcome(id) === 'WALKOVER_LOSS');
      if (loserWo >= 0)
        return { family, sets: [], termination: { kind: 'WALKOVER', side: loserWo as 0 | 1 } };
      const pa = perfsOf(content, a);
      const pb = perfsOf(content, b);
      const ga = range(pa, 1, 5);
      const gb = range(pb, 1, 5);
      const sets = ga.map((x, i) => {
        const ta = at(pa, 11 + i);
        const tb = at(pb, 11 + i);
        return {
          games: [x, gb[i] as number] as const,
          ...(ta === undefined || tb === undefined ? {} : { tiebreak: [ta, tb] as const }),
        };
      });
      const ma = at(pa, 20);
      const mb = at(pb, 20);
      const retired = [a, b].findIndex((id) => outcome(id) === 'RETIRED');
      return {
        family,
        sets,
        ...(ma === undefined || mb === undefined ? {} : { matchTiebreak: [ma, mb] as const }),
        ...(retired < 0
          ? {}
          : { termination: { kind: 'RETIRED' as const, side: retired as 0 | 1 } }),
      };
    }
    case 'TIMED_PERIODS': {
      const loserWo = [a, b].findIndex((id) => outcome(id) === 'WALKOVER_LOSS');
      if (loserWo >= 0)
        return { family, periods: [], termination: { kind: 'FORFEIT', side: loserWo as 0 | 1 } };
      const pa = perfsOf(content, a);
      const pb = perfsOf(content, b);
      const per = range(pa, 1, 8).map((x, i) => [x, range(pb, 1, 8)[i] as number] as const);
      const ot = range(pa, 11, 19).map((x, i) => [x, range(pb, 11, 19)[i] as number] as const);
      const defaulted = [a, b].findIndex((id) => at(perfsOf(content, id), 30) === 1);
      return {
        family,
        periods: per,
        ...(ot.length === 0 ? {} : { overtimes: ot }),
        ...(defaulted < 0
          ? {}
          : { termination: { kind: 'DEFAULT' as const, side: defaulted as 0 | 1 } }),
      };
    }
    case 'TIMED_OR_TARGET': {
      const loserWo = [a, b].findIndex((id) => outcome(id) === 'WALKOVER_LOSS');
      if (loserWo >= 0)
        return {
          family,
          regulation: [0, 0],
          endedBy: 'TIME',
          termination: { kind: 'FORFEIT', side: loserWo as 0 | 1 },
        };
      const pa = perfsOf(content, a);
      const pb = perfsOf(content, b);
      const oa = at(pa, 2);
      const ob = at(pb, 2);
      return {
        family,
        regulation: [at(pa, 1) ?? -1, at(pb, 1) ?? -1],
        endedBy: at(pa, 3) === 1 ? 'TARGET' : 'TIME',
        ...(oa === undefined || ob === undefined ? {} : { overtime: [oa, ob] as const }),
      };
    }
    case 'ELAPSED_TIME':
    case 'FINISH_ORDER_WITH_TIME':
    case 'LAPS_AND_TIME':
      return {
        family,
        entries: content.entries.map((e): TimedEntry => {
          const ps = perfsOf(content, e.participantId);
          const opt = (k: string, v: number | undefined) => (v === undefined ? {} : { [k]: v });
          const legs = ps
            .filter((p) => p.ordinal >= 11)
            .sort((x, y) => x.ordinal - y.ordinal)
            .map((p) => ({ athleteId: p.athleteId as string, timeMs: Number(p.mark.value) }));
          return {
            participantId: e.participantId,
            status: OUTCOME_STATUS[e.outcome] ?? ('INVALID' as EntryStatus),
            ...opt('timeMs', at(ps, 1)),
            ...opt('netTimeMs', at(ps, 2)),
            ...opt('finishPosition', at(ps, 3)),
            ...opt('lapsCompleted', at(ps, 4)),
            ...opt('lapsDown', at(ps, 5)),
            ...opt('pullOrder', at(ps, 6)),
            ...(legs.length === 0 ? {} : { legs }),
          };
        }),
      };
    case 'FRAMES_PINFALL':
      return {
        family,
        entries: content.entries.map((e): PinfallEntry => {
          const ps = perfsOf(content, e.participantId);
          const status = e.outcome === 'RANKED' ? 'FINISHED' : (e.outcome as 'DNS' | 'DQ');
          if (status !== 'FINISHED') return { participantId: e.participantId, status };
          const own = range(ps, 1, 89);
          const memberPs = ps.filter((p) => p.ordinal >= 100 && p.athleteId !== undefined);
          if (memberPs.length === 0) return { participantId: e.participantId, status, games: own };
          const byMember = new Map<string, Perf[]>();
          for (const p of memberPs)
            byMember.set(p.athleteId as string, [
              ...(byMember.get(p.athleteId as string) ?? []),
              p,
            ]);
          return {
            participantId: e.participantId,
            status,
            members: [...byMember.entries()].map(([athleteId, list]) => ({
              athleteId,
              games: list.sort((x, y) => x.ordinal - y.ordinal).map((p) => Number(p.mark.value)),
            })),
          };
        }),
      };
    case 'STROKES':
    case 'STABLEFORD': {
      const anyPs = (content.performances ?? []).filter(
        (p) => p.ordinal >= 201 && p.ordinal <= 399,
      );
      const firstOwner = anyPs[0]?.participantId;
      const cp = firstOwner === undefined ? [] : perfsOf(content, firstOwner);
      const pars = range(cp, 201, 299);
      const sis = range(cp, 301, 399);
      const H = Number((ctx.ruleset.parameters as { holes: string }).holes);
      return {
        family,
        ...(pars.length === 0
          ? {}
          : { course: { holes: pars.map((par, i) => ({ par, strokeIndex: sis[i] as number })) } }),
        entries: content.entries.map((e): GolfEntry => {
          const ps = perfsOf(content, e.participantId);
          const status = e.outcome === 'RANKED' ? 'FINISHED' : (e.outcome as 'DNF' | 'DNS' | 'DQ');
          if (status !== 'FINISHED') return { participantId: e.participantId, status };
          const memberHoles = ps.filter((p) => p.ordinal >= 1000);
          const memberChs = ps.filter((p) => p.ordinal > 400 && p.ordinal < 500);
          const ch = at(ps, 400);
          const roster = ctx.rosters?.[e.participantId] ?? [];
          const mchs = memberChs.map((p) => ({
            athleteId: p.athleteId as string,
            courseHandicap: Number(p.mark.value),
          }));
          if (memberHoles.length > 0) {
            const members = roster
              .map((athleteId, mi) => {
                const list = memberHoles.filter((p) => p.athleteId === athleteId);
                if (list.length === 0) return undefined;
                return {
                  athleteId,
                  holes: Array.from(
                    { length: H },
                    (_, h) => at(list, (mi + 1) * 1000 + h + 1) ?? 0,
                  ),
                };
              })
              .filter((m): m is { athleteId: string; holes: number[] } => m !== undefined);
            return {
              participantId: e.participantId,
              status,
              members,
              ...(mchs.length === 0 ? {} : { memberCourseHandicaps: mchs }),
            };
          }
          return {
            participantId: e.participantId,
            status,
            holes: range(ps, 1, 99),
            ...(ch === undefined ? {} : { courseHandicap: ch }),
            ...(mchs.length === 0 ? {} : { memberCourseHandicaps: mchs }),
          };
        }),
      };
    }
    case 'MATCH_PLAY_HOLES': {
      const pa = perfsOf(content, a);
      const conceded = [a, b].findIndex((id) => at(perfsOf(content, id), 99) === 1);
      return {
        family,
        holes: range(pa, 1, 98).map((v) => (v === 2 ? 'A' : v === 1 ? 'HALVED' : 'B')),
        ...(conceded < 0 ? {} : { conceded: { side: conceded as 0 | 1 } }),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Re-derives and re-validates stored content under the ruleset. ok ⇒ the normalized result, which
 * is exactly what classification consumes.
 */
export function readContestContent(
  ctx: ScoringContext,
  content: ResultVersionContent,
): ScoringOutcome {
  const sheet = sheetFromContent(ctx, content);
  if (sheet === undefined)
    return {
      ok: false,
      issues: [{ path: '', code: 'FAMILY_UNSUPPORTED', message: 'unknown ruleset family' }],
    };
  const scored = scoreContest(ctx, sheet);
  if (!scored.ok) return scored;
  const expected = canonicalHash(scored.content);
  const stored = canonicalHash(content);
  if (expected === undefined || stored === undefined || expected !== stored)
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'CONTENT_NOT_CANONICAL',
          message: 'the stored content is not this ruleset’s normalization of a valid score',
        },
      ],
    };
  return scored;
}
