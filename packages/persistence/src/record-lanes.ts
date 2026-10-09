/**
 * BRT-09 lane entry points for the TEST HARNESS (REFERENCE PERSISTENCE FIXTURE lane) and for tests of
 * the canonical boundary. Not exported from the package root; application code (apps/*) must not
 * import this module (tooling/check-no-manual-record.mjs).
 *
 *   persistRecordEvaluation     CANONICAL_ASSEMBLY snapshots must equal the canonical re-assembly;
 *                               REFERENCE_FIXTURE snapshots (synthetic FINAL / V3 / V4 / ratification
 *                               facts) are refused by the normal schema and only succeed in a throwaway
 *                               database carrying the test-only overlay.
 *   recordMarkSupportAssessment same rule for support assessments (only RESCIND persists).
 *   sweepRecordSupport          re-assess standing marks from a support-fact source.
 */
export {
  persistRecordEvaluation,
  recordMarkSupportAssessment,
  sweepRecordSupport,
  standingMarksAt,
  replayCategory,
  validateRecordEvaluation,
  canonicalRecordSupportSource,
  type RecordSupportSource,
} from './record-store';
