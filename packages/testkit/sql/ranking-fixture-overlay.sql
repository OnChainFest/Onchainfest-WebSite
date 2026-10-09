-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY DDL OVERLAY — BRT-10 REFERENCE PERSISTENCE FIXTURE LANE (ADR-0037 pattern, ADR-0048).
-- NOT A MIGRATION. NEVER applied by db:bootstrap, db:migrate, any seed, the API, the worker or any
-- runtime role. Installed only by the test harness (@br/testkit/rankings), as the migration OWNER,
-- into an explicitly THROWAWAY database (name br_rkfx_<12 hex>) that is dropped after use.
--
-- It relaxes ONLY the ranking run / snapshot provenance CHECKs so that REFERENCE_FIXTURE runs and
-- snapshots (whose basis rests on synthetic FINAL / V2+ / hold facts held in memory) can exercise
-- BRT-10's own persistence mechanics: run identity, snapshot hash uniqueness, entries, lineage
-- (FOLLOWS / CORRECTS) and immutability. The canonical-basis binding of snapshot entries still
-- applies to every CANONICAL_ASSEMBLY row. No upstream canonical table (results, verification,
-- attestation, evidence, competition, identity, authority) is touched.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF current_database() !~ '^br_rkfx_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'refusing to install the ranking fixture overlay into %: not a throwaway fixture database', current_database();
  END IF;
END
$$;

ALTER TABLE ranking.run
  DROP CONSTRAINT run_canonical_provenance_only,
  ADD CONSTRAINT run_fixture_overlay_provenance
    CHECK (provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));

ALTER TABLE ranking.snapshot
  DROP CONSTRAINT snapshot_canonical_provenance_only,
  ADD CONSTRAINT snapshot_fixture_overlay_provenance
    CHECK (provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));
