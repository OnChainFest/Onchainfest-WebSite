# ONCF-03B — Organizer Tournament Builder

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (on top of `721a38b`, ONCF-03A) |
| Builds on | ONCF-03A organizer reads, catalog facts and edit-window functions; the ONCF-02 organization area |
| Out of scope | Registration management, draws, scheduling, results, staff assignment, public page restyle, Sponsor, $BRT |

The web app only: no API, store, migration or catalog change. A tournament is still a canonical
**Competition** and a category an **Event**. Every rule stays in the competition store; the UI
renders what `GET /v1/competitions/:id/manage` reports.

## Flow

Organization → **Tournaments** tab → **Create tournament** (identity, created as DRAFT) →
**Builder** (categories, configuration, review checklist) → **Publish**.

| Route | Reads | Shown when |
|---|---|---|
| `/app/orgs/[slug]/tournaments` | `GET /v1/organizations/:id/competitions/manage` | `ORG_MANAGE_COMPETITIONS` (else 404) |
| `…/tournaments/new` | — | `ORG_MANAGE_COMPETITIONS` (else 404) |
| `…/tournaments/[competitionId]` | `GET /v1/competitions/:id/manage` | API grants `COMP_VIEW_PRIVATE` and the competition belongs to this organization (else 404) |
| `…/[competitionId]/edit` | same | form only while `editable.profile` and `COMP_EDIT`; read-only otherwise |
| `…/[competitionId]/categories/new` | same + `GET /v1/catalog` | `editable.addEvents` and `COMP_EDIT` (else back to the builder with `tournament_transition`) |
| `…/[competitionId]/categories/[eventId]` | same | settings form while `editable.settings`; capacity and entry mode only while `editable.capacityAndRegistrationMode` |

The dashboard's tournament count and list use the managed list for organizers, so drafts are
included. Everyone else keeps the public list.

## Server actions (`tournaments/actions.ts`)

All of them follow the ONCF-02 pattern: re-verify the session, resolve the caller's membership,
call the canonical route, then redirect with `?error=` / `?notice=`. The shared helpers (`context`,
`errorCode`, `to`, `field`) moved unchanged into `app/orgs/[slug]/action-support.ts`, because a
`'use server'` module can only export actions. `errorCode()` gained a `tournament` scope.

| Action | API |
|---|---|
| `createTournamentAction` | `POST /v1/competitions` (Idempotency-Key) |
| `updateTournamentAction` | `PUT /v1/competitions/:id/profile`, then `PUT …/slug` only when the address changed |
| `tournamentTransitionAction` | `POST /v1/competitions/:id/{publish,activate,complete,cancel}`; cancel requires a reason |
| `addCategoryAction` | `POST /v1/competitions/:id/events` (Idempotency-Key) |
| `updateCategoryAction` | `PUT /v1/events/:id/settings` |
| `categoryTransitionAction` | `POST /v1/events/:id/{open-registration,close-registration,cancel}`; cancel requires a reason |

- **Settings are a whole-object PUT.** `updateCategoryAction` therefore reads the stored event first.
  - While capacity and entry mode are frozen, it resends the stored values, so a tampered form
    cannot trigger the store's `INVALID_TRANSITION`.
  - Labels this builder doesn't edit (weight class, classification) are kept.
- **Dates.** They are entered as wall-clock time in the tournament's (or category's) timezone and
  sent as UTC instants. The API accepts only explicit offsets.

### Error mapping (tournament scope)

| API code | Message code |
|---|---|
| `SLUG_TAKEN` | `tournament_address_taken` |
| `SLUG_INVALID` | `profile_address_invalid` |
| `INVALID_TRANSITION` | `tournament_transition` |
| `INVALID_INPUT` | `tournament_invalid` |
| `NOT_FOUND` | `tournament_not_found` |
| `FORBIDDEN` / 403 | `not_permitted` |

Two codes are raised by the web app itself, never by the API:
- `catalog_combination`: the submitted combination is not in the catalog;
- `reason_required`: a cancellation was sent without a reason.

## Lifecycle

**Buttons are `nextStatuses` intersected with the caller's competition permissions**
(`offeredTransitions`).

- **Competition:**
  - `PUBLISHED` → publish (`COMP_PUBLISH`);
  - `ACTIVE` → activate (`COMP_EDIT`);
  - `COMPLETED` → complete (`COMP_EDIT`);
  - `CANCELLED` → cancel (`COMP_CANCEL`).
- **Category:** open registration, close registration and cancel only.
  - `FIELD_LOCKED`, `IN_PROGRESS` and `COMPLETED` belong to competition operations, so they are
    not offered even when advertised.
- **No transition table exists in the web app.** The status track is a display of the usual path.

## Catalog

- **Sport → Discipline → Entrants → Format.**
  - A format is offered only if the discipline lists it in `compatibleFormatVersionIds` and it has
    a `contestType` (an engine exists in this build).
  - Entrant kinds come from `participantKinds`, with labels from `lineupSize`.
  - Sports with no runnable discipline are hidden.
  - The action re-checks the combination with the same `validCombination` before calling the API.
- **Format configuration.** `configurationSchema` is read generically: flat boolean, integer,
  enum and string properties get controls; nested schemas are reported as unsupported. Both
  canonical formats declare no properties, so categories are created with `formatConfig: {}`, the
  canonical empty configuration.

## Tests

`apps/web/app/_tests/tournaments.test.tsx` has 38 tests. They cover:
- tab gating and 404s for non-managers and foreign tournaments;
- the hub, its empty state and draft visibility, and the dashboard;
- create, with its body, instants, generated address and error mapping;
- the builder: categories, review, and lifecycle buttons per status and per permission;
- profile edit, slug change, frozen profile, and cancellation reason;
- catalog filtering and incompatible-combination refusal;
- format configuration parsing and timezone conversion;
- category settings, including frozen capacity and label preservation, and category transitions.

`org-admin.test.tsx`: the dashboard test now stubs the managed list.

## Before production use

Run `pnpm db:catalog:provision` in the target environment (ONCF-03A §3). Without it, the category
builder has no sports to offer and says so.
