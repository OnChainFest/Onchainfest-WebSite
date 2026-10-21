# OnChainFest LLC legal hub (`legal.onchainfest.xyz`)

ONCHAINFEST-LEGAL-01. A static site, separate from the public website at the repository root, and
deployed as its own Vercel project. No dependencies, no client-side JavaScript.

| Route                   | Content                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `/`                     | Overview: corporate policies, product directory, company    |
| `/terms`                | Corporate Terms of Use (corporate websites only)            |
| `/privacy`              | Corporate Privacy Policy (corporate websites, direct email) |
| `/products/listalaboda` | ListaLaBoda: operator, support, links to its own documents  |
| `/es/...`               | Spanish versions of every route                             |

## Layout

- `src/site.mjs`: verified company facts and the review-marker registry (`REVIEW`).
- `src/documents.mjs`: the corporate documents, per locale, with version and status.
- `src/products.mjs`: the product legal directory. To add a product, add one entry.
- `src/i18n.mjs`: interface strings. To add a locale, add it to `LOCALES` and to every
  string table (the tests enforce parity).
- `src/render.mjs`, `src/build.mjs`, `scripts/build.mjs`: rendering and the build into `dist/`.
- `assets/`: stylesheet, logo, favicon. `vercel.json`: this project's config (not the website's).

## Commands

```sh
node scripts/build.mjs                        # build into legal/dist (drafts allowed, noindex)
node scripts/build.mjs --require-publishable  # production gate
node --test test/*.test.mjs                   # checks
```

## Drafts, review markers and approval

Every document stays `draft` until the owner and counsel approve it. A draft has no
effective date, shows a "not in effect" banner, and every open fact is shown as a
**pending legal review** callout (`{{review:KEY}}`). While anything is open, the whole hub
is `noindex` (meta tag, `robots.txt`, `X-Robots-Tag`), and a production build fails.

To approve a document: resolve its markers in the text, then set `status: 'approved'`, a
plain semver `version` and the real `effectiveDate`. When nothing is open anywhere, remove the
`X-Robots-Tag` header from `vercel.json` (a test keeps it in place until then).

Product documents are never copied here: the product's own site is canonical.

Deployment, DNS and Stripe: `docs/operations/ONCF-LEGAL-01-LEGAL-HUB.md`.
