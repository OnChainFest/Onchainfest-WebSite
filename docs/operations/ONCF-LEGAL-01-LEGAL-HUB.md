# ONCHAINFEST-LEGAL-01 · Legal hub: deployment, DNS and Stripe

`legal.onchainfest.xyz` is the corporate legal hub of OnChainFest LLC. The source is in
[`legal/`](../../legal/README.md). It is a separate static site, deployed as a **separate Vercel
project**.

| Workflow | Role |
| --- | --- |
| [`legal-hub.yml`](../../.github/workflows/legal-hub.yml) | **Build**. Untrusted, with no secrets. |
| [`legal-hub-deploy.yml`](../../.github/workflows/legal-hub-deploy.yml) | **Deploy**. Trusted: runs on `workflow_run` from the default branch. |

Status after ONCHAINFEST-LEGAL-06: previews enabled, **production disabled**.

- Project `onchainfest-legal` (no Git, no domain, Vercel Authentication), environment
  `legal-hub-preview` and `LEGAL_HUB_PREVIEW_ENABLED=true` exist. Nothing exists for production:
  no `legal-hub-production` environment, token, variable or DNS record.
- Both corporate documents are drafts, so production is refused until they are approved (§5).
- History:
  - LEGAL-03 split preview and production into independent switches.
  - LEGAL-04 split build and deploy across a trust boundary (§2).
  - LEGAL-05 ran the first preview (PR #35). Being the project's first deployment, Vercel made it
    a **production** deployment, and its production domain `onchainfest-legal.vercel.app`
    served the drafts without authentication until the owner removed it (§3.6).
  - LEGAL-06 serves `/` (it answered 404) and verifies Vercel's server-side target (§2).

## 1. Isolation from www.onchainfest.xyz

The public website (Vercel project `onchainfest-web-site`) is unchanged:

| Website safeguard | Effect on `legal/` |
| --- | --- |
| Root `.vercelignore` (`/*` plus a website allowlist) | `legal/` and `.github/` are outside the allowlist, so they are never uploaded |
| `vercel-deploy.yml` "Verify artifact" step | Any non-website file in that artifact fails the website deploy |
| Root `vercel.json`, `.vercelignore`, `vercel-deploy.yml` | Not modified by LEGAL-01, -03 or -04 |

`legal/test/hub.test.mjs` checks the `.vercelignore` exclusion with `git check-ignore`.

Note: `vercel-deploy.yml` runs on every pull request, including one that only touches `legal/`.
Such a PR still builds a website preview, and that preview is byte-identical to `main`'s.

## 2. Security model (LEGAL-04)

```
pull_request / push to main           workflow_run (definition always from main)
┌──────────── legal-hub.yml ────────┐   ┌──────────── legal-hub-deploy.yml ──────────────┐
│ untrusted: PR code, no secrets,    │   │ trusted: never checks out or runs PR code       │
│ contents:read token                │   │ env secrets only (legal-hub-preview/-production)│
│ tests → build.mjs → package        │──▶│ guard env → fetch artifact of THIS run/commit   │
│ → self-check → upload artifact     │   │ → sha256 digest → artifact.py verify            │
│   "legal-hub-site" + manifest      │   │ → workspace (trusted vercel.json + files)       │
└────────────────────────────────────┘   │ → check-ids → pull (token) → check-link         │
                                          │ → vercel build (no token, copies only)          │
                                          │ → check-output (files, routing)                 │
                                          │ → preview: project has production + protection  │
                                          │ → deploy --prebuilt (token) → read back target, │
                                          │   aliases; preview: anonymous probe of each URL │
                                          └─────────────────────────────────────────────────┘
```

### Build side (`legal-hub.yml`)

- **Triggers:** pull requests and pushes to `main` that touch `legal/**`, `.github/legal-hub/**`
  or these workflows.
- **Permissions:** no secrets, and the `GITHUB_TOKEN` is `contents: read` only. The checkout runs
  with `persist-credentials: false`.
- **Commit:** it builds the PR head commit, not GitHub's merge commit, so the artifact matches
  `workflow_run.head_sha` on the deploy side.
- **Steps:**
  1. The hub and workflow tests.
  2. The artifact-verification tests.
  3. `node legal/scripts/build.mjs`.
  4. **On pushes, only when production is enabled:** the first legal gate,
     `build.mjs --require-publishable`.
  5. `artifact.py package`, which writes the site and a `manifest.json` (repository, commit,
     run id, event, sha256 of every file).
  6. `artifact.py selfcheck`.
  7. `actions/upload-artifact@v4` uploads the result as `legal-hub-site`.

### Deploy side (`legal-hub-deploy.yml`)

**Why this file can be trusted.** GitHub runs `workflow_run` workflows from the default branch, so
a pull request cannot change these steps. The jobs only check out, sparsely and with no
credentials, `.github/legal-hub/`, `legal/vercel.json` and `.nvmrc`:

- for previews, from the default branch (`github.sha`);
- for production, from the `main` commit being deployed, after proving it is on `main`.

**Steps, in order.** Each step fails closed.

1. **Switch.** The job runs only if its own variable is the string `true`:
   - `LEGAL_HUB_PREVIEW_ENABLED`: preview, for successful same-repository PR builds of
     `legal-hub.yml`. There is no `--prod` anywhere in the preview job.
   - `LEGAL_HUB_PRODUCTION_ENABLED`: production, for successful **push** builds of **main**.
2. **Environment guard.** `legal-hub-preview` / `legal-hub-production` must allow deployments
   from `main` only. Production must also have **required reviewers**. An environment that GitHub
   auto-creates on first use has neither, so the job stops.
3. **Production only:** the commit must be on `main` (`compare` status `identical` or `ahead`).
4. **Artifact provenance and integrity.**
   - Exactly one `legal-hub-site` artifact in the **triggering run**.
   - Not expired.
   - Its `workflow_run.id` and `head_sha` equal the event's.
   - The downloaded zip's sha256 equals GitHub's artifact `digest`.
5. **`artifact.py verify`**, run from the trusted checkout. It rejects:
   - path traversal, absolute paths, backslashes and dotfiles;
   - symlinks, executable bits, duplicate and encrypted entries;
   - any file outside the site allowlist, and unsupported types;
   - PNG/ICO files that fail their magic bytes;
   - HTML without the legal-hub marker;
   - active content: `<script>`, event handlers, `<iframe>`, `<form>`, `<base>`, `http-equiv`,
     `javascript:` / `data:` URLs;
   - CSS `@import`, `url()` and `expression()`;
   - more than 64 files, files over 512 KiB, over 4 MiB in total;
   - a manifest whose commit, run or file hashes do not match.

   **Production mode** also rejects drafts, review markers, `noindex` and a `Disallow`
   `robots.txt`. That is the second legal gate, and it does not depend on any repository code.
   Nothing is written until everything passed.
6. **Workspace:** the trusted `legal/vercel.json` without its `buildCommand`, serving `public/`
   (the verified files). Keys that could add code or routing (`functions`, `builds`, `routes`,
   `redirects`, a framework) are refused, and `rewrites` must be exactly `/` → `/index`.
7. **`check-ids`:** the legal project id exists, is well formed and is **not**
   `VERCEL_PROJECT_ID` (the website). This runs before any credential is used.
8. **`vercel pull`**, with the legal token, into a temporary directory outside any checkout.
9. **`check-link`:**
   - the pulled `.vercel/project.json` is the legal project;
   - its Root Directory is empty;
   - its framework, build, install, dev and output settings are empty.
10. **`vercel build`**, without a token. It only copies `public/` (builder `@vercel/static`) and
    compiles the trusted headers and `cleanUrls`.
11. **`check-output`:** no functions; `builds.json` target is `preview` / `production`;
    `static/` is byte-identical to the verified files; and `config.json` routes every page to its
    clean URL, `/` to `index.html`, `/index` to a redirect to `/`, and unknown paths to the 404
    page. Unknown route shapes fail closed.
12. **Preview only, `check-project`** (token, `GET /v9/projects`): the project already has a
    production deployment and Vercel Authentication is on. Vercel assigns a project's **first**
    deployment to production whatever the CLI asks for (LEGAL-05), so a preview into an empty
    project is refused.
13. **`vercel deploy --prebuilt`** (`--prod` only in the production job), with the legal token.
14. **`check-deployment`** (token, `GET /v13/deployments`, `/v2/deployments/{id}/aliases`): the
    deployment belongs to the legal project and is READY, and its **server-side** target is
    `production` for production, `null`/`preview` for a preview. For a preview, the deployment URL
    and every alias are then requested **without credentials** and each must answer 401 or a
    redirect to `https://vercel.com/sso-api`. Anything else fails the job with a `SECURITY:`
    error naming the URLs, and §3.6 applies. Nothing is deleted or re-aliased automatically.

### Handoff proof (LEGAL-04)

- **CLI requirements.** In Vercel CLI 62.4.0 (`dist/commands/deploy`), `deploy --prebuilt`:
  - requires `.vercel/output`;
  - reads `builds.json` (optional), refuses a recorded build error and refuses a `target` that
    differs from `--prod` / preview;
  - sends the local `vercel.json` as the deployment config.

  That is why the deploy job rebuilds `.vercel/output` from a trusted workspace instead of
  uploading the build job's output.
- **Local simulation.** Build → package → zip → verify → workspace → `vercel build` (no token,
  network blocked) → `check-output`. Compared with LEGAL-03's in-repo `vercel build`:
  - the `static/` output is **byte-identical**;
  - `config.json` is **semantically identical** (only key order differs);
  - `--prod` yields `target: production`.
- **Against the real CI artifact.** The verification was also run against the artifact that this
  PR's CI uploaded (§2 of the PR description).
- **Not proven: an actual `vercel deploy`.** Deploying is not authorized before the project and
  credentials exist. The first preview is the live proof (§3).

### Tests

- **`legal/test/workflow.test.mjs`:** the structure of both workflows. Mutation-checked: 17
  regressions, all caught.
- **`.github/legal-hub/test_artifact.py`:** the verifier, against the real build and malicious
  variants. These include traversal, symlinks, executables, tampering, a wrong
  commit/run/repository, unexpected or oversized files, wrong types, active content, drafts in
  production, a wrong or overlapping project id, a non-empty build setting, a wrong target and
  extra output files.
- **`legal/test/hub.test.mjs`:** content, links, localization, accessibility, the approval model
  and isolation. Links are resolved as Vercel serves them with `cleanUrls` (no implicit `/`).
- **`.github/legal-hub/fixtures/`:** the `config.json` that CLI 62.4.0 really emits for the hub,
  with and without the root rewrite. Routing tests run on them; the routing model reproduces what
  the LEGAL-05 deployment answered (`/` 404, `/index` → `/`, `/es/` → `/es`).
- LEGAL-06 checks were also run against the real LEGAL-05 deployment: `check-deployment` fails it
  (`server-side target 'production'`), and fails a simulated public alias (`200`).

### Remaining limits

- **The shared `VERCEL_TOKEN`.** `vercel-deploy.yml` (the website, not changed here) keeps an
  **account-wide `VERCEL_TOKEN` as a repository secret**. Any same-repository PR can read it by
  editing a workflow, and that token can deploy every project in the account, including the hub.
  Until it is replaced by a project-scoped token for `onchainfest-web-site`, it bounds the
  security of every project in the account.
- **Same project for preview and production.** Vercel tokens can be scoped to a project, but not
  to preview-only deployments (see §3). The preview token could also create a production
  deployment of the hub. The separation between the two lives in GitHub: the preview token
  exists only in `legal-hub-preview`, and the trusted preview job never passes `--prod`.
- **Branch protection.** `main` has no branch protection or rulesets (§3). Anyone with write
  access can push to `main`. For production, the human gate is the environment's required
  reviewers.
- **The `GITHUB_TOKEN` with `actions: read`.** Its ability to read environments and
  deployment-branch policies is unverified in CI. If it cannot, the job fails closed, and the
  first preview run settles it.

## 3. One-time setup (owner; none of this is done by LEGAL-04)

### 3.1 Vercel

1. **Log in.** The local CLI token expired on 2026-10-18; log in again first.
2. **Create the project.** Project `onchainfest-legal` in `victor-valverdes-projects`:
   - framework **Other**;
   - Root Directory **empty**;
   - Build, Install, Output and Dev **overrides off/empty**. `check-link` refuses any non-empty
     value.
   - **Do not connect Git.**
   - Deployment Protection: Vercel Authentication on previews.
   - A new project's first deployment becomes production with a public `*.vercel.app` domain,
     whatever the CLI asks for. The preview job therefore refuses a project without a production
     deployment (`check-project`). `onchainfest-legal` already has one (LEGAL-05, behind
     authentication); a re-created project would need its first deployment made deliberately.
3. **Create the tokens.** Account Tokens → *Scope*: the team, then **the project**
   `onchainfest-legal` (a project-scoped token, prefix `vcp_`). Vercel documents project scope
   for access tokens at `vercel.com/docs/accounts/access-tokens` (checked 2026-10-21).
   - Create **two** short-lived tokens: `legal-hub-preview` and `legal-hub-production`.
   - **Unverified:** whether CLI 62.4.0's `pull` and `deploy` work with a project-scoped token.
     It must be confirmed on the first preview. If it fails, use a team-scoped token and record
     the wider blast radius.

### 3.2 GitHub (Settings → Environments; repository secrets stay unchanged)

1. **Environment `legal-hub-preview`.**
   - Deployment branches: **Selected branches → `main`** only.
   - Environment secrets:
     - `VERCEL_LEGAL_TOKEN`: the preview token;
     - `VERCEL_LEGAL_PROJECT_ID`: `prj_…`.
2. **Environment `legal-hub-production`.**
   - **Required reviewers** (the owner).
   - Optionally, *Prevent self-review* once there is a second maintainer. With a single
     maintainer, self-approval is the explicit human step.
   - Deployment branches: `main` only.
   - Environment secrets: `VERCEL_LEGAL_TOKEN` (the production token) and
     `VERCEL_LEGAL_PROJECT_ID`.
3. **Verify the environments.**
   ```sh
   gh api repos/OnChainFest/Onchainfest-WebSite/environments/legal-hub-preview \
     --jq '{policy: .deployment_branch_policy, rules: [.protection_rules[].type]}'
   gh api repos/OnChainFest/Onchainfest-WebSite/environments/legal-hub-preview/deployment-branch-policies \
     --jq '[.branch_policies[] | "\(.type):\(.name)"]'        # must be ["branch:main"]
   gh api repos/OnChainFest/Onchainfest-WebSite/environments/legal-hub-production \
     --jq '[.protection_rules[].type]'                          # must include "required_reviewers"
   ```
4. **The legacy `VERCEL_LEGAL_PROJECT_ID` repository secret** (LEGAL-01/03) is no longer read.
   Do not create it.

### 3.3 Branch protection for `main` (recommended; not applied)

Settings → Rules → Rulesets → New branch ruleset, target `main`:

- Restrict deletions; block force pushes.
- Require a pull request before merging. With one maintainer, set 0 required approvals but keep
  the PR requirement.
- Require status checks to pass:
  - `legal hub build` (legal-hub);
  - `foundation (node 22)`, `foundation (node 24)` (ci);
  - `image (api)`, `image (worker)` (containers);
  - `vercel preview` (vercel-deploy), only if every PR should run it.
- Require branches to be up to date before merging.
- **Bypass list:** empty, or the owner for emergencies only.

### 3.4 Activate the preview (only after §3.1–3.3)

1. Set the repository variable `LEGAL_HUB_PREVIEW_ENABLED=true`. Leave
   `LEGAL_HUB_PRODUCTION_ENABLED` **undefined**.
2. Open a PR that touches `legal/**`. `legal-hub` builds, then `legal-hub-deploy` → `preview`
   runs.
3. Check that the run passed every guard, including `check-project` and `check-deployment`.
   Then check the preview URL:
   - Vercel Authentication;
   - the 8 routes plus the 404;
   - CSP and `X-Robots-Tag: noindex`;
   - the draft banners.

### 3.5 Domain, DNS, production (only after §5 legal approval)

1. Add `legal.onchainfest.xyz` to the project.
2. In GoDaddy, add `CNAME legal → <value shown by Vercel>`. Do not touch the apex, `www` or MX.
3. Set `LEGAL_HUB_PRODUCTION_ENABLED=true`. A push to `main` touching `legal/**` builds, waits
   for the reviewer, verifies in production mode and deploys.
4. **Plan:** Vercel's Hobby plan is for non-commercial use. Confirm the plan that fits OnChainFest
   LLC.

Before step 1: the project's production deployment today is the LEGAL-05 preview content
(drafts). Assigning a domain to the project attaches it to that deployment. Do not add the domain
until an approved production deployment exists (production job), or promote it in the same step.

Rollback: remove the domain from `onchainfest-legal`, or promote the previous deployment. The
website is unaffected either way.

### 3.6 Remediation: a preview became production or is publicly reachable

`check-deployment` failed with `SECURITY:`. The deployment exists; the job does not clean up, on
purpose (deleting a production deployment automatically could take the wrong thing down and
would make the next preview the project's "first" deployment again).

1. **Stop new previews:** set `LEGAL_HUB_PREVIEW_ENABLED=false` (or delete it).
2. **Cut public access**, using the URLs named in the error:
   - a project production domain (for example `onchainfest-legal.vercel.app`): Vercel →
     `onchainfest-legal` → Settings → Domains → remove it;
   - an alias still attached to the deployment:
     `vercel alias rm <alias> --scope victor-valverdes-projects --yes`.
   Keep the deployment itself (it stays behind Vercel Authentication at its unique URL).
3. **Verify** without credentials: each removed host answers `404` with
   `x-vercel-error: DEPLOYMENT_NOT_FOUND`; the unique URL and remaining aliases answer `302` to
   `https://vercel.com/sso-api`.
4. Find the cause (`check-project` should have prevented a first deployment; Deployment
   Protection settings; a domain added to the project) before re-enabling previews.

LEGAL-05 followed exactly these steps (domain removed, then the alias, both verified).

## 4. Linking the hub from other properties (separate, later changes)

- **www.onchainfest.xyz footer and `contact.html`**: add a "Legal" link to
  `https://legal.onchainfest.xyz`. This is a production change to the website. Do it as its
  own phase, after the hub is live.
- **ListaLaBoda**: optional link from its legal pages to the hub. Its test
  `src/test/legal-pages.test.ts` requires "OnChainFest" to appear exactly once, so that is a
  deliberate change in that repository.

## 5. Legal review register (open facts)

Each item renders as a "Pending legal review" callout until it is resolved in `legal/src/`.

| Key               | Where                     | Needed from owner / counsel                                         |
| ----------------- | ------------------------- | ------------------------------------------------------------------- |
| `REGISTRATION`    | Overview, Terms, Privacy  | Resolved in LEGAL-08B (Wyoming, Filing ID); see the last section    |
| `ADDRESS`         | Overview, Terms, Privacy  | Registered address, address for legal notices                       |
| `LEGAL_CONTACT`   | Terms, Privacy            | Official legal/privacy contact (today: `vicvalch@onchainfest.xyz`)  |
| `PRECEDENCE`      | Terms, Privacy            | Relationship and precedence between corporate and product documents |
| `DIGITAL_ASSETS`  | Terms                     | Disclosures for the `$BRT` ecosystem token mentioned on www         |
| `LIABILITY`       | Terms                     | Warranty disclaimer and limitation of liability                     |
| `GOVERNING_LAW`   | Terms                     | Governing law, courts, dispute resolution/arbitration               |
| `PRIVACY_REGIMES` | Privacy                   | Applicable laws (e.g. CR Law 8968, GDPR, CCPA), legal bases         |
| `PROCESSORS`      | Privacy                   | Confirm providers and roles (stated: Vercel, GoDaddy)               |
| `TRANSFERS`       | Privacy                   | International transfers and safeguards                              |
| `RETENTION`       | Privacy                   | Retention periods                                                   |
| `RIGHTS`          | Privacy                   | Rights by jurisdiction, response times, supervisory authority       |
| `CHILDREN`        | Privacy                   | Minimum age, minors' data                                           |

Also for counsel:

- Every sentence of the drafts (`legal/src/documents.mjs`), including the drafted clauses on
  acceptable use, intellectual property and the "not an offer"-style wording.
- The Spanish wording, and which language prevails.
- The effective dates. They are set only at approval, never in advance.

Verified facts the drafts rely on:

- OnChainFest LLC operates listalaboda.com. Both ListaLaBoda legal pages say so.
- `vicvalch@onchainfest.xyz` is the published contact on www.
- The www contact form is `mailto:` with the fields name, email, organization, type and message.
- www sets no cookies and loads no analytics or third-party scripts. It is HTTPS-only with HSTS
  (checked 2026-10-21).
- The site is hosted on Vercel. The domain uses GoDaddy nameservers, and its MX records point to
  `secureserver.net`.

## 6. Stripe integration plan (documentation only; live Stripe untouched)

### 6.1 Legal URLs

| Purpose                            | URL                                                           |
| ---------------------------------- | ------------------------------------------------------------- |
| OnChainFest LLC legal hub          | `https://legal.onchainfest.xyz/`                              |
| Corporate Terms of Use             | `https://legal.onchainfest.xyz/terms` (es: `/es/terms`)       |
| Corporate Privacy Policy           | `https://legal.onchainfest.xyz/privacy` (es: `/es/privacy`)   |
| ListaLaBoda directory entry        | `https://legal.onchainfest.xyz/products/listalaboda`          |
| ListaLaBoda Terms                  | `https://listalaboda.com/terminos`                            |
| ListaLaBoda Privacy                | `https://listalaboda.com/privacidad`                          |
| ListaLaBoda refunds/cancellations  | `https://listalaboda.com/terminos#reembolsos-y-cancelaciones` |

Do not point Stripe at the corporate URLs until those documents are approved.

### 6.2 Current state (from listalaboda.com)

- The Stripe account's public details are meant to be ListaLaBoda-branded: name, support email
  `soporte@listalaboda.com`, and the Terms and privacy URLs above. The legal entity stays
  OnChainFest LLC (`docs/operations/BILLING-STRIPE-DASHBOARD.md`).
- `createPortalSession` (`src/lib/billing/stripe-gateway.ts`) calls
  `billingPortal.sessions.create({ customer, return_url })` without `configuration`, so it uses
  the account's **default** portal configuration.

### 6.3 Brand-specific Customer Portal

While the account serves only ListaLaBoda, the default configuration is enough. Once a second
OnChainFest product bills through the **same** account:

- Create one portal configuration per brand (`billing_portal.configurations`). For ListaLaBoda:
  - `business_profile.headline`
  - `business_profile.terms_of_service_url = https://listalaboda.com/terminos`
  - `business_profile.privacy_policy_url = https://listalaboda.com/privacidad`
  - Features as today: cancel at period end, update payment method.
- Move the account-level public details to OnChainFest LLC and the hub URLs, so they are neutral
  across brands.
- Check whether Checkout's account-level Terms consent link needs per-brand text
  (`custom_text.terms_of_service_acceptance`). Verify against the current Stripe documentation
  before relying on it.
- Some details stay account-level: the support email and phone shown on receipts and Checkout,
  and the statement descriptor (`statement_descriptor_suffix` can vary it per charge). If
  per-brand support identity is required, a **separate Stripe account per brand** (Stripe
  organizations) is the cleaner option. That is an owner decision.

### 6.4 Portal configuration ID handling (ListaLaBoda change, not done here)

- New server-only variable, `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`.
- Validate it like the price IDs (`^bpc_[A-Za-z0-9]+$`) in `src/lib/billing/config.ts`.
- Read it only in `stripe-gateway.ts`, then pass `configuration` to
  `billingPortal.sessions.create`.
- Test mode and live mode have **different** `bpc_` IDs. Set it per Vercel environment and
  never hard-code it.
- Fail closed in production once multi-brand is active: no configuration means no portal
  session. Before that, falling back to the default is acceptable.
- Extend the local Stripe stand-in and the e2e checks to assert the `configuration` parameter.

### 6.5 Support email requirements

- `soporte@listalaboda.com` must **receive** mail before it appears in Stripe (Resend only
  sends). Set up the MX records and an inbox or forwarding first. The same is required by
  ListaLaBoda's own Terms.
- For OnChainFest LLC, decide a role address for legal and privacy requests (`LEGAL_CONTACT`)
  instead of a personal mailbox. Use it in the hub and in the account-level public details if
  they move to OnChainFest LLC.

## LEGAL-08B — Owner-verified formation facts (draft only; 2026-10-21)

From the original formation documents provided by the owner (not committed to this repository):

- OnChainFest LLC was formed in Wyoming, United States, on July 18, 2025, Wyoming Filing ID
  `2025-001725151`.
- The original Articles of Organization named Registered Agents Inc as registered agent, at
  30 N Gould St, Ste R, Sheridan, WY 82801. The drafts show this only as historical information.

Still to verify independently before legal approval:

- that the Wyoming registration is active;
- the current registered agent and a legally acceptable address for notices (`ADDRESS` stays
  open);
- the official legal and privacy contact (`LEGAL_CONTACT` stays open).

Corporate source documents, tax identifiers and members' personal records are never committed to
this repository or published. The corporate-site drafts do not cover the sports platform, and the
other review questions (§5) remain open. The draft, `noindex` and publishability gates continue to
fail closed.
