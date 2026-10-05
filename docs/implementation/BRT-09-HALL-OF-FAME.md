# BRT-09 — Record Hall of Fame (read model)

ADR: [0046](../adr/ADR-0046-record-hall-of-fame-is-a-projection.md). Code: `db/migrations/0022_record_read_models.sql`, `packages/persistence/src/record-projection.ts`, `record-reader.ts`, `apps/web/app/hall-of-fame`.

## 1. Definition

The Record Hall of Fame = current + former **legitimate** record holders of non-PERSONAL categories, as a class-B projection of RecordMark history. It is not an induction system, greatness score, popularity ranking, editorial award, ranking, or M18's broader archive.

## 2. Read models (all class B, rebuildable)

| Table | Content |
|---|---|
| `record_read.category_card` | latest version policy (public-safe: no keeper principal) + current value / holders |
| `record_read.mark_card` | every mark: status, label, materialized effective period, current / ever-held flags |
| `record_read.hall_of_fame_entry` | RATIFIED / CANONICAL (CURRENT) and SUPERSEDED-after-holding (FORMER) marks only |
| `record_read.athlete_record` | Passport: HOLDER / TEAM_MEMBER rows referencing the canonical mark |
| `record_read.v_record_set_link` | read-only view of the RECORD_SET link (BRT-01 `achievementId`) |

PENDING and RESCINDED marks never enter the Hall of Fame; they remain in the category history, labelled. SHARED co-holders all appear. Rebuild: `rebuildRecordReadModels(maintenance)` — truncate + re-derive; byte-equal to the incremental state (tested in both lanes).

## 3. Public API

`GET /v1/hall-of-fame/records?sport&discipline&scopeType&region&category&holding&cursor&limit` (bounded filters, opaque cursor, ≤ 50; no filter language, no sort / score parameter). Also `GET /v1/records/:id`, `GET /v1/record-categories/:idOrCode{,/current,/history}`, `GET /v1/athletes/:slug/records`.

## 4. Privacy

DTOs (`br:public-record-mark@1`, `br:public-record-hall-of-fame@1`) carry athlete display through the Passport privacy policy (restricted / private / minor ⇒ "Private entrant", no id), team name, value, label, period, status, recognition level / region / sport and the RECORD_SET id — never anchor ids, anchor fact hashes, grants, principal ids, keys, attestation topology, evidence refs, Person / Account ids, DOB, e-mail or wallets.
