# ONCF-02 — Organization administration

| | |
|---|---|
| Branch | `feat/oncf-01-auth-wiring` (local, uncommitted; on top of `8aa7aba`) |
| Builds on | Canonical organization / membership / invitation / permission model (BRT-04, migration `0005`, `OrganizationStore`, `packages/identity/src/permissions.ts`) and ONCF-01 auth (ADR-0052) |
| Out of scope | Sponsor, BRT/tokenomics, tournament creation |

## 1. Surfaces (`apps/web`)

| Route | Who | What |
|---|---|---|
| `/app/orgs/[slug]` | active members | Dashboard: active members (role bar), pending invitations (ORG_VIEW_PRIVATE), published tournaments, public-profile completeness ring, next steps (editors). The tournament empty state is real. |
| `/app/orgs/[slug]/profile` | edit: ORG_EDIT_PROFILE; others read-only | Name, about, sports, website, country, public contact, logo URL, brand colour; live card of the public profile |
| `/app/orgs/[slug]/members` | members; controls by permission | Roster: name (public athlete profile only), role, status, since. Role change (ORG_MANAGE_ROLES; OWNER only by owners). Suspend/reactivate/remove (ORG_REMOVE_MEMBER, removal behind a confirm step). No controls on yourself or on owners unless you are an owner. |
| `/app/orgs/[slug]/invitations` | ORG_INVITE_MEMBER or ORG_VIEW_PRIVATE (else 404) | Invite by athlete profile address; one-time invitation link shown once; pending list with expiry; revoke (ORG_REMOVE_MEMBER) |
| `/app/orgs/[slug]/roles` | members | Role × permission matrix from the canonical `ROLE_PERMISSIONS` (served by the API); the caller's roles highlighted |
| `/app/orgs/[slug]/settings` | members; address change: ORG_EDIT_PROFILE | Change the page address (old addresses redirect); leave the organization (all of the caller's memberships, owners last) |
| `/app/invitations?token=…` | the invitee | Preview (organization, role, expiry) → Accept (→ organization area) / Decline. `Referrer-Policy: no-referrer`. |
| `/organizations/[slug]` | public | Rebuilt in the product style (`(public)` route group): branded hero, sports, website/contact, about with the self-description disclosure, published tournaments, publicly affiliated athletes. Uses only public endpoints, without credentials. |

Non-members get a plain 404 for every `/app/orgs/[slug]/**` page, so nothing about other organizations is revealed. The account navigation and `/app` home now link to the organization area.

## 2. API usage and the minimal extensions

These routes were used as they are:
- `GET /v1/me`, `/v1/me/organizations`
- `GET /v1/organizations/:id/permissions`, `/members`
- `PATCH /v1/organizations/:id/profile`
- `POST /v1/organizations/:id/invitations`
- `PUT /v1/memberships/:id/status`
- `POST /v1/memberships/:id/role`
- `POST /v1/invitations/accept|decline`
- `GET /v1/organizations/:slug`

Extensions. All of them run on the existing stores, and no second invitation or permission system was created.

| Change | Why |
|---|---|
| Migration `0031_organization_branding.sql`: `organization_profile.logo_url` (https), `accent_color` (`#rrggbb`), `sports text[]` (≤ 10) | Logo, branding and sport were not in the model. The logo is a URL because no production object store exists yet. |
| `PATCH /v1/organizations/:id/profile` accepts `logoUrl`, `accentColor`, `sports`; the public `GET /v1/organizations/:slug` serves them | Same ORG_EDIT_PROFILE check, same validation path |
| `POST /v1/organizations/:id/invitations` accepts `athleteSlug` instead of `personId` | Admins never see person ids. The permission is checked **before** the address lookup (no existence oracle). Only ACTIVE athletes with PUBLIC/AUTHENTICATED profiles resolve. |
| `POST /v1/invitations/inspect` (SELF) | Preview before answering. Unknown, used, expired, foreign and closed-organization tokens are indistinguishable (422). |
| `GET /v1/organizations/:id/members` adds `athlete {slug, displayName}` (PUBLIC/AUTHENTICATED profiles only) and `invitationExpiresAt` | Name roster rows without PII; show when pending invitations lapse |
| `PUT /v1/organizations/:id/slug` (store method already existed) | Page-address change, ORG_EDIT_PROFILE |
| `GET /v1/organizations/:slug/competitions` (PUBLIC, non-DRAFT cards) | Dashboard and public page tournament lists |
| `GET /v1/organization-roles` (PUBLIC) | The canonical role → permission table, so the UI never re-declares permission names |

## 3. Tests

- **API integration** (`apps/api/src/organizations-admin.int.test.ts`, 23 tests):
  - the roles table equals `ROLE_PERMISSIONS`;
  - the creator is OWNER;
  - stranger and plain-member mutations are rejected (403);
  - branding validation;
  - an address change redirects;
  - invite by address → preview → accept / decline;
  - only the invitee can preview or answer, and gets the same invalid answer otherwise;
  - a revoked invitation can't be accepted;
  - no address oracle for non-admins;
  - private profiles don't resolve;
  - the roster carries no PII, and pending invitations are visible only to ORG_VIEW_PRIVATE;
  - role boundaries (only an OWNER grants OWNER);
  - leave, and last-owner protection;
  - the public DTO contains public fields only.
- **Web unit** (`apps/web/app/_tests/org-admin.test.tsx`, 20 tests):
  - non-member 404;
  - permission-filtered tabs and controls;
  - real dashboard counts;
  - members without public profiles stay unnamed;
  - actions call the canonical routes, map 403 to `not_permitted`, and never mutate for organizations the caller doesn't belong to;
  - invented roles never reach the API;
  - one-time link handling;
  - invitee preview, accept and decline;
  - the public page uses only uncredentialed public endpoints.

## 4. Known gaps

- **Invitation delivery is a copied link.** There is no email delivery yet.
- **Invitations target people with a public athlete profile.** Staff or coaches without one need an account handle or email invitations.
- **The logo is an external https URL**, until an object store exists.
- **Draft tournaments are not counted.** Only published ones are served publicly; staff-only competition reads come with tournament creation.
- **No tournament creation yet.** It is the next step.
