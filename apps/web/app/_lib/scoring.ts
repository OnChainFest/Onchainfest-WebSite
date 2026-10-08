import { apiRequest, type ApiResult } from './platform';
import type { Catalog, CatalogScoringVersion } from './tournaments';

/**
 * ONCF-05C organizer scoring: which ruleset (how one contest is decided) and which classification
 * template (how a group / stage is ordered) a category is scored under, and the classification of
 * a stage computed on read from current results. Classifications are PROPOSALS — not official
 * results — until an authority submits them (ONCF-05D). Nothing here decides a rule; the API does.
 */

export interface EventScoring {
  eventId: string;
  pinned: boolean;
  frozen: boolean;
  ruleset?: (CatalogScoringVersion & { spec: Record<string, unknown> }) | null;
  classificationTemplate?: (CatalogScoringVersion & { spec: Record<string, unknown> }) | null;
  /** ONCF-05D. */
  advancementPolicy?: (CatalogScoringVersion & { spec: Record<string, unknown> }) | null;
}

export interface StageClassification {
  document: {
    complete: boolean;
    policy: { code: string; version: number };
    entries: {
      participantId: string;
      position: number;
      tied: boolean;
      status: string;
      values: { key: string; value: string }[];
      decidedBy?: { criterion: number; kind: string };
    }[];
  };
  hash: string;
  pendingContests: string[];
}

export function eventScoring(token: string, eventId: string): Promise<ApiResult<EventScoring>> {
  return apiRequest(token, 'GET', `/v1/events/${eventId}/scoring`);
}

export function stageClassification(
  token: string,
  eventId: string,
  stageKey: string,
  groupKey?: string,
): Promise<ApiResult<StageClassification>> {
  const q = groupKey === undefined ? '' : `?group=${encodeURIComponent(groupKey)}`;
  return apiRequest(token, 'GET', `/v1/events/${eventId}/stages/${stageKey}/classification${q}`);
}

/** Head-to-head ruleset families are ordered by STANDINGS templates; field families by METRIC ones. */
const HEAD_TO_HEAD = new Set([
  'SETS_OF_GAMES',
  'TIMED_PERIODS',
  'TIMED_OR_TARGET',
  'MATCH_PLAY_HOLES',
]);

/** The rulesets this discipline version can be scored under (catalog-computed compatibility). */
export function compatibleRulesets(
  catalog: Catalog,
  disciplineVersionId: string | undefined,
): CatalogScoringVersion[] {
  const d = catalog.disciplineVersions.find((x) => x.disciplineVersionId === disciplineVersionId);
  const ok = new Set(d?.compatibleRulesetVersionIds ?? []);
  return (catalog.rulesetVersions ?? []).filter((r) => ok.has(r.versionId));
}

/** Templates that fit a ruleset family (STANDINGS ↔ head-to-head, METRIC ↔ field). */
export function templatesFor(
  catalog: Catalog,
  rulesetFamily: string | undefined,
): CatalogScoringVersion[] {
  if (rulesetFamily === undefined) return [];
  const family = HEAD_TO_HEAD.has(rulesetFamily) ? 'STANDINGS' : 'METRIC';
  return (catalog.classificationTemplateVersions ?? []).filter((t) => t.family === family);
}

/** Human label for a version's basis: the governing source, or an explicit common-practice note. */
export function basisLabel(v: Pick<CatalogScoringVersion, 'basis'>): string {
  return v.basis.kind === 'GOVERNING_RULE' ? v.basis.source : `Common practice — ${v.basis.note}`;
}

/** Readable criterion names for "decided by". */
const CRITERION_LABEL: Record<string, string> = {
  POINTS: 'points',
  WINS: 'wins',
  WIN_RATIO: 'win ratio',
  HEAD_TO_HEAD: 'head-to-head',
  TIED_SUBSET: 'tie among three or more',
  DIFFERENCE: 'difference',
  RATIO_PERCENT: 'ratio',
  SUM: 'total',
  AVERAGE: 'average',
  COUNT_BACK: 'count-back',
  FINER_PRECISION: 'finer timing',
  PLACE_SUM: 'sum of places',
  LAST_ROUND_PLACE: 'last round place',
  HIGHEST_SINGLE: 'highest single game',
  SEED: 'seed',
  ORGANIZER_LOT: 'organizer lot',
};

export function decidedByLabel(kind: string | undefined): string | null {
  if (kind === undefined) return null;
  if (kind.startsWith('KEY:')) return kind.slice(4);
  if (kind.startsWith('STATUS:')) return `status ${kind.slice(7)}`;
  return CRITERION_LABEL[kind] ?? kind.toLowerCase();
}
