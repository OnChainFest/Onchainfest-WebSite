# ONCF-04 — Athlete registration and organizer registration management

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (on top of `bc04928`, ONCF-03B) |
| Builds on | BRT-05 Registration model, lifecycle, commands and capacity/duplicate guards; ONCF-01 auth continuation; ONCF-02/03B organization and tournament areas |
| Out of scope | Team formation and team entry UI, fees, eligibility verification, notifications, field lock / draws |

A registration is the canonical BRT-05 **Registration** (`competition.registration` + status
facts). Nothing here adds a second registration, athlete, team or competition model, a status, a
permission, a migration or an audit path. The three new routes are reads over the same tables.

## 1. Existing domain (unchanged)

- **Statuses:** `REQUESTED → CONFIRMED | WAITLISTED | DECLINED | WITHDRAWN`;
  `WAITLISTED → CONFIRMED | DECLINED | WITHDRAWN`; `CONFIRMED → WITHDRAWN | CANCELLED`.
- **Commands:** `POST /v1/events/:id/registrations` (SELF / confirmed guardian,
  `eligibilityDeclared` required, Idempotency-Key); `POST /v1/registrations/:id/decision`
  (`CONFIRM | WAITLIST | DECLINE | CANCEL`, optional reason, COMP_MANAGE_REGISTRATIONS);
  `POST /v1/registrations/:id/withdraw` (entrant, or staff, then audited `withdrawn-by-organizer`).
- **Rules:** event `REGISTRATION_OPEN` and inside the window (`INVALID_TRANSITION` otherwise);
  entrant kind must match (`INVALID_INPUT`); one active entry per athlete (`ALREADY_EXISTS`, DB
  trigger `BR004`); AUTO_CONFIRM confirms while places last, then waitlists; ORGANIZER_APPROVAL
  stays REQUESTED and a confirmation into a full category is `CAPACITY_REACHED`; waitlist promotion
  on withdrawal; registrations freeze at the field lock.
- **Audit:** `registration.<decision>` and `registration.withdrawn-by-organizer`, plus outbox
  events. Decisions made through the new UI use these same commands.

## 2. API additions (reads only)

| Route | Class | Decided in the store by | Returns |
|---|---|---|---|
| `GET /v1/me/registrations` | AUTHENTICATED | athletes the caller may register (REGISTER_FOR_EVENT: SELF / confirmed guardian) and teams its SELF person manages | `{ items: RegistrationEntry[] }`, newest first, max 200 |
| `GET /v1/registrations/:id` | SELF | entrant control, or COMP_VIEW_PRIVATE on its competition (else 403, audited) | entry + `history[]` (status, reason, time) + `viewer` |
| `GET /v1/competitions/:id/registrations?eventId&status&after&limit` | COMP_STAFF | COMP_VIEW_PRIVATE | `{ items, counts (per status, event filter applied), nextCursor, access }`, entry order, keyset-paged (≤100) |

- **`RegistrationEntry`:** id, status, entrant (athlete id / team), eligibility basis, the current
  status's reason, requested / changed times, event context (name, slug, status, entrant kind,
  sport, discipline, format, capacity, registration mode, close time, dates, timezone),
  competition context, and **`actions`** — `decisions` and `withdraw`.
- **`actions` restate the lifecycle; they grant nothing.** New pure functions in
  `@br/competition` (`availableRegistrationDecisions`, `registrationCanWithdraw`,
  `registrationDecisionsOpen`, `registrationWithdrawable`, `REGISTRATION_DECISIONS`) are now
  also used by `decideRegistration` / `withdrawRegistration`. Decisions are listed only for
  COMP_MANAGE_REGISTRATIONS. Capacity is still decided by the command.
- **Privacy:** an athlete is named (`athlete: { slug, displayName }`) only when ACTIVE with a
  PUBLIC or AUTHENTICATED profile — the ONCF-02 roster rule, via the new
  `IdentityStore.visibleAthletes`. A PRIVATE athlete is `athlete: null`, even to the organizer.
  No account, person or contact data is returned.
- **Public summary:** `PublicEventSummary.entrantKind` (already in `competition_read.event_summary`)
  so the public page can tell team categories apart. Pending and waitlisted entries are still
  never listed publicly.

## 3. Web

| Route | Shown when |
|---|---|
| `/competitions/[slug]` (public) | "Register →" per category whose public status/window is open |
| `/competitions/[slug]/events/[eventSlug]` (public) | Registration panel: open / opens at / closed / not open / field set / in play / completed / cancelled / team |
| `/app/register/[slug]/[eventSlug]` | Category → Participant → Review → Status. Signed-out visitors go through `/signin?next=` (proxy) |
| `/app/registrations` | The caller's entries: Pending, Upcoming, Completed, Other statuses |
| `/app/registrations/[id]` | Persisted result for the entrant: status, organizer note, history, withdraw |
| `/app/orgs/[slug]/tournaments/[competitionId]/registrations` | Console: status counts/filters, category filter, entry rows with the API's decisions |
| `…/registrations/[registrationId]` | Entry detail with history and decisions |

- **Entry point:** the public CTA is a display hint from the public status and window; the
  command re-checks everything.
- **Continuation:** `/app/register/...` is a valid `next`. Unfinished onboarding now *carries*
  a valid `next` (`/app/onboarding?next=…`) instead of dropping it, and creating the athlete profile
  resumes it. A user with no athlete profile is sent to the existing onboarding athlete form with
  `next`. Brand-new accounts keep it too: sign-in → "Create an account" → lane → sign-up form →
  confirmation email (`emailRedirectTo` = `/auth/callback?flow=signup&path=…&next=…`) → landing
  (`successRedirect` re-validates it) → onboarding → registration. Resend keeps it. Only paths that
  pass `validateContinuationRoute` (same-origin `/app/**`) are ever carried; nothing is stored in
  Supabase metadata.
- **Idempotency:** the review renders one key per form; a double submit or resubmission is one
  registration (API replay). Decisions and withdrawals also carry one key per rendered form.
- **Duplicates:** an athlete with an active entry in the category is shown that entry instead of
  a form; the API's `ALREADY_EXISTS` is still mapped.
- **Server actions** (`app/register/actions.ts`,
  `…/[competitionId]/registrations/actions.ts`) follow the ONCF-02/03B pattern: re-verify the
  session (and organization membership), validate ids, call the canonical command, redirect with
  `?error=` / `?notice=`. Hidden fields only state intent.
- **Error mapping** (`registrationErrorCode`): `ALREADY_EXISTS` → `registration_duplicate`;
  `INVALID_TRANSITION` → `registration_closed` (register) / `registration_transition` (decide,
  withdraw); `CAPACITY_REACHED` → `registration_full`; `INVALID_INPUT` → `registration_invalid`;
  `FORBIDDEN` → `registration_not_permitted` / `not_permitted`; `NOT_FOUND` →
  `tournament_not_found` / `registration_not_found`. `eligibility_required` is raised by the web.
- **Visuals:** `rg-*` section of `product.css` (status chips with icons, timeline, ticket cards,
  operations console). Rows become cards under 900px.

## 4. Tests

- **API integration** (`apps/api/src/registration.int.test.ts`, 16): REQUESTED on approval,
  idempotent replay, duplicate refused, registering another's athlete refused; own list and
  context; one registration for entrant/staff and 403 for another athlete / another organization /
  anonymous (401) / unknown (404); staff list naming only visible athletes; list refused to other
  organizations, plain members and athletes; ADMIN admitted; event/status filters and cursor
  paging, bad cursor 400, foreign category 404; confirm, capacity refusal, waitlist, decline with a
  reason the athlete reads, invalid transition, cancel; refusals of decisions by other
  organizations and athletes; AUTO_CONFIRM capacity, waitlist and promotion on withdrawal; window
  (not yet open), DRAFT, closed and team-category refusals; public privacy and `entrantKind`.
- **Unit:** sign-up/email-confirmation continuation (`auth-flows.test.ts`, `auth-pages.test.tsx`); lifecycle windows (`packages/competition/src/registration-windows.test.ts`); web
  (`apps/web/app/_tests/registrations.test.tsx`, 33): CTA states, public pages, continuation,
  registration page states, `registerAction` (body, key, refusals, eligibility, expired session),
  result persistence and 404s, history grouping, withdraw, onboarding continuation, organizer
  console (rows, privacy, server-side filters, status-driven actions, empty states, 404s), detail,
  and every decision command and refusal.

## 5. Scope boundary

**In scope:** individual athlete registration; public registration CTA; authentication
continuation (sign-in, sign-up, email confirmation, onboarding); athlete registration flow,
history and detail; organizer registration list, detail and decisions (confirm, waitlist, decline,
cancel, withdraw); capacity; registration window; duplicate protection; privacy; status-driven UX.

**Out of scope (intentional):** team formation and team registration UI, fees, payment,
notifications, field lock, draws, scheduling, results, rewards, sponsors, $BRT.

## 6. Gaps / follow-ups

- **Team registration (intentional ONCF-04 scope).** The backend supports team creation,
  membership consent and team entry, but there is no team read API (my teams, my pending
  memberships) and no team UI. TEAM categories (all canonical padel categories) show "team entries
  aren't available online yet" on the public page and the registration page, which offers no form.
  An individual entry into a TEAM category is refused by the store (`INVALID_INPUT`, tested).
  No team model or write path was added.
- **Registration mode is not public — deferred.** `registration_mode` exists only in the canonical
  `competition.event_profile` table; `br_public_read` can read only `competition_read.*` and
  `sports.*`, and `competition_read.event_summary` has no such column. Exposing it requires a
  migration. Exact follow-up:
  1. migration `0032`: `ALTER TABLE competition_read.event_summary ADD COLUMN registration_mode text`
     (backfilled by the rebuild; `NOT NULL` + CHECK once rebuilt);
  2. `competition-projection.ts`: add `p.registration_mode` to the `event_summary` INSERT … SELECT;
  3. `competition-reader.ts` / `PublicEventSummary`: `registration.mode`;
  4. run `rebuildCompetitionReadModels` (and the rebuild-identity test);
  5. web: state "Confirmed on entry while places last" vs "The organizer reviews entries" on the
     CTA and review step.

  Until then the athlete UX never claims an immediate confirmation: the review lists the possible
  outcomes, and the result page shows the status the API actually recorded.
- **Token-hash email template.** The continuation rides the PKCE link (`emailRedirectTo`). If the
  Supabase confirmation template links to `/auth/confirm?token_hash=…` without `{{ .RedirectTo }}`,
  `next` is not in that URL; the user lands on onboarding and returns from the public page.
- **Private athletes are unnamed to organizers** (roster rule). Whether entering a competition
  should disclose the athlete's name to its organizer is a product/privacy decision.
- **No tournament directory:** discovery is through the organization's public page.
- **No search** in the console (the API has no name search; private names must not be searchable).
- **No notifications** when an organizer decides.
- **No fee or eligibility verification**: the domain has neither; eligibility is declared.
- **Pre-existing, outside ONCF-04 (intermittent integration failures; code left untouched):**
  - `apps/api/src/cli/demo-rankings.int.test.ts`: "a sporting cutoff cannot be in the future" —
    the rankings demo builds cutoffs as `eff + N minutes` (`demo-rankings.ts:381`) and the ranking
    store refuses cutoffs after `now()`. Time-dependent: failed in isolation once, passed in the
    later full run and in isolation.
  - `packages/persistence/src/verification.int.test.ts` (A-5) and
    `packages/persistence/src/rankings-worker.int.test.ts` (suite setup): `AUTHORITY_DENIED:
    PRINCIPAL_UNKNOWN`, seen only inside the full serial run; both pass in isolation.
