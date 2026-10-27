-- STG-01A · F1 preflight (read-only). PR #42 security review finding F1: the Authority Engine uses
-- the first valid grant by id, so an active grant that carries a result capability but was not
-- issued (and bound) by `authority:results grant` could shadow the bound ADR-0077 grant.
--
-- Lists every grant that carries a result capability, is not revoked (or is revoked only from a
-- future instant) and is not expired, and has NO eligibility binding (migration 0038), whatever
-- its scope or parent. Delegated (child) result grants are listed too: result authority is never
-- delegable.
--
-- Expected: zero rows. Any row blocks result entry until it is explained and revoked through
-- `authority:results revoke` (an interrupted issuance, runbook LAUNCH-02 §6 step 7, also appears
-- here until its re-grant revokes it).
--
--   docker compose exec -T postgres psql -U br_admin -d onchainfest -v ON_ERROR_STOP=1 \
--     < deploy/staging/sql/f1-foreign-result-grants.sql
BEGIN READ ONLY;

SELECT g.id AS grant_id,
       g.grantor_principal_id,
       g.grantee_principal_id,
       g.parent_grant_id,
       g.capabilities,
       g.scope,
       g.effective_from,
       g.effective_to
  FROM authority.authority_grant g
 WHERE g.capabilities && ARRAY['SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL', 'CORRECT_RESULT']::text[]
   AND (g.effective_to IS NULL OR g.effective_to > now())
   AND NOT EXISTS (SELECT 1
                     FROM authority.authority_grant_status_change s
                    WHERE s.grant_id = g.id AND s.kind = 'REVOKED' AND s.effective_from <= now())
   AND NOT EXISTS (SELECT 1 FROM competition.result_grant_eligibility e WHERE e.grant_id = g.id)
 ORDER BY g.id;

-- Context: result grants that ARE bound, per competition (one per person who may enter results).
SELECT e.competition_id, count(*) AS bound_grants
  FROM competition.result_grant_eligibility e
  JOIN authority.authority_grant g ON g.id = e.grant_id
 WHERE (g.effective_to IS NULL OR g.effective_to > now())
   AND NOT EXISTS (SELECT 1
                     FROM authority.authority_grant_status_change s
                    WHERE s.grant_id = g.id AND s.kind = 'REVOKED' AND s.effective_from <= now())
 GROUP BY e.competition_id
 ORDER BY e.competition_id;

ROLLBACK;
