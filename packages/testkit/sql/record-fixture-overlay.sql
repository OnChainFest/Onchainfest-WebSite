-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY DDL OVERLAY — BRT-09 REFERENCE PERSISTENCE FIXTURE LANE (ADR-0037 pattern, ADR-0045).
-- NOT A MIGRATION. NEVER applied by db:bootstrap, db:migrate, any seed, the API, the worker or any
-- runtime role. Installed only by the test harness (@br/testkit/records), as the migration OWNER,
-- into an explicitly THROWAWAY database (name br_recfx_<12 hex>) that is dropped after use, together
-- with the BRT-08 achievement overlay (so fixture RECORD_SET Achievements can be persisted).
--
-- It relaxes ONLY the record provenance CHECKs so that REFERENCE_FIXTURE evaluations (synthetic FINAL
-- / V3 / V4 / population / condition / hold facts and synthetic RECORD_RATIFIED / REVIEW_COMPLETED
-- ratifications, in memory) can exercise BRT-09's own persistence mechanics: marks, idempotency,
-- ratification, supersession, SHARED / FIRST_ACHIEVED, rescission + chronological replay, dependency
-- index, RECORD_SET linkage and read-model / Hall of Fame rebuild. No upstream canonical table
-- (results, verification, attestation, evidence, competition, identity, authority) is touched:
-- synthetic facts are never persisted there, and no synthetic attestation row is ever created.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF current_database() !~ '^br_recfx_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'refusing to install the record fixture overlay into %: not a throwaway fixture database', current_database();
  END IF;
END
$$;

ALTER TABLE record.record_mark
  DROP CONSTRAINT record_mark_canonical_provenance_only,
  ADD CONSTRAINT record_mark_fixture_overlay_provenance
    CHECK (provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));

ALTER TABLE record.mark_status_entry
  DROP CONSTRAINT mark_status_canonical_provenance_only,
  ADD CONSTRAINT mark_status_fixture_overlay_provenance
    CHECK (assessment_provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE')),
  DROP CONSTRAINT mark_status_canonical_ratification_only,
  ADD CONSTRAINT mark_status_fixture_overlay_ratification
    CHECK (ratification_provenance IS NULL OR ratification_provenance IN ('CANONICAL_ATTESTATION', 'REFERENCE_FIXTURE')),
  -- A fixture ratification belongs only to a fixture mark (never a canonical one).
  ADD CONSTRAINT mark_status_fixture_ratification_on_fixture_mark
    CHECK (ratification_provenance IS DISTINCT FROM 'REFERENCE_FIXTURE' OR assessment_provenance = 'REFERENCE_FIXTURE');

ALTER TABLE record.evaluation
  DROP CONSTRAINT record_evaluation_canonical_provenance_only,
  ADD CONSTRAINT record_evaluation_fixture_overlay_provenance
    CHECK (provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));
