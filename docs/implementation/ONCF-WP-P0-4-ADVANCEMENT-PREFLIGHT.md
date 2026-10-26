# WP-P0-4 — Advancement preflight (D-13 prevention)

## Decision Q2: prevention and the conditional default

Authorized decision: refuse a new scored field lock unless scoring is pinned and every dependent
slot or dynamic round has a compatible pinned advancement policy. Keep ADR-0065's freeze: no repair,
re-pin or mutation of an existing locked event. Legacy-event repair remains a separate decision.

The rule reads the pinned engine, discipline capabilities and format configuration, then generates
an ephemeral plan with synthetic participant references at the confirmed entrant count. It inspects
slot sources and dynamic rounds; the plan is never persisted. Independent formats and the two-player
single-final case do not require an advancement policy. They still require scoring for scored v2
categories, since that axis becomes immutable at lock too.

The single-elimination v2 engine explicitly opts into an `official-confirmed` organizer suggestion.
The suggestion additionally requires a dependent plan, the discipline's SETS_OF_GAMES capability,
a published compatible policy, OFFICIAL inputs and CONFIRM commits. No other engine opts in. There
is no sport-code switch, universal default, automatic server pin or change to historical plan/spec
hashes. A fresh four-player tennis singles category of capacity four receives the suggestion; a
two-player final does not. The organizer saves it with the scoring form. An existing explicit None
is never silently replaced. Requirements are rechecked at lock even if the field size has changed.

Historical v1 disciplines cannot pin executable scoring (ONCF-05C, confirmed by the existing 05D
v1 regression). Their structure-only path remains unchanged. This is not a claim that v1 events can
complete the scored tournament journey. New scored organizer journeys use v2 capabilities.

## Compatibility and transaction boundary

Compatibility follows generated source/transition semantics, never policy display names:

- best-ranked cross-group slots require a cross-group order;
- cross-group order is incompatible with an ungrouped knockout;
- qualification by heat place requires PLACE_THEN_TIME;
- existing pin-time checks still require cross-group values to exist in the classification template.

Policies with identical applicable semantics remain compatible even if their names differ.

`lockField` retains idempotency replay first, then acquires the existing sorted event-capacity and
event-structure advisory locks, checks permission/lifecycle, reads the confirmed registrations and
runs preflight before inserting participants or field facts. `pinScoring` uses the same structure
lock and refuses incompatible policies. A pin racing a lock therefore serializes; no check-then-act
window is added. Refused transactions leave no field, participant, lifecycle or outbox facts.

Readiness exposes blockers, compatible policy version ids and the conditional default. Before a
viable field exists it can inspect a feasible candidate size for setup guidance; this is advisory.
A locking caller always supplies its exact confirmed count and cannot use that fallback. Locked
readiness uses the frozen participant count. The web consumes the server assessment, filters choices,
explains refusals and withholds the lock command while blocked. No additional transition table is
maintained in the web.

## Acceptance coverage (written; not executed locally)

- Pure tests: 2/3/4-player elimination boundaries, no universal default, policy-free round robin and
  direct swimming final, cross-group compatibility and heat qualification semantics.
- API/database integration: missing scoring, missing policy, incompatible pin, atomic refusal,
  preserved two-player final, idempotent retry/replay, immutable scoring after lock.
- Deterministic advisory-lock barriers: pin first and lock first; database read-back proves exactly
  four participants and one field. CI qualification requests 50 repetitions of each order.
- Synthetic tennis journey through real API handlers and PostgreSQL: create/publish/activate,
  register four athletes, close, pin/lock/seed/generate, publish court schedules, play semifinals,
  submit/accept/declare official, confirm advancement, play final, complete category and tournament,
  read public official standings/podium, and verify results freeze.
- Organizer SSR tests: readiness explanations, filtered policy select, approved fresh default and
  preservation of a saved None. This is API lifecycle acceptance plus SSR coverage, not a browser
  login or hosted identity-provider end-to-end claim.
- Existing v2 structure/scheduling tests now explicitly configure synthetic scoring/advancement
  through the testkit fixture. Product code never calls that helper.

## CI-only qualification and deployment assessment

Assessed base: `e128cb32a5ba25687dfe8481b55a380fb418ba3f`.
Branch: `fix/oncf-wp-p0-4-advancement-preflight`.

No local tests, builds, migrations, servers, hosted-resource changes or CI runs were performed.
Formatting is a source edit only. Validation results remain pending GitHub Actions.

After separate authorization, push only this feature branch (explicit refspec, never main):

1. Existing `ci` foundation runs on Node 22 and 24: format, lint/guards, types, unit/property tests,
   vectors, disposable database bootstrap/migrations, full integration, walkthroughs and web build.
2. Existing `containers` builds API/worker images and proves fail-closed startup, without publishing.
3. `ci / D-13 acceptance and regression proof` runs unit/SSR/deployment guards and the API acceptance
   with 50 races per order. It then replaces only the lock implementation in the disposable runner
   with the assessed base version. The identical refusal test must fail specifically because the old
   lock returns 200 where 409 is required; missing imports/infrastructure failures do not qualify.
4. Review complete green checks and the expected-red proof before requesting PR creation approval.
   No manual migration or deployment workflow is dispatched. Push authorization is not merge approval.

Deployment paths reviewed:

| Workflow | Feature push | PR from this exact branch | Existing production behavior |
| --- | --- | --- | --- |
| vercel-deploy | push trigger restricted to main | preview job excluded by exact head branch; production job false | production block unchanged |
| legal-hub | push restricted to main and legal paths | no changed path matches its legal/path allowlist | unchanged |
| legal-hub-deploy | no legal-hub build completion is produced | no upstream legal build is triggered | protected environment/trust-boundary controls unchanged |
| db-migrate | manual dispatch only | manual dispatch only | unchanged |
| ci / containers | disposable qualification | disposable qualification | no deploy steps |

`vercel.json` still disables Vercel Git integration. No legal path is changed. The dedicated unit
regression reads and evaluates the actual website job guards for this branch's push and PR contexts,
and asserts that other preview branches and the production condition still work. This is repository
source evidence, not inspection of external provider settings. Branch renaming or adding legal files
requires a fresh assessment before PR creation. The branch-specific exception does not globally
disable previews and leaves every production safeguard intact.

## Rollback and release limits

Revert this change; no migration or data repair is involved. Existing locked events remain as they
are. D-16/PR #42 and its Q3 residual (#41), other QA findings and hosted runtime qualification remain
separate release gates. This delivery alone does not authorize an official tournament launch.

## Changed-file inventory

- `.github/workflows/ci.yml`
- `.github/workflows/vercel-deploy.yml`
- `apps/api/src/oncf-p0-4.int.test.ts`
- `apps/api/src/oncf05b.int.test.ts`
- `apps/api/src/oncf05c.int.test.ts`
- `apps/api/src/oncf05e-b.int.test.ts`
- `apps/api/src/oncf05e-c.int.test.ts`
- `apps/api/src/oncf05e-e.int.test.ts`
- `apps/api/src/oncf05e-f.int.test.ts`
- `apps/api/src/v1.ts`
- `apps/web/app/_lib/structure.ts`
- `apps/web/app/_tests/structure-teams.test.tsx`
- `apps/web/app/app/orgs/[slug]/tournaments/[competitionId]/categories/[eventId]/structure/page.tsx`
- `docs/implementation/ONCF-WP-P0-4-ADVANCEMENT-PREFLIGHT.md`
- `packages/competition/src/advancement/preflight.test.ts`
- `packages/competition/src/advancement/preflight.ts`
- `packages/competition/src/format/engine.ts`
- `packages/competition/src/format/engines-v2.ts`
- `packages/competition/src/index.ts`
- `packages/persistence/src/advancement-preflight.ts`
- `packages/persistence/src/competition-structure-store.ts`
- `packages/persistence/src/oncf05b.int.test.ts`
- `packages/persistence/src/oncf05c.int.test.ts`
- `packages/persistence/src/oncf05e-b.int.test.ts`
- `packages/persistence/src/oncf05e-c.int.test.ts`
- `packages/persistence/src/oncf05e-e.int.test.ts`
- `packages/persistence/src/oncf05e-f.int.test.ts`
- `packages/persistence/src/oncf05e-h1.int.test.ts`
- `packages/persistence/src/oncf05e-h2.int.test.ts`
- `packages/persistence/src/oncf05e-r1.int.test.ts`
- `packages/persistence/src/scoring-store.ts`
- `packages/testkit/src/advancement-fixture.ts`
- `packages/testkit/src/index.ts`
- `tooling/d13-deployment.test.ts`

## D-13B — post-merge correction (after PR #43)

A read-only review of the merged implementation confirmed three gaps; this section records their
correction. No migration, no historical plan/spec hash change and no new lock or transaction step.

1. **Ranking dependency (P1).** `advancementRequirements` now derives `classificationStages` from
   the ephemeral plan: the stage of every `RANK_FROM_STAGE` / `BEST_RANKED_FROM_STAGE` slot and the
   source stage of every transition (group crossover, heat qualifiers, cuts). For each, the
   preflight resolves the effective template (stage override, else the event template) and the
   effective ruleset, and blocks the lock with `CLASSIFICATION_TEMPLATE_REQUIRED` when none is
   pinned, or `CLASSIFICATION_TEMPLATE_INCOMPATIBLE` when the template family does not fit that
   ruleset or a best-ranked stage's standings lack a value the pinned cross-group order compares.
   A direct knockout ranks no stage and needs no template.
2. **Retired pins (P2).** The pinned advancement policy version is read by id and checked for
   compatibility whatever its current catalog status. Published-only filtering still applies to
   the compatible list, the suggestion and `pinScoring` (a retired version cannot be newly chosen).
3. **Exact entrant count (P2).** The preflight takes an explicit count basis. Field lock and locked
   readiness pass the authoritative count; readiness of a `REGISTRATION_CLOSED` event uses the exact
   confirmed count with no substitute; only earlier states and pin-time suggestions use the
   estimate (and the feasible-size fallback). Readiness reports `countBasis`, the lock refuses
   anything but `EXACT`, and the organizer page shows the lock command only for an `EXACT`, blocker-
   free assessment (absent or estimated assessments keep it withheld).

The testkit fixture also provisions a classification template when a ranked stage has none, so the
older v2 structure tests stay operable; existing pins and policies are preserved.

Coverage (written; CI-only): pure stage derivation (knockout, groups, best-ranked, heats, cut); API
refusal without a template and acceptance via a stage override; a stage override whose standings
cannot feed the cross-group order refused although the event template could; pin → retire → lock
accepted while a new selection of the retired version is refused; closed registration below the
format minimum reports `EXACT` and `ADVANCEMENT_PLAN_INVALID` (before close: `ESTIMATE`); three
confirmed entrants in an explicit two-player draw (`drawSize: 2`) report `ADVANCEMENT_PLAN_INVALID`
at the exact count instead of a feasible substitute, and the lock refuses the same; SSR lock
withholding for estimated, unassessed and template-blocked readiness.
