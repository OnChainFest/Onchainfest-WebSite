/**
 * BRT-10 lane entry points for the TEST HARNESS (REFERENCE PERSISTENCE FIXTURE lane) and for tests of
 * the canonical boundary. Not exported from the package root; application code (apps/*) must not
 * import this module.
 *
 *   persistRankingRun      CANONICAL_ASSEMBLY inputs must equal the canonical re-assembly; the outcome
 *                          is always re-evaluated (a claimed outcome / hash is only compared).
 *                          REFERENCE_FIXTURE inputs (synthetic FINAL / V2+ / hold facts) are refused by
 *                          the normal schema and only persist in a throwaway br_rkfx_ overlay database.
 *   publishRankingSnapshot snapshot content is built from the run (a claimed content / hash is only
 *                          compared); a correction lineage is accepted only for REFERENCE_FIXTURE runs.
 */
export {
  persistRankingRun,
  publishRankingSnapshot,
  type RankingRunReport,
  type RankingSnapshotReport,
  type SnapshotCorrection,
} from './ranking-store';
export { assembleRankingRunInput } from './ranking-loader';
