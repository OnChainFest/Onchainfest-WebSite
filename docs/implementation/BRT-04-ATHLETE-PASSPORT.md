# BRT-04 — Athlete Passport

Status: **implemented (read model v1)** · ADR: [0022](../adr/ADR-0022-athlete-passport-read-model.md)

The Athlete Passport is the public view of an athlete. It is a **read model**: it is never a source of sporting truth, and it holds nothing that cannot be rebuilt from identity and organization facts.

## 1. What it shows, and how honestly

The DTO is `AthletePassportV1` (`packages/identity/src/passport.ts`, schema `br:athlete-passport@1`). Every displayed fact carries a **provenance** label:

| Provenance | Used for in BRT-04 | Web label |
|---|---|---|
| `SELF_DECLARED` | display name, bio, country, sports; CLAIMED external ids; organization names (the org's own description) | "Self-declared" |
| `ORGANIZATION_CONFIRMED` | affiliation roles (ACTIVE membership accepted by the athlete and issued by the org); CONFIRMED external ids | "Confirmed by organization" |
| `PROOF_OF_CONTROL` | wallets verified by the production EIP-191 verifier | "Wallet control proven" |
| `TEST_PROOF` | wallets verified by the development test verifier (**development/test only**; see below) | "Test proof — not a real verification" |
| `ACCOUNT_VERIFIED`, `AUTHORITY_VERIFIED`, `SYSTEM_DERIVED` | **not produced by BRT-04** | — |

**Test proofs are fail-safe (BRT-04R).**

- `walletProofProvenance` is an explicit, exhaustive mapping. `VERIFIED` → `PROOF_OF_CONTROL`. `TEST_VERIFIED` → `TEST_PROOF` under the `LABEL` policy, or **omitted** under `SUPPRESS`. Anything else is omitted.
- `TEST_VERIFIED` is never mapped to `PROOF_OF_CONTROL`.
- `assemblePassport` defaults to `SUPPRESS`.
- `PassportReader` uses `LABEL` only outside production. **In production it always suppresses test proofs**, even if asked to label them. So development data that somehow reaches a production database is never shown as proof of anything.
- Production also cannot create such data: see BRT-04-IDENTITY §7. Tested in `identity.int.test.ts` ("BRT-04R · TEST_PROOF production safety") and in the unit tests.

`AUTHORITY_VERIFIED` never appears: no BRT-04 source is backed by the Authority Engine. `ORGANIZATION_CONFIRMED` means an organization's *application-level* action, not sports authority.

## 2. Sections

| Section | BRT-04 status |
|---|---|
| `affiliations` | `AVAILABLE` (possibly empty) |
| `externalIdentities` | `AVAILABLE` (possibly empty) |
| `wallets` | `AVAILABLE` (possibly empty) |
| `verifiedAchievements`, `records`, `competitionHistory`, `careerStats`, `trophies` | **`NOT_AVAILABLE`**, reason `SOURCE_NOT_IMPLEMENTED`, `items: []` |

`NOT_AVAILABLE` ≠ empty. "Available and empty" means the source exists and has nothing to show. "Not available" means the platform has no source yet. The web renders the two differently. Nothing is ever fabricated, and a bio saying "world champion" stays a self-declared bio (tested).

## 3. Visibility

`isPassportVisible(card, viewer)` serves the passport only when all of these hold:

- the athlete is ACTIVE;
- the passport is **not restricted** (a dependent under a PENDING or ACTIVE guardian relationship);
- profile visibility is `PUBLIC`, or `AUTHENTICATED` with a signed-in viewer. `PRIVATE` is never served publicly.

Hidden, restricted and unknown athletes all produce the same **404** body. Attribute-level filters are applied when projecting:

- only `PUBLIC` external identities and wallets;
- only ACTIVE memberships with `PUBLIC` membership visibility, an ACTIVE organization and an athlete-facing role (`ATHLETE`, `MEMBER`, `COACH`).

## 4. Projection and rebuild

Schema `passport` (migration `0006`), class B projection:

| Table | Content |
|---|---|
| `athlete_card` | profile fields, current slug, visibility, `restricted`, athlete status, canonical athlete id |
| `athlete_slug` | every slug ever claimed → athlete (redirects without reading identity tables) |
| `affiliation` | membership id, athlete, organization, role, since |
| `external_identity` | PUBLIC, non-revoked identities with status |
| `wallet` | PUBLIC, ACTIVE links with proof status |

Maintenance:

- **Incremental.** Each identity or organization command refreshes the affected athlete inside its own transaction (`refreshAthletePassport`, `refreshAffiliations*`). Identity commands refresh the whole card. Organization commands refresh only affiliations; they have DELETE/INSERT on `passport.affiliation` alone.
- **Full rebuild.** `rebuildPassports(maintenanceDb)` runs as `br_rebuild` on the maintenance login: it truncates the projection and re-derives everything. It needs **no** access to `identity_private`, `auth_identity` or `account`. Tests, and demo step 20, assert that the rebuilt projection is byte-identical to the incremental one.
- **Public reads** (`PassportReader`) run as `br_public_read`. That role can SELECT the passport tables and the public organization profile tables, and nothing else (tested).

## 5. Slugs and redirects

`GET /v1/athletes/:slug` normalizes the slug and looks it up in `passport.athlete_slug`. It returns `{ passport, canonicalSlug, redirected }`. The web page `/athletes/[slug]` issues a permanent redirect when `redirected` is true, or when the requested spelling differs from the canonical slug (e.g. upper case).

## 6. Web page

`apps/web/app/athletes/[slug]/page.tsx` is a server component that calls the public API without credentials:

- it shows provenance badges on every fact, and a notice that the profile is self-described and not a verified record;
- `NOT_AVAILABLE` sections render as "Not available yet" with an explanation;
- 404 renders a neutral "not found" page (private, restricted and missing look the same);
- if the API is unreachable, it renders a "temporarily unavailable" page.

The organization page links back to athlete pages.

## 7. Out of scope

Results, achievements, records, competition history, stats and trophies (BRT-05+), media and avatars, search and listing, signed or anchored passport exports, and caching or CDN policy.
