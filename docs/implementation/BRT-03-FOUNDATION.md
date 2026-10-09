# BRT-03 — Executable Foundation

| Field | Value |
|---|---|
| Ticket | BRT-03 |
| Status | Implemented — for review |
| Scope | Technical kernel only: canonicalization and hashing, PostgreSQL primitives, append-only aggregate ledgers, identity/principal/authority kernel, minimal result ledger |
| Contract | BRT-01 domain and BRT-02 architecture (ADR-0001…0020) |

---

## 1. Acceptance statement

The phase acceptance test is:

> We can create principals and authority grants, append immutable result-domain facts, deterministically hash them, evaluate scoped authority, and prove that duplicate or invalid operations are rejected.

**How it is demonstrated:**

- `pnpm demo:foundation` runs acceptance steps 7–17 against the development database.
- The test suites run the same checks automatically: unit and property tests, golden vectors, and database integration tests.

---

## 2. Code → decision map

| Code | Implements | Notes |
|---|---|---|
| `packages/canonical` | ADR-0014; BRT-02 signatures & hashing §2–3 | BR-JSON v1 profile, RFC 8785 serializer, strict JSON parser, preimage `"BR"‖0x01‖tag‖0‖schema@v‖0‖"br-json/1"‖0‖JCS`, plain SHA-256 for evidence bytes |
| `packages/canonical/test-vectors` | ADR-0014 §5 ("golden vectors mandatory") | 58 vectors (36 accept, 22 reject) + equal/distinct hash groups |
| `packages/canonical/reference/check_vectors.py` | BRT-02 §2.2a rule 13 (second implementation) | Independent Python checker; limitations in §5 |
| `packages/domain` | BRT-01 result domain §3–7, verification model §4; ADR-0013; BRT-02 §5.1 | Discriminated unions / const enums, UUIDv7 + TypeID, time model |
| `packages/authority` | ADR-0004, ADR-0020; BRT-01 §4.5; BRT-02 identity & authority §5 | Pure engine. Scope algebra (§3), chain evaluation, issuance validation, proof digest |
| `packages/schemas` | ADR-0014 rule 12 | Versioned closed schemas; registry via `platformCanonicalizer()` |
| `db/migrations/0001_platform.sql` | ADR-0011, ADR-0012; persistence §3.0, §5 | `ledger_entry` (class A), `stream_head` (class B), outbox (class A), consumption receipts, command idempotency, dev job queue |
| `db/migrations/0002_authority.sql` | ADR-0004, ADR-0016, ADR-0020 | Principals, keys (public material only), anchors (PLATFORM-level restriction trigger), grants (no-backdating CHECK), status histories |
| `db/migrations/0003_results.sql` | ADR-0001, ADR-0003; result domain §6–8 | Result identity, immutable versions, transitions T2–T4, drafts, projections, R-2 partial unique index |
| `db/bootstrap/*.sql` | Data access model §2 | Separate logins `br_owner`, `br_api`, `br_worker_app`, `br_maintenance`, `br_probe`; module roles; no PUBLIC access (§6.1) |
| `packages/persistence/src/tx.ts` | Persistence §5.4 | One transaction per command under `SET LOCAL ROLE <module>`; tx time = platform time; bounded retries |
| `packages/persistence/src/ledger.ts` | Persistence §5.2 | Head lock → append → guarded head update; chain verification |
| `packages/persistence/src/projections.ts` | Persistence §3.0 B | Rebuild of result projections from RESULT streams |
| `packages/persistence/src/idempotency.ts` | Persistence §7 | Same key + same request ⇒ replay; different request ⇒ rejected |
| `packages/persistence/src/worker-queue.ts` | ADR-0012 | Outbox consumption receipts, `SKIP LOCKED` job claim |
| `apps/api` | ADR-0010 | `/health`, `/ready` only |
| `apps/worker` | ADR-0010, ADR-0012 | Polling skeleton |
| `apps/web` | ADR-0010 | Placeholder; calls the API only |

---

## 3. Scope algebra (normative for BRT-03)

The implementation is `packages/authority/src/scope.ts`.

- **Representation.** A scope maps dimensions to **non-empty sets**. The dimensions are `sport`, `discipline`, `region`, `recognitionLevel`, `competition`, `event`, `round` and `contest`.
- **Absent dimension.** It is unconstrained: it matches everything.
- **Empty set.** It is not representable. Schemas enforce `minItems: 1` *before* BR-JSON pruning, so `[]` can never silently become "unconstrained". An integration test covers this.
- **Value coverage `covers(d, a, b)`:**

| Dimension | Rule |
|---|---|
| `discipline` | `x.*` covers `x`, `x.*` and every `x.…`; an exact id covers only itself |
| `region` | a country (`CR`) covers itself and its subdivisions (`CR-…`); a subdivision covers only itself |
| all others | equality |

- **Containment.** `contains(A, B)` holds when every dimension constrained in `A` is constrained in `B`, and every value of `B[d]` is covered by some value of `A[d]`.
- **No hierarchy inference.** A scope constraining `event` does not imply its `competition`. Grants state the ancestors they rely on; requests are resolved to their full path by the caller.
- **Anti-widening.** A child grant's scope must be contained in its parent's scope. This is enforced at issuance **and** re-checked at every evaluation (chain re-walk).
- **Property tests** cover:
  - reflexivity;
  - transitivity, both constructive and as an implication over random triples;
  - narrowing stays contained;
  - a stored escaping child never authorizes.

---

## 4. Authority engine behaviour

`authorize(facts, request)` returns an explainable decision:

```
{ authorized, reason, anchorId?, grantChain[leaf→root], conflictCheck, conflictCheckerId, candidateFailures[], evaluatedAt, atTime, asOf, engineVersion, proofDigest }
```

**Evaluation order:**

1. principal visible at `asOf`;
2. key checks (if `keyId`);
3. conflict-of-interest hook;
4. candidate grants held by the principal for the capability, ordered by id;
5. for each candidate, a chain walk leaf → root checking at T:
   - validity window;
   - revocations as known at `asOf`;
   - `GRANT_AUTHORITY` and delegation allowed on every parent;
   - capability delegable at every hop;
   - hop count ≤ each ancestor's `maxDepth`;
   - scope narrowing at every hop;
6. the root grantor must hold a trust anchor valid at T, not revoked, whose recognition scope contains the root grant scope. The PLATFORM principal may only anchor the PLATFORM level, and no other principal may claim it.

**Proof digest.** `proofDigest = H("authorization-proof", br:authorization-proof@1, …)` covers:

- the request (principal, key, capability, scope, `atTime`, `asOf`);
- the outcome;
- the grant chain (ids + grant hashes), the anchor (id + fact hash), the key (id + fact hash);
- the status-change facts that were visible;
- the conflict status, the conflict checker id and the engine version (`brt-03/2`).

`evaluatedAt` is excluded, so identical facts give identical digests (tested).

**Temporal authority** (BRT-02 §5.1):

| Rule | Implementation |
|---|---|
| Online authority at platform-observed time | Commands use `txTime` (DB transaction time, ms) as `issuedAt` / `atTime` |
| `signedAt` alone never establishes authority | `signedAt` only *tightens* compromise checks |
| No retroactive authority (strict) | `effectiveFrom ≥ recordedAt` exactly — **no clock-skew tolerance** — in `validateGrantIssuance` (`BACKDATED`), in `assertNotBackdated`, and in DB CHECKs `effective_from >= recorded_at`, for grants, keys and anchors. `recordedAt` is the DB transaction time. Equal is accepted, later (scheduled) is accepted, 1 ms earlier is rejected (boundary-tested at DB time). |
| Ordinary revocation/rotation is prospective | Same strict rule (app + DB CHECK). Compromise is the only retroactive fact (`effective_from ≤ recorded_at`). |
| Clock-skew tolerance | `SIGNER_CLOCK_SKEW_MS` exists only for externally supplied signer/device timestamps (`signedAt`); it is never applied to authority effective time. Offline-device timestamps are not authority facts and never backdate authority. |
| Compromise is retroactive | `compromisedSince ≤ recorded_at` allowed; SUSPECT if `signedAt ≥ t₀` **or** `issuedAt ≥ t₀` |
| `atTime` vs `asOf` | `atTime` = effective time; `asOf` = transaction-time horizon (facts with `recordedAt ≤ asOf`). Tests cover "as known then" vs "as known now". |
| `recordedAt` cannot be forged | Trigger `platform.assert_recorded_at()` requires `recorded_at = date_trunc('ms', now())` |
| Offline certified devices | Type placeholder `OfflineCaptureClaim` only; **not honoured** by the engine yet |

**Conflict of interest is fail-closed** (BRT-03R).

- **Conflict-sensitive capabilities:** every capability except `SUBMIT_RESULT`. That includes `ACCEPT_RESULT`, `DECLARE_OFFICIAL`, `ATTEST_*`, `RATIFY_RECORD`, `ADJUDICATE_DISPUTE`, `SANCTION`, `ASSESS_EVIDENCE` and `GRANT_AUTHORITY`.
- **Exempt:** `SUBMIT_RESULT` only. Participants may submit claims about their own contests (BRT-01 submission policy). A submission confers no trust by itself (V0) and still needs independent acceptance.
- **Sensitive capabilities are authorized only when the checker answers `CLEAR`.**

  | Checker answer | Decision |
  |---|---|
  | `CONFLICTED` | `CONFLICT_OF_INTEREST` |
  | `UNAVAILABLE` | `CONFLICT_CHECK_UNAVAILABLE` |
  | No checker supplied | `CONFLICT_CHECK_UNAVAILABLE` |
  | Checker throws | `CONFLICT_CHECK_UNAVAILABLE` |
  | Unrecognized answer | `CONFLICT_CHECK_UNAVAILABLE` |

  The chain found is still reported, so the denial is explainable.
- **Grant issuance** (exercising `GRANT_AUTHORITY`) applies the same rule to the grantor: `GRANTOR_CONFLICTED` or `CONFLICT_CHECK_UNAVAILABLE`.
- **Recorded in every proof:** `conflictCheck` and `conflictCheckerId`.
- **Default checker.** The default `participationIndexUnavailable` makes every conflict-sensitive action fail closed. That is why `AuthorityStore` and `ResultLedger` accept an explicit checker.
- **`staticParticipationChecker(declarations, id)`** answers from an explicitly declared participation list. It is used by tests (`declaredNoParticipation`) and by the demo (`demo-declared-participation`), and it is **not** the production participation index. The real index is a BRT-04+ prerequisite for production authority actions.

---

## 5. Canonicalization and golden vectors

- **Rules and error codes.** The rule-by-rule error codes (`BRJ_*`) are part of the protocol surface.
- **Two vector files.** `br-json-v1.source.json` holds hand-authored inputs and expected normalized values (the human expectation). `br-json-v1.vectors.json` is generated: it adds canonical text and hashes.
  - `pnpm vectors:generate` regenerates it after checking every expectation.
  - `pnpm vectors:check` fails if the committed file differs from what the implementation produces, then runs the reference checker.
- **Vector coverage:**
  - property order;
  - NFC-equivalent Unicode;
  - ordered vs set arrays and set duplicates (element and key);
  - decimals `1` / `1.0` / `1.00` / negative / `-0` / `+01.50`;
  - Mark precision;
  - timestamp offsets, rollover and precision rejection;
  - UUID case and forms;
  - absent vs null vs default vs empty collection;
  - integer spellings and range;
  - unknown fields;
  - JCS escaping;
  - domain-tag and schema-version separation.
- **Reference checker** (`reference/check_vectors.py`). It uses only the Python standard library and shares no code with the TypeScript implementation. It independently re-derives JCS text (UTF-16 key sort, escaping) and the domain-separated SHA-256 for every accepted vector, and checks BR-JSON invariants on the normalized values.
- **Reference checker limitations:**
  - it does **not** re-implement input → normalized normalization; that mapping is guarded by the hand-authored expectations;
  - it does not interpret schemas (constraints, set sort keys);
  - it covers only the golden vectors.

  A full second implementation remains future work (for example for federation verifiers).

---

## 6. Persistence model as built

| Class | Tables | Runtime privileges |
|---|---|---|
| A — ledger / history (truth) | `platform.ledger_entry`, `platform.outbox_event`, `platform.outbox_consumption`, `platform.command_idempotency`, all `authority.*`, `results.result`, `results.result_version`, `results.result_status_transition` | INSERT + SELECT only; triggers reject UPDATE/DELETE/TRUNCATE even for the owner |
| B — projections | `platform.stream_head`, `results.result_state`, `results.result_version_state` | INSERT/UPDATE by the owning module; full rewrite by `br_rebuild` |
| Operational | `results.result_draft`, `platform.job` | Owning module |

**Hash-chain streams in use:** `RESULT` (result id), `PRINCIPAL_KEY`, `AUTHORITY_GRANT` and `TRUST_ANCHOR`.

- `ledger_entry` has `UNIQUE (stream_id, sequence)`, `UNIQUE (entry_hash)` and `UNIQUE (fact_table, fact_row_id)`.
- There is **no global chain**.
- `verifyStreamChain` recomputes every entry hash and link and compares the result with the head.

### 6.1 Login → module-role graph (BRT-03R)

```
br_owner        LOGIN            migrations/DDL only · member of nothing · no runtime login is a member of it
br_api          LOGIN NOINHERIT  ──SET──▶ br_authority, br_results        (request processing)
br_worker_app   LOGIN NOINHERIT  ──SET──▶ br_worker                       (outbox consumption, job queue)
br_maintenance  LOGIN NOINHERIT  ──SET──▶ br_rebuild                      (projection rebuild only)
br_probe        LOGIN NOINHERIT  (nothing)                                (dev/test: proves unprivileged access fails)
```

- **Memberships** use `INHERIT FALSE, SET TRUE, ADMIN FALSE`.
  - A login holds no module privileges until `SET LOCAL ROLE`.
  - It can switch only to its own module roles.
  - It can never grant roles.
- **Direct grants to logins:** only `SELECT` on `br_migrations.applied`, to `br_api` and `br_worker_app`, for readiness probes.
- **Convergence.** Bootstrap is convergent: it revokes memberships outside the graph and retires the pre-BRT-03R `br_runtime` login (NOLOGIN, no memberships).
- **Tests prove all of the following:**
  - the exact membership graph;
  - `br_api` cannot become `br_rebuild`, `br_worker` or `br_owner`, and cannot use worker-only tables;
  - the worker cannot write domain tables or rebuild;
  - maintenance can only rewrite projections;
  - runtime logins cannot run DDL or disable triggers;
  - `br_probe` reads nothing.

### 6.2 Outbox delivery semantics (stated precisely)

- **Delivery is at least once.** A failing handler rolls back its receipt, and the event is redelivered (tested).
- **Exactly-once committed database effects**, but only for effects the handler writes in the same PostgreSQL transaction as its `outbox_consumption` receipt. The receipt's primary key makes concurrent consumers block, then skip (tested with 4 concurrent consumers).
- **No exactly-once guarantee for external side effects.** Handlers must be idempotent. Future external integrations need their own idempotency key, transactional boundary or delivery protocol.

### 6.3 Idempotency under concurrency

- **Serialization.** `checkIdempotency` takes a transaction-scoped advisory lock on (scope, key) *before any write*, so concurrent same-key commands run one after another. Later ones replay the committed response or fail with `IDEMPOTENCY_KEY_REUSED`.
- **Database safety net.** The primary key on `platform.command_idempotency`. Natural-key races (`grant_hash`, result scope target) are retried and resolve to the committed row.
- **Tests:**
  - 20 concurrent identical grant and submit commands produce one effect, one record and identical results;
  - concurrent conflicting requests produce exactly one winner, and the losers get `IDEMPOTENCY_KEY_REUSED` with no surviving effects.

---

## 7. Deviations and refinements relative to BRT-02 (none change an ADR decision)

| # | BRT-02 text | BRT-03 implementation | Why |
|---|---|---|---|
| D-1 | Job queue "e.g. pg-boss / Graphile Worker" | A minimal `platform.job` table with `FOR UPDATE SKIP LOCKED` | No real jobs yet; avoids a dependency. Revisit when background work exists. |
| D-2 | Migrations "e.g. dbmate / node-pg-migrate" | Minimal in-repo runner: advisory lock, per-file transaction, checksum immutability | Plain SQL as required; fewer dependencies |
| D-3 | Schemas "e.g. TypeBox" | JSON Schema subset written as typed TS literals, validated by Ajv 2020 | BR-JSON needs `x-br-*` annotations and schema lint; TypeBox adds nothing yet |
| D-4 | `result.current_version_id` on the result row | `results.result` is pure class A; the pointer lives in the `results.result_state` projection | Keeps class A rows fully immutable (persistence §3.0) |
| D-5 | `outbox_event.dispatched_at` bookkeeping | Append-only `outbox_consumption(consumer, event_id)` receipts | Keeps the outbox class A. Semantics are in §6.2: at-least-once delivery, exactly-once committed **database** effects only |
| D-6 | Ledger `factHash` | Column named `payload_hash` (BRT-03 brief); same meaning | Naming only |
| D-7 | New domain tags | `ledger-fact`, `trust-anchor`, `authorization-proof`, `command-request`, `key-material` | The BRT-02 registry is explicitly extensible |
| D-8 | No-backdating stated for grants | Applied strictly (no skew) to grants, key validity, anchor recognition and ordinary revocations | Same anti-backdating rationale (BRT-02 §5.1 rules 3–4) |
| D-9 | Grant issuance authenticated by signature envelope | The actor must equal the grantor; the envelope is stored as a structural placeholder | Signature verification is BRT-04 scope |
| D-10 | Identity (Person, Account, WalletLink) and trust (Evidence, Attestation, Verification) schemas | Not created | Not needed for the kernel; refs are types only |
| D-11 | Toolchain | TypeScript 6.0.3 (TS 7 is not yet supported by typescript-eslint); pnpm 10.34.5; Node 22 LTS with CI also on 24 | Compatibility and reproducibility |

No contradiction with an accepted ADR was found.

---

## 8. Known limitations (intentional)

- No signature verification, no WebAuthn, no wallets.
- No attestations, evidence, verification engine, disputes, corrections (T5–T8), achievements or records.
- There is no participation index. Conflict-sensitive actions fail closed unless a caller supplies a checker with declared participation data.
- There is no hierarchy resolver for scopes.
- There is no anchoring to an external medium; chains are verifiable locally only.
- The worker has no real consumers.
- Result content uses a generic sport-neutral schema. Discipline `components` arrive with the Sports Catalog.
