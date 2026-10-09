# ONCF-03A — Tournament backend readiness

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `7fc2b15`) |
| Builds on | Canonical Competition / Event model (BRT-05, migrations `0007`–`0009`), `CompetitionStore`, `CompetitionReader`, `CatalogStore`, ONCF-02 organization area |
| Out of scope | Tournament UI (ONCF-03B), registration management UI, draws, scheduling, results, Sponsor, $BRT |

A tournament is a canonical **Competition**; its categories are **Events**. Nothing here adds a
second competition store, a second catalog or a new lifecycle. No migration was needed.

## 1. Organizer reads (DRAFT included)

| Route | Class | Decided in the store by | Returns |
|---|---|---|---|
| `GET /v1/organizations/:organizationId/competitions/manage` | ORG_ADMIN | `ORG_MANAGE_COMPETITIONS` in that organization (ACTIVE OWNER / ADMIN) | `{ items: [{ id, slug, name, status, startsAt, endsAt, timezone, locationLabel, regionCode, eventCount, cancelledEventCount, createdAt, updatedAt, statusChangedAt }] }`, newest first, max 200 |
| `GET /v1/competitions/:competitionId/manage` | COMP_STAFF | `COMP_VIEW_PRIVATE` on the competition (organizer OWNER / ADMIN, or ACTIVE competition staff) | `competition` (profile, status, `editable`, `nextStatuses`, timestamps), `events[]` (pinned discipline / format versions, entrant kind, format config, settings, counts, `editable`, `nextStatuses`, timestamps), `access` (caller's staff roles and permissions) |

- Both reads live on `CompetitionStore` (`br_competition`), the path that already owns the
  permission helpers. `CompetitionReader` (`br_public_read`) stays public-only and keeps hiding DRAFT.
- **Isolation.** A member of another organization, a plain member, an org STAFF member and a
  stranger all get 403. An unknown organization id also gets 403, so the list is not an existence
  oracle. Denials are audited (`competition.manage-list`, `competition.COMP_VIEW_PRIVATE`).
- **Explicit competition staff** (for example a REGISTRATION_MANAGER) can read the competition
  they staff, but not the organization list.
- **`editable` and `nextStatuses` restate the existing rules; they do not add any.** The edit
  windows are now pure functions in `@br/competition`
  (`competitionProfileEditable`, `competitionAcceptsEvents`, `eventSettingsEditable`,
  `eventCapacityEditable`), and the store's commands use the same functions. `nextStatuses` is
  the lifecycle's transition table. Preconditions still apply on top, for example registration
  can only open on a PUBLISHED or ACTIVE competition. The commands remain the authority.

## 2. Catalog facts (`GET /v1/catalog`, additive)

The response gains these fields:

- **Each discipline version:**
  - `participantKinds` and `lineupSize` (from `spec.participation`);
  - `allowedContestTypes`;
  - `compatibleFormatVersionIds`, computed with the same rule `createEvent` applies: the format's
    contest type must be allowed by the discipline.
- **Each format version:**
  - `contestType`, from the registered engine; `null` when this build has no such engine, and the
    format then fits nothing;
  - `configurationSchema`, as stored on the format version.

A client can therefore offer only valid sport, discipline, format and entrant-kind combinations,
without hard-coding formats or relying on a 400. `createEvent` still rejects invalid combinations.

## 3. Production catalog: decision

**Mechanism:** `pnpm db:catalog:provision --operator-account <uuid> [--dry-run]`. This runs
`CatalogStore.provision(CANONICAL_CATALOG)` over the existing operator login
(`BR_OPERATOR_DATABASE_URL`, `br_operator_app` → `br_catalog`).

**Why this mechanism:**

- **Not a migration.** Catalog rows record the creating account, are append-only, and are
  operator data rather than schema.
- **Not the HTTP INTERNAL routes.** The Supabase adapter never grants the operator flag, so those
  routes are closed in production by design.
- **Not the dev seed.** It refuses production and creates fictional organizations and athletes.

**Behaviour:**

- **Lookup-first and idempotent.** Codes and content hashes are looked up before anything is
  created. An existing sport, discipline or format is reused. A version with the same spec hash
  is reused, and published if it is still DRAFT. Re-running, or running as a different operator,
  converges and never duplicates rows.
- **Fail-safe.**
  - The whole manifest is validated before any write.
  - A discipline or format whose existing versions all differ from the declared spec is reported
    as a **conflict** and left untouched. A new version is a deliberate operator decision.
  - A matching version that is RETIRED is also a conflict.
  - The command exits with code 2 when there are conflicts.
- **Manifest.** `@br/competition` `CANONICAL_CATALOG` contains:
  - padel: `padel.doubles` (TEAM, 2 players per entry);
  - tennis: `tennis.singles` (INDIVIDUAL) and `tennis.doubles` (TEAM, 2 players per entry);
  - formats `single-elimination/1` and `round-robin/1`.

  Every listed discipline has at least one compatible format (unit-tested).
- **Running is a follow-up, not included.** Its spec needs HEAT contests and no HEAT format engine
  exists, so organizers could pick it but never run it. The dev seed keeps `running.5k` as a
  dev-only extra.
- **The dev seed now provisions through the same function.** Dev and production catalogs cannot
  drift. Existing dev databases converge, because the padel and tennis singles specs are unchanged
  and hash-identical.
- **Operator account.** The account must be an existing platform account; the tool never invents
  one. A missing account fails on the first insert with a clear message.

## 4. Slug bound: decision

- **The canonical maximum is 50 characters** (minimum 3). `@br/identity` now exports
  `SLUG_MIN_LENGTH` and `SLUG_MAX_LENGTH`, matching `normalizeSlug` and the database's
  `identity.normalized_slug_ok`. No database limit changed.
- **API.** Every slug being *claimed* in a request body is now bounded at `SLUG_MAX_LENGTH`. This
  covers competition, event, athlete and organization create, slug changes, and invitation
  `athleteSlug`. It was previously 100.
- **Path parameters stay lenient.** A slug in a URL is only a lookup key, so any value that cannot
  be a slug simply misses with a 404, and over-long URLs never turn into a 400.
- **Web.** The ONCF-02 organization actions used a local 1–100 pattern. They now use the single
  `SLUG_RE` (3–50) from `_lib/onboarding-input.ts`.

## 5. Web preparation

`apps/web/app/_lib/tournaments.ts` adds:

- typed shapes for the two organizer reads and the catalog;
- `managedCompetitions(token, organizationId)` and `managedCompetition(token, competitionId)`,
  both through the existing `apiRequest`;
- `tournamentCatalog()`, through the existing public `getPublic`.

There are no screens.

## 6. Tests

- **API integration** (`apps/api/src/competition-manage.int.test.ts`, 13 tests):
  - the owner and an ADMIN list drafts;
  - STAFF, MEMBER, another organization's owner, a stranger and an unknown organization get 403,
    and unauthenticated callers get 401;
  - the draft never appears in a refusal;
  - the public list and public page still hide drafts, and published competitions stay readable;
  - the detail returns the editable form, and its edit windows change after publish and
    registration opens;
  - explicit competition staff can read the detail but not the list;
  - the catalog facts are correct, including running with no compatible format;
  - an incompatible discipline/format pair and a wrong entrant kind are rejected;
  - a 50-character slug is accepted, 51 is refused on create and on slug change, and an 80-character
    lookup returns 404.
- **Persistence integration** (`packages/persistence/src/catalog-provisioning.int.test.ts`, 6 tests):
  - dry run writes nothing;
  - create then re-run is UNCHANGED with no duplicates, even under another operator;
  - a DRAFT match is published;
  - a diverging spec is reported as a conflict;
  - an invalid manifest is refused before any write;
  - the canonical catalog is idempotent.
- **Unit:**
  - manifest validity and compatibility, and the edit-window functions against the lifecycles
    (`packages/competition/src/catalog-manifest.test.ts`);
  - slug min/max boundary (`packages/identity`);
  - web client paths, token use, error pass-through and the uncredentialed catalog
    (`apps/web/app/_lib/tournaments.test.ts`).

## 7. Next: ONCF-03B (organizer Tournament Creation UI)

`/app/orgs/[slug]/tournaments`:

- **List** from `/competitions/manage`, gated on `ORG_MANAGE_COMPETITIONS`.
- **New tournament:** `POST /v1/competitions`.
- **Detail** from `/competitions/:id/manage`:
  - profile edit;
  - add a category with sport, discipline and format pickers driven by
    `compatibleFormatVersionIds` and `participantKinds`;
  - category settings;
  - publish, open registration and cancel, shown according to `editable`, `nextStatuses` and
    `access`.
- Add a Tournaments tab in `org-chrome.tsx`, and include drafts in the dashboard count.
- **Before any production use:** run `db:catalog:provision` in that environment.
