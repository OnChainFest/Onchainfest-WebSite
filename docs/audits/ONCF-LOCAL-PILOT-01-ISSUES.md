# ONCF-LOCAL-PILOT-01 · Issue inventory

Found while playing a complete four-player singles tennis tournament through the web application on
the isolated local pilot (2026-10-27, main `eef289d`). D-P1 is fixed separately (branch
`fix/oncf-dp1-proxy-public-origin`). The items below are recorded only; none is fixed here.

| ID | Severity | Area | Summary | Workaround used in the pilot |
| --- | --- | --- | --- | --- |
| D-P2 | S3 | Web onboarding / validation | Athlete onboarding "Primary sport" suggests free text ("Padel, tennis, running…") but the API accepts only lowercase sport ids; `Tennis` is rejected and the user sees only the generic "Check the highlighted details". | Enter `tennis` |
| D-P3 | P3 | Result integrity hygiene | A result submission refused by the result-authority gate still persists the per-contest result identity and a result draft. | None needed |
| D-P4 | S4 | Public results presentation | Public official results show raw metrics (`gamesWon 12, setsWon 2, …`) instead of the tennis score (`6-4 6-3`). | None |
| D-P5 | S4 | Auth operations | The sign-up limiter (5 per IP per hour, in memory per web instance) blocks a group signing up from one address (one office, one event desk, the local pilot). | Restart of the pilot `web` container |

## D-P2 · Sport field accepts display names in the form, ids in the API

- **Observed:** `apps/web/app/app/onboarding/page.tsx` renders a free-text `sport` input whose
  placeholder is "Padel, tennis, running…"; `createAthleteProfileAction` sends it as
  `preferredSports: [sport]`; the identity store requires `^[a-z0-9]+(?:[-_][a-z0-9]+)*$` and answers
  400, mapped to `profile_invalid`.
- **Expected:** the form offers catalog sports (or normalizes the input) and explains a rejection.
- **Impact:** every athlete who types a capitalized sport fails onboarding with no actionable message.

## D-P3 · Refused submission leaves a draft behind

- **Observed:** after a scorer's competition role was ended and restored, a submit with the
  now-stale grant was correctly refused (`AUTHORITY_DENIED`, "a fresh operator grant is required")
  and no result version, status transition or public effect was produced. However the submit path
  had already committed, in separate transactions before the authority check, the contest's result
  identity and one result draft per attempt (one from the API, one from the UI).
- **Where:** `packages/persistence/src/contest-results.ts`, `submit()` (result identity and
  `saveDraft` precede `submitDraft`, which performs the authority gate).
- **Expected:** a caller without current result authority leaves no persisted state; authorize (or at
  least gate) before persisting the draft.
- **Impact:** low. Drafts are not visible or attestable and the result identity is idempotent per
  contest, but a staff member without valid authority can cause repeated writes. A caller without a
  staff role is refused earlier (403 `FORBIDDEN`) and writes nothing.

## D-P4 · Score rendered as metrics on public pages

- **Observed:** `/competitions/<slug>/events/<event>` lists "win (gamesLost 7, gamesWon 12, setsLost
  0, setsWon 2)"; the set scores themselves are not shown.
- **Expected:** the sport's own notation (6-4 6-3; 7-6(5) for tie-breaks).

## D-P5 · Sign-up limiter keyed only by client IP

- **Observed:** the sixth sign-up within an hour from one IP returns `rate_limited`
  (`apps/web/app/_lib/auth/rate-limit.ts`, rule `signup` 5/h). The limiter is in memory per web
  instance (documented), so a restart clears it.
- **Expected for pilots:** a documented limit sized for a registration desk, or a key that does not
  lump a whole venue together; the per-instance memory remains a known limitation before scale.

## Also observed (already known)

- Refused result attempts are not audited (D-11).
- The public schedule shows no court (QA-01).
- Public "explorer" pages are intentionally unstyled (`(explorer)/layout.tsx`).
