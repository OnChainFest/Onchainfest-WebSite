/**
 * BRT-08 lane entry points for the TEST HARNESS (REFERENCE PERSISTENCE FIXTURE lane) and for tests
 * of the canonical boundary. Not exported from the package root; application code (apps/*) must not
 * import this module (tooling/check-no-manual-achievement.mjs).
 *
 *   persistDerivation       CANONICAL_ASSEMBLY snapshots must equal the canonical re-assembly;
 *                           REFERENCE_FIXTURE snapshots are refused by the normal database schema and
 *                           only succeed in a throwaway database carrying the test-only overlay.
 *   recordSupportAssessment same rule for current-support assessments.
 *   sweepSupport / liveSupport  re-assess (write) / assess (read-only) current support from a source:
 *                           the canonical source in production (worker, public reads); a
 *                           REFERENCE_FIXTURE source only in the throwaway overlay database.
 */
export {
  canonicalSupportSource,
  liveSupport,
  persistDerivation,
  recordSupportAssessment,
  sweepSupport,
  validateCandidate,
  type SupportFactSource,
} from './achievement-store';
