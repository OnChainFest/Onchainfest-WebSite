-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY DDL OVERLAY — REFERENCE PERSISTENCE FIXTURE LANE (BRT-08, ADR-0037).
-- NOT A MIGRATION. NEVER applied by db:bootstrap, db:migrate, any seed, the API, the worker or any
-- runtime role. Installed only by the test harness (@br/testkit/achievements), as the migration
-- OWNER, into an explicitly THROWAWAY database (name br_achfx_<12 hex>, br_recfx_<12 hex> for the
-- BRT-09 record lane, or br_rkfx_<12 hex> for the BRT-10 QUALIFIED lane, together with the ranking
-- overlay) that is dropped after use.
--
-- It relaxes ONLY the two provenance CHECK constraints of the normal schema so that REFERENCE_FIXTURE
-- derivations (synthetic V2 / FINAL / hold / credited-lineup facts, in memory) can exercise BRT-08's
-- own persistence mechanics: hashing, basis storage, memberCredits, natural idempotency, concurrency,
-- dependency index, status history, supersession / revocation and read-model rebuild. No upstream
-- canonical table (results, verification, attestation, evidence, competition, identity) is touched:
-- synthetic sporting facts are never persisted (ADR-0035, ADR-0026 unchanged).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF current_database() !~ '^br_(achfx|recfx|rkfx)_[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'refusing to install the achievement fixture overlay into %: not a throwaway fixture database', current_database();
  END IF;
END
$$;

ALTER TABLE achievement.achievement
  DROP CONSTRAINT achievement_canonical_provenance_only,
  ADD CONSTRAINT achievement_fixture_overlay_provenance
    CHECK (snapshot_provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));

ALTER TABLE achievement.status_entry
  DROP CONSTRAINT status_entry_canonical_provenance_only,
  ADD CONSTRAINT status_entry_fixture_overlay_provenance
    CHECK (assessment_provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));

-- BRT-10 (0027): the QUALIFIED → qualifying-position link carries the same provenance containment.
-- (Canonical QUALIFIED rows stay refused by BR184 — no target-authority producer — in every database.)
ALTER TABLE achievement.qualification_basis
  DROP CONSTRAINT qualification_basis_canonical_provenance_only,
  ADD CONSTRAINT qualification_basis_fixture_overlay_provenance
    CHECK (provenance IN ('CANONICAL_ASSEMBLY', 'REFERENCE_FIXTURE'));
