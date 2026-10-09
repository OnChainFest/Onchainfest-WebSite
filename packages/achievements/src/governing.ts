import { RECOGNITION_RANK } from './rule';
import type {
  GoverningRecognition,
  GoverningRecognitionScope,
  RecognitionLevelValue,
} from './snapshot';

/** The governing decision exactly as pinned in the run trace (before the anchor fact is attached). */
export interface PinnedGoverningDecision {
  readonly recognitionLevel: RecognitionLevelValue;
  readonly anchorId: string;
  readonly source: 'CERTIFICATION' | 'SANCTION';
  /** The anchor's recognition levels as recorded by the trace (cross-checked with the anchor fact). */
  readonly anchorLevels: readonly string[];
}

/**
 * BRT-01 §8.1 `governingAuthority` / AC-4, derived ONLY from the immutable documents of a pinned
 * VerificationRun (its stored outcome + trace, both hash-bound by BRT-07) — never from today's mutable
 * authority state. Later grant / anchor changes therefore cannot rewrite it.
 *
 *   V3 satisfied → the SANCTION: the authorized SANCTION decision of the passing
 *                  COMPETITION_SANCTIONED criterion (its anchor and the recognition level the
 *                  sanction was authorized at);
 *   V2 satisfied → the CERTIFICATION: the authorized DECLARE_OFFICIAL / ATTEST_RESULT decision of the
 *                  passing OFFICIAL_DECLARATION criterion (its anchor and that anchor's highest
 *                  recognition level; a platform-only anchor gives PLATFORM);
 *   otherwise    → none (V0 / V1 involve no authority).
 * Ties are broken deterministically (higher rank, then lower anchor id).
 */
export interface PinnedTraceDecision {
  readonly capability: string;
  readonly authorized: boolean;
  readonly anchorId?: string;
  readonly anchorLevels?: readonly string[];
  readonly recognitionLevel?: string;
}
export interface PinnedTraceCriterion {
  readonly kind: string;
  readonly status: string;
  readonly authority?: readonly PinnedTraceDecision[];
}

const rank = (l: string) => (l === 'PLATFORM' ? 0 : (RECOGNITION_RANK[l] ?? 0));
const best = (xs: PinnedGoverningDecision[]) =>
  [...xs].sort(
    (a, b) =>
      rank(b.recognitionLevel) - rank(a.recognitionLevel) ||
      (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0),
  )[0];

export function governingRecognitionFromRun(input: {
  readonly satisfiedLevels: readonly string[];
  readonly criteria: readonly PinnedTraceCriterion[];
}): PinnedGoverningDecision | undefined {
  const passing = (kind: string) =>
    input.criteria
      .filter((c) => c.kind === kind && c.status === 'PASS')
      .flatMap((c) => c.authority ?? []);
  if (input.satisfiedLevels.includes('V3')) {
    const sanction = passing('COMPETITION_SANCTIONED')
      .filter(
        (d) =>
          d.authorized &&
          d.capability === 'SANCTION' &&
          d.anchorId !== undefined &&
          d.recognitionLevel !== undefined &&
          d.recognitionLevel !== 'PLATFORM',
      )
      .map((d) => ({
        recognitionLevel: d.recognitionLevel as RecognitionLevelValue,
        anchorId: d.anchorId as string,
        source: 'SANCTION' as const,
        anchorLevels: [...(d.anchorLevels ?? [])].sort(),
      }));
    const b = best(sanction);
    if (b !== undefined) return b;
  }
  if (input.satisfiedLevels.includes('V2')) {
    const cert = passing('OFFICIAL_DECLARATION')
      .filter(
        (d) =>
          d.authorized &&
          (d.capability === 'DECLARE_OFFICIAL' || d.capability === 'ATTEST_RESULT') &&
          d.anchorId !== undefined,
      )
      .map((d) => {
        const levels = (d.anchorLevels ?? []).filter((l) => l !== 'PLATFORM');
        const top = levels.sort((a, b) => rank(b) - rank(a))[0];
        return {
          recognitionLevel: (top ?? 'PLATFORM') as RecognitionLevelValue,
          anchorId: d.anchorId as string,
          source: 'CERTIFICATION' as const,
          anchorLevels: [...(d.anchorLevels ?? [])].sort(),
        };
      });
    return best(cert);
  }
  return undefined;
}

/**
 * Attaches the IMMUTABLE trust-anchor fact the pinned trace names (its fact hash and recognition
 * scope). The anchor's recognition levels must equal the levels the trace recorded for that anchor
 * — otherwise the pinned documents and the fact disagree (integrity failure, reported as undefined).
 */
export function attachAnchorFact(
  decision: PinnedGoverningDecision,
  anchor: { readonly factHash: string; readonly recognitionScope: GoverningRecognitionScope },
): GoverningRecognition | undefined {
  const levels = [...anchor.recognitionScope.recognitionLevel].sort();
  if (JSON.stringify(levels) !== JSON.stringify([...decision.anchorLevels].sort()))
    return undefined;
  return {
    recognitionLevel: decision.recognitionLevel,
    anchorId: decision.anchorId,
    source: decision.source,
    anchorFactHash: anchor.factHash,
    recognitionScope: anchor.recognitionScope,
  };
}

/**
 * Public wording: recognition LEVEL, and the public geographic / sport scope — never anchor, grant,
 * principal identifiers or the grant chain.
 */
export function governingRecognitionStatement(
  level: RecognitionLevelValue,
  scope?: { readonly region?: readonly string[]; readonly sport?: readonly string[] },
): string {
  if (level === 'PLATFORM')
    return 'Certified by an authority recognized by the platform only — no federation-level recognition.';
  const parts = [
    ...(scope?.region === undefined ? [] : [`region ${[...scope.region].sort().join(', ')}`]),
    ...(scope?.sport === undefined ? [] : [`sport ${[...scope.sport].sort().join(', ')}`]),
  ];
  return `Backed by an authority recognized at ${level} level${parts.length === 0 ? '' : ` (${parts.join('; ')})`}.`;
}
