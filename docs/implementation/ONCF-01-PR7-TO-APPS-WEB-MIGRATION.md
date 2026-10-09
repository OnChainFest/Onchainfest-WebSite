# ONCF-01 — Migrating PR #7 into `apps/web`

| | |
|---|---|
| Source | PR #7 `feat/auth-onboarding-foundation` @ `b233abf` (draft; based on `main`) |
| Target | `apps/web` (Next 16.3.6, pnpm workspace) + `apps/api` `AuthAdapter` |
| Decisions | [ADR-0052](../adr/ADR-0052-supabase-auth-is-the-identity-provider-behind-the-auth-adapter.md) |
| Status | Wiring and steps 1–5 below done on local branch `feat/oncf-01-auth-wiring` (not pushed); see [ONCF-01-AUTH-UX](./ONCF-01-AUTH-UX.md). Steps 6–8 remain. |

## 1. Existing slots (what PR #7 should have targeted)

| Concern | Location |
|---|---|
| Login slot | `AuthAdapter` and `authFromEnvironment` in `apps/api/src/auth.ts`. Supabase adapter: `apps/api/src/supabase-auth.ts`. |
| Account provisioning | `IdentityStore.signIn` in `packages/persistence/src/identity-store.ts:120` (auto-creates the account and `auth_identity`) |
| Who am I | `GET /v1/me` (AUTHENTICATED), returning `selfPersonId`, `athletes[]` and `guardianRelationships[]` |
| Person | `POST /v1/persons` (AUTHENTICATED, `relation: SELF`) |
| Athlete | `POST /v1/athletes` (GUARDIAN; `personId`, `slug`, `profile.displayName`, …) |
| Organization | `POST /v1/organizations` (AUTHENTICATED; the creator becomes OWNER) |
| Invitations | `POST /v1/organizations/:id/invitations` (ORG_ADMIN), `POST /v1/invitations/accept` and `/decline` (SELF) |
| Web routing | `apps/web/app/*`: public read pages (`/athletes/[slug]`, `/organizations/[slug]`, `/competitions/…`, rankings, records…). New: `apps/web/proxy.ts` gates `/app/**`. Auth screens go at `/signin`, `/signup/**`, `/auth/**`. |
| Web → API with a session | `apps/web/app/_lib/api-authed.ts` (`getAuthed`) forwards the Supabase access token |

## 2. PR #7 inventory

| PR #7 file | Verdict | Target |
|---|---|---|
| `src/app/globals.css` (auth design tokens and classes) | **Reuse** | `apps/web/app/(auth)/auth.css`, scoped to the auth and app route groups so the public read pages keep their current styling |
| `src/components/auth-shell.tsx` (`AuthShell`, `ProductNav`) | **Reuse** | `apps/web/app/_components/auth-shell.tsx`. Point the nav "home" link at the marketing site URL. |
| `src/app/signup/page.tsx` (athlete or organization chooser) | **Reuse UI** | `/signup`. The choice becomes a `?path=` onboarding hint, not metadata. |
| `src/app/signup/athlete/page.tsx`, `signup/organization/page.tsx` | **Adapt** | One email + password form. The organization name moves to onboarding (`POST /v1/organizations`). |
| `src/app/signin/page.tsx` | **Reuse UI** | `/signin`. `next` is validated with `validateContinuationRoute`. |
| `src/app/signup/confirm-email/page.tsx` | **Reuse** | `/signup/confirm-email` |
| `src/app/auth/callback/route.ts` | **Adapt** | `/auth/callback`: exchange the code, then send the user to `resolvePostAuthDestination` (facts from `/v1/me`) |
| `src/app/auth/actions.ts` | **Rewrite** | Server actions with no `account_type`, `organization_name` or `full_name` in `user_metadata`. Generic error messages (no account enumeration), rate limiting, minimum password 8. |
| `src/lib/supabase/server.ts`, `env.ts` | **Replaced** | Already ported as `app/_lib/auth/supabase-server.ts` and `supabase-env.ts` (fail closed when not configured) |
| `src/lib/auth/safe-redirect.ts` | **Replaced** | `app/_lib/auth/continuation.ts` (PMFreak rules plus an `/app` allowlist) |
| `src/lib/auth/account-type.ts` | **Discard** | Account type is derived from rows (`app/_lib/auth/onboarding.ts`) |
| `src/app/onboarding/athlete/page.tsx`, `onboarding/organization/page.tsx` | **Adapt UI** | `/app/onboarding`. The inert placeholder buttons are replaced by real `POST /v1/persons` → `/v1/athletes` or `/v1/organizations` calls. No "wiring next" copy. |
| `src/app/pricing/page.tsx` | **Defer** | Billing is a separate step. It is not part of sign-up and not copied now. |
| Root `package.json`, `tsconfig.json`, `next.config.mjs`, `next-env.d.ts`, `scripts/prepare-static-assets.mjs` | **Discard** | They form the second Next.js app and wrap the marketing page via a `/` → `/home.html` rewrite |
| `.gitignore` additions (`public/home.html` …) | **Discard** | Only needed by the discarded wrapper |
| `vercel.json` CSP `connect-src *.supabase.co` | **Move** | Into the `apps/web` deployment's headers. The static marketing site makes no Supabase calls. |
| `index.html` nav and hero CTAs (`/signin`, `/signup`, `/signup/athlete`, `/pricing`) | **Adapt later** | Re-apply on top of `main` as absolute links to the app domain, once the app is deployed |
| `img/court-lines.svg`, `img/grain.svg` | Already on `main` (PR #6) | No action |

## 3. Wiring done in this step

- `apps/api/src/supabase-auth.ts`: JWKS-verified Supabase adapter, selected by `BR_AUTH_PROVIDER=supabase` in `authFromEnvironment`. It has 24 unit tests: forged, expired, wrong-issuer, anon and service-role tokens; `alg` confusion; JWKS outage; and key caching with a rate limit.
- `packages/identity`: `AuthenticationMethod` adds `PASSWORD`.
- `apps/web`:
  - adds the pinned `@supabase/ssr` 0.10.2 and `@supabase/supabase-js` 2.104.1;
  - `proxy.ts`, a `/app/**` gate using `getClaims()` that copies cookies onto redirects and fails closed;
  - `_lib/auth/{continuation,route-policy,onboarding,supabase-env,supabase-server,proxy-session}.ts`;
  - `_lib/api-authed.ts`;
  - 25 unit tests.
- `.env.example` adds `BR_AUTH_PROVIDER`, `BR_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- ADR-0052 is added.

No screens, routes or database changes were added. Public pages behave exactly as before, because the proxy only matches `/app/**`.

## 4. Remaining steps (in order)

1. **Auth screens:**
   - Port the CSS, `AuthShell`, `/signup`, `/signin`, `/signup/confirm-email` and `/auth/callback` (§2).
   - Add a POST-only `/auth/signout`, and password reset that requires a recovery session.
   - Rate-limit the sign-in and sign-up actions.
2. **Memberships in `/v1/me`.** Add the account's active memberships (`organizationId`, `slug`, `role`) to `IdentityStore.me` or a sibling `GET /v1/me/memberships`, with an integration test. This feeds `OnboardingFacts.membershipCount`.
3. **`/app/onboarding`.** Derive the state from `/v1/me`, then:
   - athlete path: `POST /v1/persons {relation:'SELF'}` → `POST /v1/athletes`;
   - organization path: `POST /v1/persons` → `POST /v1/organizations`.

   Use `Idempotency-Key` on every call.
4. **`/app` home** with a minimal signed-in landing (athlete or organization). This is real content, not a "coming soon" page.
5. **API integration test.** Run `buildServer` with `createSupabaseJwtAuth` and an injected JWKS against the CI Postgres to prove `(supabase, sub)` → account → `/v1/me`.
6. **Deployment.** Deploy `apps/web` as its own Vercel project, and the API, worker and Postgres on the chosen host, plus the PII KMS (ONCF-00A §10 step 0). Configure the Supabase project: asymmetric signing keys, email confirmation on, site URL set to the app domain.
7. **Marketing CTAs.** Point the `index.html` nav and hero links at the app domain.
8. **Close PR #7** with a link to this document.
