# ONCF-01 — Authentication and onboarding UX in `apps/web`

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local; not pushed) |
| Decisions | [ADR-0052](../adr/ADR-0052-supabase-auth-is-the-identity-provider-behind-the-auth-adapter.md) |
| Builds on | [PR #7 migration plan](./ONCF-01-PR7-TO-APPS-WEB-MIGRATION.md) steps 1–5 |

## 1. Surfaces

| Route | Kind | Notes |
|---|---|---|
| `/signin` | page + server action | Fixed error vocabulary. Rate limited per IP+email and per IP. Safe `next=`. Signed-in visitors continue to `/app`. |
| `/signup` | page + server action | Athlete / Organization chooser, then an email + password form. The lane is a UI hint carried only in the confirmation link (`?path=`). Nothing is written to Supabase metadata. |
| `/signup/confirm-email` | page + server action | "Check your inbox", plus a rate-limited resend |
| `/forgot-password` | page + server action | Always answers "if an account exists…" (no enumeration). The link returns to `/auth/callback?flow=recovery`. |
| `/reset-password` | page + server action | Requires a verified **recovery session**: a `getClaims()` `amr` entry `recovery` from the last hour. The check runs on the page and again on submit. On success: update the password, `signOut({scope:'global'})`, then `/signin?notice=password_updated`. |
| `/auth/callback` | GET route | PKCE code exchange. Expired, invalid and other-browser links map to fixed codes. Recovery goes to `/reset-password`; everything else to the data-derived destination with `notice=email_verified`. |
| `/auth/confirm` | GET route | Token-hash links (`verifyOtp`) for cross-browser email confirmation and recovery |
| `/auth/signout` | POST route | POST-only (GET/HEAD return 405). Cross-origin requests are refused. Clears `sb-*` auth cookies even if Supabase is unreachable. |
| `/app` | layout + page | Authenticated shell: navigation built from platform rows, account entry point, POST sign-out, `<details>` mobile menu. Shows the setup state, or the user's athlete profiles and organizations. No fake data. |
| `/app/onboarding` | page + server actions | Athlete path: `POST /v1/persons` → `POST /v1/athletes`. Organization path: `POST /v1/persons` → `POST /v1/organizations` (the creator becomes OWNER). Per-form idempotency keys. Sponsor is not offered. |
| `/app/account` | page | Email, sign-in method, platform account id and person status. Links to change password. |

The public explorer pages moved into the `app/(explorer)` route group. Their URLs and rendering are unchanged.

## 2. Authority and fail-closed rules

- **Identity:** Supabase proves identity. The proxy and pages use only `getClaims()`, which is JWKS-verified. There is no unverified `getSession()` user fallback.
- **Platform data:** the platform API decides accounts, persons, athletes, organizations and memberships. Server code forwards the access token, and the API's Supabase `AuthAdapter` verifies it again.
- **Onboarding state:** derived from `GET /v1/me` plus the new `GET /v1/me/organizations` (active memberships of the caller's SELF person). There is no `onboardingCompleted` flag.
- **`/app` fails closed** in two layers:
  - the proxy redirects when there is no verified session;
  - the layout renders a blocked state when the API rejects the token (401) or is unavailable.

  In neither case is any app content rendered.
- **Errors:** messages come from a fixed vocabulary (`_lib/auth/messages.ts`). Raw provider text is never shown on the page.
- **Email links:** link bases come from `NEXT_PUBLIC_SITE_URL`, never from the request `Host`. Production fails closed without it.

## 3. Tests

### Local (no Supabase project, no database). Run with `pnpm test`.

| File | Covers |
|---|---|
| `apps/web/app/_lib/auth/auth-flows.test.ts` | Sign-in (success, safe and unsafe `next`, invalid credentials, unverified email, rate limit, network, not configured). Sign-up (no metadata, duplicate email, weak password, production `SITE_URL`). Forgot and reset password (recovery session required, expired session, global sign-out). Callback and confirm (expired, invalid, other-browser links, recovery). POST-only sign-out. Onboarding persistence through the API (person → athlete/organization, idempotency keys, slug conflict, 401, outage, Sponsor refused). `/app` context fail-closed states. |
| `apps/web/app/_lib/auth/auth-units.test.ts` | Rate limiter, recovery-session predicate, message vocabulary (no prototype keys), slug/country/key shaping |
| `apps/web/app/_lib/auth/auth-wiring.test.ts` | Continuation validation, route policy, onboarding resolver, proxy gate |
| `apps/web/app/_tests/auth-pages.test.tsx` | Rendered screens: sign-in errors and continuation, chooser without Sponsor, sign-up fields, reset invalid/valid states, `/app` blocked states and role-aware nav |
| `apps/api/src/supabase-auth.test.ts` | Token verification (unchanged from the wiring step) |

### Integration (needs the CI Postgres; runs in `pnpm test:integration`)

`apps/api/src/supabase-auth.int.test.ts` signs tokens with a local key and injects the JWKS, so **no Supabase project is required**. It proves:
- `(supabase, sub)` resolves to an account;
- the athlete and organization onboarding paths work;
- `/v1/me/organizations` returns the caller's memberships;
- `user_metadata` and `app_metadata` claims grant nothing.

Local qualification without Docker (2026-10-06): the full suite was run against a throwaway PostgreSQL 18.3 cluster inside a private user + network namespace (`unshare -rn`, loopback only). That made the developer cluster on `localhost:55432` unreachable by construction. Results:
- `db:bootstrap` and `db:migrate` (0001–0030) passed;
- `test:integration`: **40 files, 544/545**. The new file passed.
- The one failure was `persistence/src/verification.int.test.ts` › "no applicable published policy" (`AUTHORITY_DENIED: PRINCIPAL_UNKNOWN` inside the shared `newContestResult` fixture). This branch does not touch that file. It passed on an isolated re-run together with `supabase-auth.int.test.ts` (24/24), and passes in CI. It is treated as a timing flake under a very slow run (31 min on `/mnt/c`), not as fixed.

### Against a real Supabase project (manual / future E2E)

These are not automated. They need:

| Variable | Where | Value |
|---|---|---|
| `BR_AUTH_PROVIDER` | API | `supabase` |
| `BR_SUPABASE_URL` | API | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_URL` | web | same project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | the project's anon/publishable key (never the service-role key) |
| `NEXT_PUBLIC_SITE_URL` | web | the app origin, e.g. `http://localhost:3000` |
| `BR_API_URL` | web | the API origin |

Supabase project settings (dashboard → Authentication / Project Settings):

| Setting | Required value | Why |
|---|---|---|
| JWT signing keys | **Asymmetric** (ES256 or RS256) as the current key; legacy HS256 secret not in use | The API verifies against `<project>/auth/v1/.well-known/jwks.json`. HS256 tokens are rejected (`alg` must be ES256/RS256). |
| Confirm email | **On** | Sign-up returns no session until the link is opened, and does not reveal whether an address is already registered |
| Site URL | the app origin (= `NEXT_PUBLIC_SITE_URL`) | Default base for email links |
| Redirect URLs allow-list | `<site>/auth/callback**` and `<site>/auth/confirm**` | Links carry query strings (`?flow=signup&path=…`, `?flow=recovery`); without the `**` wildcard Supabase falls back to the Site URL |
| Minimum password length | 8, letters and digits | Matches the app-side check (`weak_password`) |
| Anonymous sign-ins | Off (recommended) | Anonymous sessions are already rejected by the API, proxy and pages |
| Custom auth domain | If used, set `BR_SUPABASE_URL` to the URL that appears in the token `iss` (`<url>/auth/v1`) | The issuer must match exactly |
| Email templates (optional) | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` (confirm) / `&type=recovery` (reset) | Lets links work in a different browser. The default `{{ .ConfirmationURL }}` uses `/auth/callback` (PKCE, same browser). |

Keys: `NEXT_PUBLIC_SUPABASE_ANON_KEY` takes the project's **publishable** key (`sb_publishable_…`) or the legacy anon key. The secret/service-role key is never configured anywhere in this stack. No secrets are committed; `.env.example` lists names only.

## 4. Known gaps

- **Rate limiting is per server instance.** It runs in memory, on top of Supabase's own per-project limits. A shared store is needed for multi-instance production.
- **Second-factor and OAuth providers are not exposed in the UI.** The adapter already maps `oauth` and MFA `amr` values.
- **Athlete display names in `/app`:** `/v1/me` returns athlete slugs, not names, so the list shows slugs.
- **No automated browser E2E against a live Supabase project.**
- **No deployment.** The web app, API, Postgres and PII KMS remain undeployed (ONCF-00A §10 step 0).
