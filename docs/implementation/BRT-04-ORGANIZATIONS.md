# BRT-04 — Organizations

Status: **implemented (foundation)** · ADRs: [0020](../adr/ADR-0020-three-layer-authorization.md) (membership ≠ authority), [0021](../adr/ADR-0021-account-person-control-and-person-keyed-membership.md)

## 1. Organization, profile, principal

- **`organizations.organization`** holds the stable identity (id, `org_type`, creator, `recorded_at`), with a status history of ACTIVE / SUSPENDED / CLOSED (INTERNAL operators only).
- **`organization_profile`** (OP) is self-described: display name, description, `https://` website, logo reference, ISO country and region, and public contact. It implies no recognition.
- **`organization_slug`** keeps slug history, with the same rules as athlete slugs: normalized, reserved words refused, former slugs redirect and can never be re-claimed.
- **`organization_principal`** maps each organization to a **separate** `authority.principal` of type `ORGANIZATION` (never the same id; enforced by CHECK and UNIQUE).
  - The principal is created in the same transaction. Its label is `organization:<id>` (non-PII) and its fact hash is `br:principal`.
  - This is a narrow cross-context write: `br_organizations` has INSERT on `authority.principal` and nothing else in `authority`, so it cannot create grants, anchors or keys (tested).
  - **A new organization has zero grants and zero trust anchors.** Its sports authority (if any) comes only from the Authority Engine (BRT-03). The public page shows "Sporting authority: not available yet".
  - Closing an organization never deletes the mapping or the principal's authority history.

### Principal consistency — what is proven, and how (BRT-04R)

| Property | Mechanism | Test |
|---|---|---|
| At most one mapping per organization, and one organization per principal | `organization_principal` PK (`organization_id`) and UNIQUE (`principal_id`) | second mapping → 23505 |
| **Every** organization has its mapping | Deferred constraint trigger `organization_requires_principal`: an organization without a mapping cannot commit (BR002) | raw insert without mapping fails at COMMIT |
| The mapped principal is `ORGANIZATION` | Composite FK `(principal_id, principal_type) → authority.principal (id, principal_type)` with `principal_type = 'ORGANIZATION'`. It relies on an additive unique index on `authority.principal (id, principal_type)`; BRT-03 migrations are unchanged. | mapping to a PERSON principal → 23503 |
| No orphan ORGANIZATION principal from normal creation | Organization, principal, mapping, profile, slug and OWNER membership are written in one transaction; a failure rolls back all of them | concurrent same-slug creations: one wins, zero orphans, zero unmapped |
| FEDERATION confers no authority | `org_type` is descriptive; new principals have no grants or anchors | OWNER of a FEDERATION has 0 grants and 0 anchors; a grant to an org principal changes no permission |
| Closing keeps the principal and its history | Status is append-only; the mapping, principal and grants are append-only tables | CLOSED org keeps its mapping, principal and grant; it is no longer served publicly |

## 2. Type taxonomy — why there is no `TEAM`

`org_type ∈ {FEDERATION, GOVERNING_BODY, LEAGUE, CLUB, ACADEMY, EVENT_ORGANIZER, VENUE, SPONSOR, BRAND, SERVICE_PROVIDER, OTHER}`.

**TEAM is deliberately excluded.** In BRT-01 a *Team* is a **competition identity**: a persistent side, or an ad-hoc pair (e.g. a padel pair), that appears as a participant in results. An organization is an operational body with members, a profile and possibly authority. Making "team" an organization type would merge two concepts BRT-01 keeps apart:

- ad-hoc pairs would need to become organizations;
- a club's several teams would be indistinguishable from the club.

A club that fields teams is a `CLUB`. The teams themselves are competition entities (BRT-05+).

`org_type` is **descriptive only**. `FEDERATION` confers nothing: an OWNER of a self-declared federation has no capability (tested).

## 3. Memberships

`organizations.membership` links an organization and a **person**, with a role that is immutable per row, a visibility (PUBLIC / MEMBERS / PRIVATE) and the inviting account. Its status history:

```
INVITED ──accept──▶ ACTIVE ──suspend──▶ SUSPENDED ──reactivate──▶ ACTIVE
   │                  │                      │
   └──decline──▶ DECLINED   └────────end────────┴──▶ ENDED
```

- A **role change** ends the current membership and creates a new ACTIVE one, so history is preserved (`changeRole`).
- An organization always keeps **at least one ACTIVE OWNER**. Ending, suspending or demoting the last owner fails with `INVALID_TRANSITION`.
- A member (or their confirmed guardian) may **end their own** membership. Everything else needs permissions (below).

### Application permissions (`packages/identity/src/permissions.ts`)

| Role | ORG_VIEW_PRIVATE | ORG_EDIT_PROFILE | ORG_INVITE_MEMBER | ORG_REMOVE_MEMBER | ORG_MANAGE_ROLES | ORG_CONFIRM_EXTERNAL_ID |
|---|---|---|---|---|---|---|
| OWNER | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| ADMIN | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| STAFF | ✔ | | | | | |
| MEMBER, ATHLETE, COACH, OFFICIAL | | | | | | |

- Only an OWNER may assign, change to, or change from OWNER (`canAssignRole`).
- Permissions come only from **ACTIVE** memberships in an **ACTIVE** organization, held by the account's **SELF** person, and from an active account.
- **These are application permissions, not BRT capabilities.** The vocabularies share no value (compile-time guard `ORG_PERMISSIONS_ARE_NOT_CAPABILITIES`, plus a unit test). No function maps one onto the other.
- An `OFFICIAL` membership does not let anyone officiate. `DECLARE_OFFICIAL` exists only as an Authority Engine grant.

## 4. Invitations

- `invite` (ORG_INVITE_MEMBER, plus `canAssignRole`) creates an INVITED membership and an invitation carrying a **256-bit random token**. The raw token is returned **once**.
- Only `sha256:` + SHA-256(`br-invitation:` + token) is stored (`token_hash` UNIQUE, CHECK on its format). **Expiry is 7 days** (configurable for tests).
- **Idempotency.** Replaying the same `Idempotency-Key` returns the same membership and invitation with `token: null`. The secret cannot be recovered, because only its hash exists. A lost token means a new invitation, after the old one is ended.
- **Accepting or declining** (`POST /v1/invitations/{accept|decline}`):
  - Allowed for the invitee (SELF) or their **confirmed** guardian.
  - The invitation is single-use: `invitation_consumption` PK.
  - Unknown, used, expired and organization-inactive tokens are indistinguishable (`INVITATION_INVALID`).
  - Repeating the same answer is an idempotent success; switching the answer is refused.
  - Concurrent acceptance activates the membership once (tested).
- Tokens never appear in logs, events or audit entries.

## 5. Public organization page

`GET /v1/organizations/:slug` (PUBLIC, `br_public_read`) returns:

- the profile, labelled `SELF_DECLARED`;
- the type and status (CLOSED organizations are not served; SUSPENDED ones are shown with a notice);
- `authority: { status: NOT_AVAILABLE }`;
- public affiliations of visible athletes (from the passport projection), labelled `ORGANIZATION_CONFIRMED`.

The web page is `apps/web/app/organizations/[slug]/page.tsx`. It says explicitly that being listed does not mean being recognized as a sporting authority. External website links use `rel="nofollow noopener noreferrer ugc"`.

Suspending an organization removes its affiliations from passports, and reactivating restores them (tested).

## 6. Out of scope

Organization verification/recognition UX (anchor issuance stays INTERNAL/BRT-03), teams and rosters for competitions, organization keys, billing, bulk invites, e-mail delivery of invitations, and organization deletion.
