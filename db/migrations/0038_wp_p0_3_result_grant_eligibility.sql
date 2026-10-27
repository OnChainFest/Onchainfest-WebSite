-- WP-P0-3 Q3 · Result grants are bound to the eligibility they were issued on (ADR-0079 §2.3).
-- Additive: 0001–0037 are untouched. One append-only table, written only by the ADR-0077 issuance
-- (ResultAuthorityGovernance, in the transaction that holds the grantee's eligibility keys) and read
-- by that issuance and by the result-staff gate of every competition result command.
--
--   competition.result_grant_eligibility · per ADR-0077 grant: the account, the organizer
--                                          organization and the OWNER / ADMIN staff rows and
--                                          memberships it rested on, each with the number of status
--                                          changes its append-only history had at issuance
--
-- A grant is usable for result writes only while the account history and at least one bound basis
-- (a membership also with the organization history) have no change since: the counters are decided
-- in commit order under the eligibility keys, never by comparing transaction-start timestamps. A
-- grant without a row here (legacy, or not issued by ADR-0077) is refused until re-issued.

CREATE TABLE competition.result_grant_eligibility (
  grant_id             uuid PRIMARY KEY REFERENCES authority.authority_grant (id),
  competition_id       uuid NOT NULL REFERENCES competition.competition (id),
  account_id           uuid NOT NULL REFERENCES identity.account (id),
  person_id            uuid NOT NULL REFERENCES identity.person (id),
  organization_id      uuid NOT NULL REFERENCES organizations.organization (id),
  account_changes      integer NOT NULL CHECK (account_changes >= 1),
  organization_changes integer NOT NULL CHECK (organization_changes >= 1),
  -- [{ "kind": "STAFF" | "MEMBERSHIP", "id": <row uuid>, "changes": <status changes, >= 1> }, ...]
  bases                jsonb NOT NULL
    CHECK (jsonb_typeof(bases) = 'array' AND jsonb_array_length(bases) BETWEEN 1 AND 64),
  recorded_at          timestamptz NOT NULL
);
CREATE INDEX result_grant_eligibility_competition_idx
  ON competition.result_grant_eligibility (competition_id, person_id);

CREATE TRIGGER result_grant_eligibility_append_only BEFORE UPDATE OR DELETE
  ON competition.result_grant_eligibility FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER result_grant_eligibility_no_truncate BEFORE TRUNCATE
  ON competition.result_grant_eligibility FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
CREATE TRIGGER result_grant_eligibility_recorded_at BEFORE INSERT
  ON competition.result_grant_eligibility FOR EACH ROW EXECUTE FUNCTION platform.assert_recorded_at();

GRANT SELECT, INSERT ON competition.result_grant_eligibility TO br_competition;
GRANT SELECT ON competition.result_grant_eligibility TO br_rebuild;
