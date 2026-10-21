# ONCHAINFEST-LEGAL-01 · Legal hub: deployment, DNS and Stripe

`legal.onchainfest.xyz` is the corporate legal hub of OnChainFest LLC. The source is in
[`legal/`](../../legal/README.md). It is a separate static site, deployed as a **separate Vercel
project** by [`.github/workflows/legal-hub.yml`](../../.github/workflows/legal-hub.yml).

Status at ONCHAINFEST-LEGAL-01: implemented and tested locally. **Not deployed.** No Vercel
project, secret, variable or DNS record exists yet. Both corporate documents are drafts, so a
production build is refused until they are approved (§5).

## 1. Isolation from www.onchainfest.xyz

The public website (Vercel project `onchainfest-web-site`) is unchanged:

| Website safeguard                                       | Effect on `legal/`                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Root `.vercelignore` (`/*` plus a website allowlist)    | `legal/` and `.github/` are outside the allowlist, so they are never uploaded |
| `vercel-deploy.yml` "Verify artifact" step              | Any non-website file in that artifact fails the website deploy             |
| Root `vercel.json`, `.vercelignore`, `vercel-deploy.yml` | Not modified by LEGAL-01                                                   |

`legal/test/hub.test.mjs` checks the `.vercelignore` exclusion with `git check-ignore`.

Note: `vercel-deploy.yml` runs on every pull request, including one that only touches `legal/`.
Such a PR still builds a website preview, and that preview is byte-identical to `main`'s.

## 2. Safeguards in `legal-hub.yml`

1. **Path filters**: `legal/**` and the workflow file only.
2. **Dormant by default**: the preview and production jobs run only when the repository
   variable `LEGAL_HUB_DEPLOY_ENABLED` is `true`. Until then, only the `check` job runs (tests
   and build).
3. **Own project secret**: `VERCEL_LEGAL_PROJECT_ID`. The job fails if it is empty or equal to
   the website's `VERCEL_PROJECT_ID`.
4. **Link check**: after `vercel pull`, the job fails unless `.vercel/project.json` is the legal
   project and its Root Directory is empty.
5. **Runs inside `legal/`**: the website's root `vercel.json` is never read. If the project is
   misconfigured, the build fails; it does not quietly build the website.
6. **Artifact check**: no functions; only the legal hub's files are allowed; every page must
   carry `<meta name="oncf-site" content="legal-hub">`; `contact.html` is refused. This check was
   exercised locally against a good artifact, a leaked `contact.html` and the website's
   `index.html`.
7. **Production gate**: `node scripts/build.mjs --require-publishable` fails while any document
   is a draft or any review marker is open. A Vercel production build (`VERCEL_ENV=production`)
   applies the same gate.
8. **Separate concurrency groups**: `legal-hub-preview-*` and `legal-hub-production`.
9. **Fork PRs**: the job runs only when the head repository is this repository.
10. **Least privilege**: the Vercel secrets are defined only on the deploy jobs. The `check`
    job runs the PR's code without them.

Local CLI caution: the main checkout has a root `.vercel/repo.json` that links the repository to
`onchainfest-web-site`. Never run `vercel` from a checkout without `--project <legal project>`.

## 3. One-time setup (owner, after approval; not done in LEGAL-01)

1. **Vercel**: create project `onchainfest-legal` in scope `victor-valverdes-projects`.
   - Framework preset: Other. Root Directory: **empty**. Do not connect Git (Hobby cannot
     deploy this organization's private repository; deployment goes through the workflow).
   - Build and output settings come from `legal/vercel.json` (`node scripts/build.mjs`,
     output `dist`, `cleanUrls`).
2. **GitHub** (`OnChainFest/Onchainfest-WebSite` → Settings → Secrets and variables → Actions):
   - Secret `VERCEL_LEGAL_PROJECT_ID`: the new project's ID (`prj_…`).
   - `VERCEL_TOKEN` is reused. Confirm that its scope covers the new project.
   - Variable `LEGAL_HUB_DEPLOY_ENABLED=true`, only when previews should start.
3. **First preview**: open a PR that touches `legal/**`. Check the preview URL (protected by
   Vercel Authentication) and the response headers (CSP, `X-Robots-Tag`).
4. **Domain**: in the Vercel project, add `legal.onchainfest.xyz`. Vercel shows the exact DNS
   record to create.
5. **DNS** (GoDaddy; the zone's nameservers are `ns61/ns62.domaincontrol.com`): add
   `CNAME legal → <value shown by Vercel>`. Today `www` uses `cname.vercel-dns.com`. Do not touch
   the apex records, `www` or MX.
6. **Production**: only after §5 is complete. Merging the approved documents to `main` triggers
   the production job.
7. **Plan**: Vercel's Hobby plan is for non-commercial use. The owner should confirm the plan
   that fits OnChainFest LLC's commercial use. This applies to the website too.

Rollback: remove the domain from the `onchainfest-legal` project, or promote the previous
deployment. The website is unaffected either way.

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
| `REGISTRATION`    | Overview, Terms, Privacy  | State/country of formation, registration number                     |
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
