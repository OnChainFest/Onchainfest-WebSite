# BRT-00 — Salvage Matrix

This matrix classifies every material legacy component found in BRT-00. Evidence and findings are in [`BRT-00-REPOSITORY-ARCHAEOLOGY.md`](./BRT-00-REPOSITORY-ARCHAEOLOGY.md); security IDs (C-x, H-x, M-x, L-x, I-x) refer to its §18.

## Legend

**Status** uses these values:

- `IMPLEMENTED`
- `PARTIALLY_IMPLEMENTED`
- `MOCKED`
- `DOCUMENTED_ONLY`
- `PLANNED`

**Classification** uses these values:

- **REUSE**: lift the concept, configuration or vocabulary nearly unchanged. Install stock libraries fresh; do not copy files.
- **ADAPT**: the design is sound and the implementation needs specific changes.
- **REWRITE**: the capability is needed but the legacy code is unfit, so it is kept as a spec only.
- **REFERENCE_ONLY**: consult it for ideas or UX; build nothing from it.
- **DISCARD**: no value, or actively harmful.

**Security risk** uses this scale:

- CRITICAL
- HIGH
- MEDIUM
- LOW
- NONE

**Target module numbering** (from the [capability map](../architecture/BRT-TARGET-CAPABILITY-MAP.md)):

| # | Module | # | Module | # | Module |
|---|---|---|---|---|---|
| M1 | Athlete Passport | M8 | Sports Oracle / Verification | M15 | Provider Marketplace |
| M2 | Organization / Federation Identity | M9 | Achievement Registry | M16 | Officials / Referee Network |
| M3 | Sports Ontology | M10 | Records | M17 | Venue Network |
| M4 | Competition & Event Engine | M11 | Rankings | M18 | Media / Historical Archive |
| M5 | Participation / Registration | M12 | Prize Rail / Escrow / Settlement | M19 | AI Officiating Foundation |
| M6 | Match / Result Engine | M13 | Trophy House | M20 | Administration / Governance |
| M7 | Evidence Layer | M14 | Sponsor Marketplace | M21 | External API / Developer Platform |

---

## Poker

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../Poker | `contracts/simplified_brt_contract.txt` (SimplifiedBRTPoker) | Participation, champion, silver and bronze ERC-721 BRTs; per-position quantity and value; RLUSD redemption from a treasury allowance | M13 Trophy House, M12 Prize Rail | DOCUMENTED_ONLY (source only; never built, deployed or tested) | REFERENCE_ONLY | HIGH (H-8, M-5, L-1, L-3) | Keep the tier semantics and the redeemed-flag CEI pattern as a spec. Re-express them as trophy classes minted from verified achievements, with value held in collateralized escrow. |
| ../Poker | `supabase_schema.sql` (`tournaments`, `players`, `tournament_invitations`, `tournament_registrations`, `prize_distributions*`) | Tournament lifecycle enum; registration and payment status machine; final position, prize and tx hash per registration | M4, M5, M12 | DOCUMENTED_ONLY (schema; few writers) | ADAPT | CRITICAL (C-9) | Use the table shapes as input to the BRT-01 ontology. Drop `coinbase_wallet_credentials` and the Costa Rica defaults. Enable RLS on every table and make tx hashes unique. |
| ../Poker | `supabase_schema.sql` `players.coinbase_wallet_credentials` | Planned custodial wallet storage | — | DOCUMENTED_ONLY | DISCARD | CRITICAL (pattern) | Never store keys or credentials in the app DB. |
| ../Poker | `supabase_schema.sql` `admin_users` | Admin accounts with password hashes | M20 | DOCUMENTED_ONLY (never checked) | DISCARD | CRITICAL (C-9) | Use a real auth provider and roles. |
| ../Poker | `email_database_schema.sql` | Email templates and queue | Platform notifications | DOCUMENTED_ONLY (conflicts with main schema) | REFERENCE_ONLY | LOW | The queue/template concept only. |
| ../Poker | `payment_monitor_service.ts` (repo root) | Polls ERC20 Transfer logs with viem `getLogs` and matches them to pending registrations | M5, M12 | IMPLEMENTED (unwired) | ADAPT | HIGH (H-10) | Match on a per-registration reference, add idempotency on tx hash, confirmations and reorg handling, and run as a server worker. |
| ../Poker | `payment_webhook_api.ts` | `/api/payment-monitor` trigger | M12 | PARTIALLY_IMPLEMENTED (not placed in `src/app/api`) | DISCARD | MEDIUM (M-7) | Use a scheduled worker instead. |
| ../Poker | `src/hooks/usePaymentMonitor.ts` | Payment monitor UI data | — | MOCKED (`Math.random`) | DISCARD | HIGH (H-15) | — |
| ../Poker | `src/lib/flexible-nft-service.ts` | BRT mint/config from the admin UI | — | MOCKED (logs "Demo") | DISCARD | HIGH (H-15) | — |
| ../Poker | `src/lib/flexible_nft_service.ts` | viem write client for BRT with admin hot key | M13 | PARTIALLY_IMPLEMENTED (unimported; ABI mismatch) | REFERENCE_ONLY | CRITICAL (latent hot admin key; C-9 context) | The simulate → write → receipt pattern only. Redemption must be user-signed. |
| ../Poker | `src/lib/web3-config.ts`, `src/components/Web3Provider.tsx` | Reown AppKit and wagmi on Base / Base Sepolia; RLUSD config | M1 | PARTIALLY_IMPLEMENTED (provider never mounted) | REFERENCE_ONLY | LOW (placeholder addresses, I-2) | Prefer the padelflow wagmi config. |
| ../Poker | `src/app/register/page.tsx`, `src/app/register/[inviteCode]/page.tsx` | Invite-code registration with zod, wagmi and Supabase | M5 | PARTIALLY_IMPLEMENTED (dynamic route file is 0 bytes) | REWRITE | HIGH (random wallet addresses, H-15) | Keep invite validation as a UX reference. |
| ../Poker | `src/app/admin/*`, `src/components/*Dashboard*` | Admin payments, emails and NFT dashboards | M20 | MOCKED | DISCARD | CRITICAL (no auth; C-9 context) | — |
| ../Poker | `email_service.ts`, `email_service_complete.ts`, `email_api_routes.ts` | Resend email templates (ES, poker) | Notifications | PARTIALLY_IMPLEMENTED (unwired) | REFERENCE_ONLY | MEDIUM (open relay if wired, M-7) | Template copy only. |
| ../Poker | `src/hooks/useEmailAutomation.ts`, `src/components/EmailDashboard.tsx` | Email sends and logs | — | MOCKED | DISCARD | HIGH (H-15) | — |
| ../Poker | `contracts/blockchain-app-fixed.html` | Generic MetaMask ETH send demo | — | IMPLEMENTED (unrelated) | DISCARD | NONE | — |
| ../Poker | Root duplicates (`layout_tsx.ts`, `next_config.js`, `page_backup.tsx`, `*_complete.ts`, `cron_job_setup.sh`) | Alternate versions | — | — | DISCARD | LOW | — |

## poker-tournament-backend

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../poker-tournament-backend | `contracts/PrizeDistribution.sol` | USDC pool with fixed 50/30/20 bps split; owner registers payments and submits winners; push payout plus claim | M12 | IMPLEMENTED (untested; Remix-only) | REWRITE | CRITICAL (C-6, C-7, H-1, H-7) | Keep only the bps split and stats view idea. Use it as an anti-pattern checklist for the Prize Rail. |
| ../poker-tournament-backend | `src/lib/prize-service.ts` | viem client on Base mainnet; admin key signing | M12 | PARTIALLY_IMPLEMENTED | REFERENCE_ONLY | HIGH (H-9, M-3) | — |
| ../poker-tournament-backend | `src/lib/prize-integration.ts` | payment → register → distribute → notify flow | M12 | PARTIALLY_IMPLEMENTED (missing import) | REFERENCE_ONLY | LOW | Describes the intended settlement sequence. |
| ../poker-tournament-backend | `src/components/PrizeDashboard.tsx`, `src/app/admin/prizes/page.tsx` | Admin types 3 winner addresses and distributes | M20 | PARTIALLY_IMPLEMENTED | DISCARD | HIGH (H-9; no auth) | — |
| ../poker-tournament-backend | `hrkey-promo-jungle/*` | HRKey promo form | — | IMPLEMENTED (unrelated) | DISCARD | HIGH (H-16) | — |

## padelflow

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../padelflow | `contracts/PadelFlowNFTTrophy.sol` | ERC-721 trophy; per-(recipient, tournament) duplicate guard; batch mint; pause; per-tournament token index | M13 | PARTIALLY_IMPLEMENTED (source; does not compile with pinned OZ 5; not deployed) | ADAPT | MEDIUM (M-4, M-11; owner-only mint H-1) | Replace `Counters`; use AccessControl ISSUER/MINTER; key by achievement id and attestation digest; guard per (competition, place); names off-chain; add revoke/supersede; decide soulbound. |
| ../padelflow | `contracts/addresses.json`, `hardhat.config.js`, `scripts/deploy/*.ts` | Network matrix (Base, Base Sepolia, XRPL EVM 1440002); deploy and mint scripts | M13, platform | DOCUMENTED_ONLY (no deployments) | ADAPT | LOW (deployer is owner) | Reuse the network values; deploy scripts must set a multisig or role admin. |
| ../padelflow | `lib/ipfs/metadata.ts`, `lib/ipfs/pinata.ts`, `lib/ipfs/upload-trophy-metadata.ts` | ERC-721 metadata generation (attributes) and Pinata upload | M13, M9, M18 | IMPLEMENTED | ADAPT | LOW | Neutral branding; add achievement id, verification level, issuer and evidence/attestation references. |
| ../padelflow | `lib/wallet/config.ts`, `lib/wallet/useWallet.ts`, `lib/wallet/mintTrophy.ts`, `components/wallet/*`, `components/providers/WalletProvider.tsx` | wagmi (Coinbase Smart Wallet, MetaMask, WalletConnect) on Base / Base Sepolia; client-side mint | M1 | PARTIALLY_IMPLEMENTED (not mounted) | ADAPT | LOW | Pin versions, add SIWE, parameterize chains, and move minting to the issuer service. |
| ../padelflow | `lib/wallet-service.ts`, `app/api/create-wallet/route.ts`, `scripts/create-wallet-and-validation-tables.sql` (`player_wallets`) | Custodial wallet generation storing plaintext private key and mnemonic | — | IMPLEMENTED (route broken) | DISCARD | CRITICAL (C-2) | Never reuse. |
| ../padelflow | `public/mvp/web3-integration.js` | ethers v5 CDN mint flow for the static MVP | M13 | MOCKED (empty Pinata JWT, placeholder address) | REFERENCE_ONLY | LOW | UX flow reference: organizer enters wallet → marks redeemed → mints. |
| ../padelflow | `public/mvp/app.js` (wizard, formats, prize schemes, trophy status) | Padel format config: americano, round-robin by pairs, elimination, sets, super tie-break; prize pool, % or NFT | M3, M4, M12 | MOCKED (localStorage) | REFERENCE_ONLY | MEDIUM (fake auth flag) | Input to the discipline/format vocabulary in BRT-01. |
| ../padelflow | `public/mvp/i18n.js` | EN/ES/PT dictionaries | Cross-cutting | IMPLEMENTED | REUSE | NONE | Translation seed material. |
| ../padelflow | `scripts/create-results-system-fixed.sql` (`player_series`, `player_standings`, `tournament_events`, `player_achievements`, triggers) | Results → standings recompute → threshold achievements → public event feed | M6, M9, M11, M18 | IMPLEMENTED (bowling) | REWRITE (pattern as reference) | CRITICAL (C-3 via permissive RLS) | Generalize to per-discipline result schemas and rule-driven achievements with provenance. |
| ../padelflow | `scripts/SETUP_SUPABASE_COMPLETE.sql` and 26 other SQL scripts | Tournaments, players (bowling fields), brackets, rounds, standings, auth and audit tables | M4, M5 | IMPLEMENTED (conflicting, no migrations) | REWRITE | CRITICAL (C-3) | Do not port. Use as field-level evidence of what organizers needed (e.g. emergency contacts, categories). |
| ../padelflow | RLS policies (all scripts) | Access control | M20 | IMPLEMENTED (permissive) | DISCARD | CRITICAL (C-2, C-3) | Rewrite from roles. |
| ../padelflow | `app/api/register-player/route.ts` | Public registration with duplicate-email check | M5 | IMPLEMENTED (bowling fields) | ADAPT (flow) / REWRITE (schema) | MEDIUM | — |
| ../padelflow | `app/api/brackets/*`, `components/tournament-brackets.tsx` | Bracket rows and manual player assignment | M4 | PARTIALLY_IMPLEMENTED (no pairing or advancement) | REWRITE | HIGH (H-4) | — |
| ../padelflow | `app/api/results/*` | Result entry, rounds, standings, player profile | M6 | IMPLEMENTED (bowling; unauthenticated writes) | REWRITE | HIGH (H-4) | — |
| ../padelflow | `app/player-profile/[id]/page.tsx` | Player profile (series, achievements, standings) | M1 | IMPLEMENTED | REFERENCE_ONLY | LOW | Passport UX reference. |
| ../padelflow | `app/api/stripe/webhook/route.ts`, `app/api/stripe/create-checkout/route.ts`, `lib/stripe-config.ts`, `lib/stripe-client.ts` | Stripe checkout and signature-verified webhook | M5, M12 (fiat in) | IMPLEMENTED | ADAPT | MEDIUM (M-1) | Use a service-role server client, an event-id idempotency table and generic line items. |
| ../padelflow | `lib/payment-utils.ts` (+ tests) | CRC/USD bowling packages and early-bird pricing | — | IMPLEMENTED | DISCARD | NONE | Event-specific. |
| ../padelflow | `app/api/update-payment/route.ts`, `update-payment-amount` | Manual payment verification | M5 | IMPLEMENTED (unauthenticated) | REWRITE | HIGH (H-6) | — |
| ../padelflow | `lib/auth.ts`, `lib/auth-production.ts`, `app/api/auth/*`, `components/auth-guard.tsx`, `components/simple-auth-guard.tsx`, `middleware.ts` | Admin authentication (3 variants) | M20 | IMPLEMENTED (insecure) | DISCARD | CRITICAL (C-4, H-2, H-3) | — |
| ../padelflow | `app/admin/*` | Admin console | M20 | IMPLEMENTED (unguarded `/admin`) | REFERENCE_ONLY | HIGH (H-6) | Organizer workflow reference. |
| ../padelflow | `app/api/export/*`, `lib/export-utils.ts` | CSV exports | M20, M21 | IMPLEMENTED (fake bearer auth) | ADAPT (`export-utils` only) | HIGH (H-5) | — |
| ../padelflow | `app/api/tournament-stats` (+ variants) | Tournament statistics | M11, M20 | IMPLEMENTED | REFERENCE_ONLY | LOW | — |
| ../padelflow | `components/qr-share-modal.tsx`, `components/floating-qr-button.tsx` | Share page URL as QR | M5 | IMPLEMENTED | REFERENCE_ONLY | NONE | — |
| ../padelflow | `validation_qrs` table | QR check-in | M5 | DOCUMENTED_ONLY (dropped by `remove-qr-tables.sql`) | REFERENCE_ONLY | LOW | — |
| ../padelflow | `app/api/send-confirmation-email/route.ts` | Confirmation email | Notifications | MOCKED | DISCARD | LOW | — |
| ../padelflow | `app/page.tsx` pricing | Organizer plans ($19.99, $49/mo) | M20 (commercial) | DOCUMENTED_ONLY | REFERENCE_ONLY | NONE | — |
| ../padelflow | `lib/logger.ts`, `lib/error-handler.ts` | Logging and error handling | Platform | IMPLEMENTED | ADAPT | LOW | — |
| ../padelflow | `lib/rate-limit.ts` | In-memory rate limit | Platform | IMPLEMENTED | REWRITE | LOW (L-2) | Use a shared store. |
| ../padelflow | `.github/workflows/ci.yml` | Lint, jest and build CI | Platform | IMPLEMENTED | ADAPT | NONE | Add contract tests. |
| ../padelflow | ~45 debug, setup and guide pages and routes | Diagnostics | — | IMPLEMENTED | DISCARD | LOW (L-6) | — |

## Sports / PadelChain / StrikeChain

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../PadelChain (= ../StrikeChain = ../Sports) | `packages/contracts/StrikeChainEventManager.sol` | Sponsor-funded ERC20 escrow for 3 prizes; open registration; solo or team events; sponsor submits winners; push payout with team split; emergency withdraw | M12, M4, M14 | IMPLEMENTED (untested; no build config) | REWRITE (REFERENCE_ONLY for the data model) | CRITICAL (C-5, H-1, H-12, M-2) | Keep the sponsor/team/prize-tier shape as spec input only. |
| ../PadelChain | `packages/contracts/ERC20.sol` (TestToken) | Testnet ERC20 with public faucet | Test tooling | IMPLEMENTED | ADAPT (test-only) | LOW (L-7) | Never deploy outside a testnet. |
| ../Sports | `packages/contracts/foundry.toml`, `remappings.txt`, `.github/workflows/test.yml`, `lib/forge-std` | Foundry scaffold and CI | Platform (contracts) | IMPLEMENTED (template) | REUSE | NONE | Initialize fresh with the same layout. |
| ../PadelChain | `apps/web/app/**` (landing, signup, organizer create/dashboard, participant dashboard, tournament/[id], manage, browse) | Organizer and participant flows; discovery | M4, M5, M14 | MOCKED (hard-coded arrays, `console.log` submit) | REFERENCE_ONLY | HIGH (H-15) | Information architecture and flow reference for UX design. |
| ../PadelChain | `apps/web/components/ui/*` | shadcn/ui primitives | Platform UI | IMPLEMENTED (stock) | REUSE | NONE | Install fresh. |
| ../PadelChain | `apps/web/lib/wallet-mock.ts`, `apps/web/contexts/wallet-context.tsx` | Wallet connect | — | MOCKED (random address) | DISCARD | HIGH (H-15) | — |
| ../PadelChain | `apps/web/components/wallet-provider.tsx`, `apps/web/lib/wallet-config.ts` | wagmi v1/v2 mix | — | Dead code | DISCARD | LOW | — |
| ../PadelChain | Landing and diagram components (`flow-diagram`, `process-circle`) | Marketing visuals | Marketing | IMPLEMENTED | REFERENCE_ONLY | NONE | Copy promises "verified results" that the code does not deliver. |
| ../PadelChain | Root `turbo.json`, `package.json` | Turbo monorepo config | Platform | IMPLEMENTED | REFERENCE_ONLY | LOW (unpinned deps, M-10) | Stack decision belongs to BRT-02. |
| ../PadelChain, ../StrikeChain | `README.md` | NFT achievements, verified results, MongoDB, RainbowKit, Base/USDC | — | DOCUMENTED_ONLY | REFERENCE_ONLY | NONE | Aspirational claims. |
| ../Sports | HEAD `apps/web` | Same UI | — | Broken (routes deleted in `e50bed4`; conflict markers) | DISCARD | LOW | — |
| ../StrikeChain | Entire repository | Duplicate of PadelChain | — | — | DISCARD (duplicate) | — | 150/151 files byte-identical. |

## Art-Tokenization

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../Art-Tokenization | `contracts/BattagliniEscrowNFT.sol` | ETH escrow; `onlyOracle` release; owner refund; oracle rotation events; ERC-721 transfer on purchase | M8, M12 | IMPLEMENTED (tested) | ADAPT (patterns only) | HIGH (H-13, H-14, M-9) | Carry forward the separate oracle role, CEI and nonReentrant, and idempotent close. Replace the bare oracle call with verification of signed attestations. |
| ../Art-Tokenization | `test/BattagliniEscrowNFT.test.ts` | Role rejection and double-settle/refund tests | Platform (contracts) | IMPLEMENTED (reentrancy test empty) | ADAPT | NONE | Template for the Prize Rail and Trophy test matrices. |
| ../Art-Tokenization | `backend/src/services/dhl.ts` | Carrier adapter: parse, status check, tracking lookup | M8 (source adapter) | MOCKED | REFERENCE_ONLY | CRITICAL (C-8: always-true signature) | Adapter interface shape only. |
| ../Art-Tokenization | `backend/src/services/escrowContract.ts` | Oracle relayer: pre-check → gas → send → receipt | M8 | IMPLEMENTED | ADAPT | HIGH (hot key in env) | Use a KMS/HSM signer and submit attestations. |
| ../Art-Tokenization | `backend/src/server.ts` | Webhook, test and admin release endpoints | M8 | IMPLEMENTED | REWRITE | CRITICAL (C-8, M-8) | Raw-body HMAC, replay window, auth; no fund-moving test routes. |
| ../Art-Tokenization | `backend/src/types/index.ts` | Normalized payload and `DeliveryStatus` enum | M7, M8 | IMPLEMENTED | REFERENCE_ONLY | NONE | Precedent for normalized evidence types. |
| ../Art-Tokenization | `hardhat.config.ts`, `scripts/deploy.ts` | Base / Base Sepolia deploy | Platform | IMPLEMENTED | REFERENCE_ONLY | MEDIUM (oracle and safe fall back to deployer) | — |
| ../Art-Tokenization | `frontend/src/*` | MetaMask purchase UI | — | IMPLEMENTED | REFERENCE_ONLY | LOW | — |
| ../Art-Tokenization | `README.md` production checklist | Gap list (secrets manager, auth, HMAC) | Platform | DOCUMENTED_ONLY | REFERENCE_ONLY | NONE | "Trustless" claim is false. |

## Other repositories

| Legacy Repository | Legacy File / Component | Observed Capability | Target Bragging Rights Module | Implementation Status | Classification | Security Risk | Recommendation |
|---|---|---|---|---|---|---|---|
| ../Onchainfest-WebSite | `index.html` (git history: $BRT section) | Original BRT definition: champion NFT carrying tournament id, season and winner wallet; showcase and trade | M13, M9 | DOCUMENTED_ONLY | REFERENCE_ONLY | NONE | Resolve the tradability conflict in BRT-01. |
| ../Onchainfest-WebSite | `vercel.json` | CSP headers | Platform | IMPLEMENTED | REUSE (as baseline) | NONE | — |
| ../Onchainfest-WebSite | `img/brts*`, `img/sports*`, logo | Brand imagery | Marketing | — | REFERENCE_ONLY | NONE | — |
| ../Onchainfest-WebSite | Site HTML and `contact.html` | Studio marketing; mailto contact | — | IMPLEMENTED | DISCARD | LOW | — |
| ../LaNegrita-db | `README.md` | Names the CRCC bowling championship 2025 | M2, M4 (pilot) | DOCUMENTED_ONLY (no data) | REFERENCE_ONLY | NONE | Pilot organization and event candidate. |
| ../OLMO-Site---PeerProof | Entire repository (template and PeerProof pages) | HR/social-proof marketing | — | MOCKED / DOCUMENTED_ONLY | DISCARD | MEDIUM (M-14), LOW (L-8) | Nothing to salvage. |
| ../qr-code-hrke | `pages/api/promo-register.js`, `vercel.json` redirect | QR deep link → server-side registration insert | M5 | IMPLEMENTED | ADAPT (pattern) | MEDIUM (M-12, L-4, L-5) | Sign QR params; add validation, rate limit, dedupe and consent. |
| ../qr-code-hrke | `pages/promo-register.js` | Client-only form | — | IMPLEMENTED | DISCARD | LOW | — |
| ../qr-code-hrke | Git history: `public/promo-register.html` @ `68fc1a6`, `.env.local` @ `6fb817d` | Embedded service-role JWT; committed env | — | — | DISCARD | CRITICAL (C-1), MEDIUM (M-13) | **Owner action: rotate the keys.** |
