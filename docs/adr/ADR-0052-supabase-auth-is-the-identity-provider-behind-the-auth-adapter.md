# ADR-0052 — Supabase Auth is the identity provider, behind the AuthAdapter

- **Status:** Proposed (ONCF-01 prep, pending review)
- **Date:** 2026-10-06
- **Origin:** ONCF-00A platform reuse audit (§9); prompt 00.5 decisions 1–12

## Context

The platform core already has a provider-agnostic identity model:
- `identity.account` and `auth_identity (provider, provider_subject)`;
- `IdentityStore.signIn`, which provisions an account on first sign-in, idempotently;
- the API `AuthAdapter` seam (`apps/api/src/auth.ts`), whose production default is fail-closed;
- endpoint classes and `OrgPermission`.

No identity provider was connected.

Draft PR #7 introduced Supabase Auth through a second, root-level Next.js app. It stored the account type and organization name in Supabase `user_metadata` and never reached the platform API. PMFreak and HRkey both use Supabase Auth, and both have defects caused by trusting `user_metadata`, a `getSession()` fallback, or client-side role selection (ONCF-00A §7).

## Decision

1. **Supabase Auth is the authentication provider.** It proves *who* the caller is, and nothing more.
2. **It connects only through the API `AuthAdapter`.**
   - `BR_AUTH_PROVIDER=supabase` selects `createSupabaseJwtAuth` (`apps/api/src/supabase-auth.ts`).
   - The adapter verifies the bearer access token locally against the project JWKS. It accepts ES256 or RS256 only, plus these checks:
     - issuer `<project>/auth/v1`, audience `authenticated`;
     - `exp`, `iat` and `nbf`;
     - `role = authenticated` and not anonymous.

     This rejects the anon and service-role API keys.
   - It then resolves `IdentityStore.signIn({ provider: 'supabase', providerSubject: sub })`.
   - Every verification failure, including an unreachable JWKS, fails closed.
   - Unknown `BR_AUTH_PROVIDER` values refuse to start.
3. **The platform database is the source of truth** for accounts, persons, athletes, organizations, memberships, roles and permissions. **No Supabase claim other than `sub` (and `amr`/`aal` for the method and assurance labels) is ever read.** `user_metadata` and `app_metadata` are never used for authorization or account type.
4. **No second user model.** There are no `profiles` or `users` tables in Supabase, and no Supabase RLS-backed product data. The web app never uses a service-role key.
5. **`apps/web` is the single authenticated surface.**
   - `/app/**` is protected by default by `apps/web/proxy.ts`.
   - Sessions are verified with `getClaims()`, with no unverified-cookie fallback.
   - Refreshed cookies are copied onto redirects.
   - Server code calls the API with the session's access token (`app/_lib/api-authed.ts`).
   - Auth screens live at `/signin`, `/signup/**` and `/auth/**`. No second Next.js app is created.
6. **The marketing site stays a separate static deployment** (`onchainfest.xyz`). It may link to the app; it is never wrapped by the app.
7. **Onboarding is derived from platform rows** (own person, athletes, active memberships), following the PMFreak pattern. A sign-up choice of "athlete" or "organization" is a UI hint only. Continuations (`next=`) are accepted only for same-origin `/app` paths.
8. `AuthenticationMethod` gains `PASSWORD`, which Supabase reports as the `password` amr. It is a label only and grants nothing.

## Consequences

- The Supabase project must use **asymmetric JWT signing keys** (JWKS). Legacy HS256 shared-secret projects are not supported, because a shared secret would put token-minting power in the API's environment.
- Account provisioning stays lazy: the first authenticated API call creates the account. Person, athlete and organization creation use the existing `/v1` routes.
- `/v1/me` does not yet return organization memberships. The onboarding resolver needs a membership count, so `/v1/me` (or a sibling read) must be extended before onboarding is wired (migration plan step 2).
- PMFreak's billing-by-metadata, admin-by-email-domain and `getSession()` trust fallbacks are explicitly not adopted.
- Sponsor features, Bragging Rights artifacts and tokenomics are unaffected and remain out of scope.
