# BRT-05 — Development Guide

Extends [BRT-04-DEVELOPMENT.md](./BRT-04-DEVELOPMENT.md) and [BRT-03-DEVELOPMENT.md](./BRT-03-DEVELOPMENT.md): prerequisites, the Windows + WSL notes, the explicit development secrets and the everyday commands still apply. All commands run from the repository root.

## 1. What changed for developers

| Area | BRT-05 addition |
|---|---|
| Packages | `@br/competition` (pure: catalog specs, lifecycles, format engines, `br-draw/1`, operational permissions, hierarchy scope paths, public DTOs) |
| Persistence | `CatalogStore`, `CompetitionStore`, `StructureStore`, `TeamStore`, `CompetitionReader`, `CompetitionHierarchyResolver`, `authorizeInHierarchy`, `competitionResultScopeValidator`, `rebuildCompetitionReadModels` |
| Result ledger | Optional `scopeValidator` port (BRT-03 behaviour unchanged without it) |
| Migrations | `0007_sports_catalog.sql`, `0008_competition_engine.sql`, `0009_competition_read_models.sql` (0001–0006 untouched) |
| DB roles | Module role `br_competition` (assumable by `br_api`); module role `br_catalog` assumable **only** by the new login `br_operator_app` (BRT-05R); `br_public_read`, `br_rebuild`, `br_authority`, `br_results` extended narrowly |
| BRT-04 vocabularies | Organization permission `ORG_MANAGE_COMPETITIONS` (OWNER/ADMIN); person operation `REGISTER_FOR_EVENT` (SELF + confirmed guardian); error `CAPACITY_REACHED` (HTTP 409) |
| API | Competition `/v1` endpoints (see [BRT-05-COMPETITION-ENGINE.md](./BRT-05-COMPETITION-ENGINE.md) §15); new classification `COMP_STAFF`; `/health` reports `phase: BRT-05` |
| Web | `/competitions/[slug]`, `/competitions/[slug]/events/[eventSlug]` |

## 2. Setup

```bash
pnpm install
pnpm db:up                   # or on WSL without the Docker socket: docker.exe compose up -d --wait postgres
pnpm db:bootstrap            # also creates br_catalog, br_competition and the br_operator_app login
pnpm db:migrate              # applies 0001–0009
pnpm db:seed:competition     # optional: fictional catalog + 2 competitions (idempotent; safe to re-run)
```

- `pnpm db:reset` also drops `competition_read`, `competition` and `sports`.
- The environment is unchanged from BRT-04. The competition seed needs no vault key; `demo:competition` uses `BR_VAULT_DEV_KEY` if set, and otherwise an explicitly requested ephemeral key.

**The seed is fictional and idempotent:**
- **Catalog:** `padel.doubles@1`, `tennis.singles@1`, `running.5k@1` (catalog only: no heat engine), `single-elimination/1`, `round-robin/1`.
- **`fictional-padel-open` / `open-doubles`:** 4 pairs, single elimination, 3 contests.
- **`fictional-club-league` / `league-singles`:** 5 players, round robin, 10 contests.
- Running it twice prints byte-identical output, including plan hashes.

## 3. API with development auth

```bash
# BR_DEV_AUTH_SECRET exported as in BRT-04 §2
BR_DEV_AUTH=1 pnpm dev:api
OP=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:operator --operator)
ORG=$(BR_DEV_AUTH=1 pnpm -s --filter @br/api dev-token seed:comp-organizer)
curl -s localhost:4000/v1/catalog | jq .
curl -s localhost:4000/v1/competitions/fictional-padel-open | jq .
curl -s localhost:4000/v1/competitions/fictional-padel-open/events/open-doubles/bracket | jq '.rounds[].contests[].slots'
# catalog mutation is INTERNAL (operator token only):
curl -s -X POST localhost:4000/v1/internal/catalog/sports -H "authorization: Bearer $OP" \
  -H 'idempotency-key: local-sport-1' -H 'content-type: application/json' -d '{"code":"squash","name":"Squash"}'
# organizer-only operations need the organizer's token, e.g.
curl -s localhost:4000/v1/competitions/<competitionId>/permissions -H "authorization: Bearer $ORG"
pnpm dev:web   # http://localhost:3000/competitions/fictional-padel-open
```

## 4. Commands

| Purpose | Command |
|---|---|
| BRT-05 acceptance walkthrough (31 steps, fictional, in-process `/v1`) | `pnpm demo:competition` |
| Competition seed | `pnpm db:seed:competition` |
| Earlier walkthroughs | `pnpm demo:foundation`, `pnpm demo:identity` |

`demo:competition` exits non-zero unless all 31 steps run and its invariants hold:
- the organizer holds no authority;
- plan replays return the same plan;
- no Result is created;
- a rebuild is identical;
- no PII appears in DTOs or the outbox.

## 5. Tests

| Suite | File | Covers |
|---|---|---|
| unit/property | `packages/competition/src/competition.test.ts` | SE (2–8 + property 2..64), RR (2–5 + property 2..40), engine guards, registry, draw, lifecycle matrices (every pair), catalog spec validation and hashing, categories, permissions ≠ capabilities, hierarchy scope containment |
| integration | `packages/persistence/src/competition.int.test.ts` | Catalog immutability and pinning, competition lifecycle and permissions, slug race, capacity (20 vs 4) + DB trigger, idempotency, approval mode, waitlist promotion, field lock, seeding, concurrent plan generation, plan immutability, contests, withdrawal, lineups, teams (temporal), rebuild equivalence, public structure |
| integration | `packages/persistence/src/competition-authority.int.test.ts` | Resolver paths, fail-closed ids, immutable ancestry, C1/E1/A containment with real grants, sport/discipline scoping, operational ≠ authority, FEDERATION, result linkage (borrowed ancestry refused) |
| integration | `packages/persistence/src/competition-roles.int.test.ts` | Role graph, writer/catalog/public/rebuild/probe/vault isolation, append-only (owner), resolver function security |
| integration | `packages/persistence/src/security.int.test.ts` | Full login → role graph (updated: `br_api` → `br_competition`; `br_operator_app` → `br_catalog` only) |
| integration | `apps/api/src/competition.int.test.ts` | API catalog (operator), full organizer flow, 401/403/400 boundaries, strict DTOs, minor as PRIVATE_ENTRANT, sentinel privacy over DTOs/outbox/audit/read models/logs |
| integration | `apps/api/src/v1.int.test.ts` | Classification list updated with `COMP_STAFF` (every route classified; 401 without credentials) |

## 6. Environment finding: database clock steps (Docker Desktop / WSL)

During a BRT-05 test run the Postgres VM clock was observed **stepping backwards by about 1 second**:
- a principal was recorded at `03:22:33.031Z`;
- a later transaction's time was `03:22:32.040Z`;
- the application-side UUIDv7 ids stayed monotonic.

The bitemporal authority view then treats the just-recorded principal as not yet known, and grant issuance fails with `UNKNOWN_PRINCIPAL`. That is fail-closed, not a wrong authorization.

- This is **not a BRT-05 defect**. BRT-03 time semantics (recordedAt = DB transaction time) assume a monotonic database clock.
- A 2-minute idle probe (1,200 samples of `clock_timestamp()`) found no backward steps, so the steps are sporadic. They are likely VM time-sync corrections under load.
- Real deployments should use slewing time synchronization (no clock steps).
- A monotonic platform clock is deferred.
- If an integration test fails with `UNKNOWN_PRINCIPAL`, `ANCHOR_*` or `*_NOT_VALID_AT_TIME` on this setup, re-run it before suspecting the code.

## BRT-05R · Operator login for catalog mutation

- **New login:** `br_operator_app` (development password `br_operator_app_dev_only`; override with `BR_OPERATOR_PASSWORD`). It may `SET ROLE br_catalog` and nothing else. `br_api` lost `br_catalog`.
- **API:** enables INTERNAL catalog mutation only when `BR_OPERATOR_DATABASE_URL` is set explicitly. Otherwise those endpoints answer `503 INTERNAL_CAPABILITY_UNAVAILABLE`, while `GET /v1/catalog` and all organizer flows keep working on the normal connection.
- **Seeds, demo and testkit:** use `operatorDatabaseUrl()`. It falls back to the local development login outside production only; in production it returns nothing unless configured.

```bash
BR_DEV_AUTH=1 BR_OPERATOR_DATABASE_URL=postgres://br_operator_app:br_operator_app_dev_only@localhost:55432/bragging_rights pnpm dev:api
```

**Clock finding (unchanged).** No slack, backdating or skew exception was added. The authority time semantics of BRT-03 are unchanged, and a backward DB-clock step still fails closed. Monotonic platform time remains deferred.
