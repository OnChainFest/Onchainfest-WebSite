# BRT-00 — Repository Archaeology & Reconstruction Baseline

| Field | Value |
|---|---|
| Ticket | BRT-00 |
| Date | 2026-09-28 |
| Scope | Read-only inspection of 11 sibling repositories under `C:\Users\Usuario\source\OnChainFest` |
| Output | Documentation only. No code was written, copied, installed, deployed or committed. |
| Companion docs | [`BRT-00-SALVAGE-MATRIX.md`](./BRT-00-SALVAGE-MATRIX.md), [`../architecture/BRT-TARGET-CAPABILITY-MAP.md`](../architecture/BRT-TARGET-CAPABILITY-MAP.md) |

**Status vocabulary.** Every capability claim below uses one of:

- `IMPLEMENTED` — executable code exists that performs the behaviour (it may still be insecure or untested).
- `PARTIALLY_IMPLEMENTED` — some real code exists, but the flow is incomplete, unwired or broken.
- `MOCKED` — code exists, but it returns fake, random, hard-coded or simulated data while looking real.
- `DOCUMENTED_ONLY` — appears in READMEs, marketing copy, UI text or comments. No executable code.
- `PLANNED` — referenced as a TODO or future phase, with no design artefact beyond that.

**Citation convention.** Paths are relative to this repository, for example `../Poker/contracts/simplified_brt_contract.txt`. Line numbers are given as `L<n>` where useful. Where a finding exists only in git history, the commit SHA is given.

**Secrets.** Where a secret was discovered, this document records its *location* and *class* only. No secret values are reproduced here.

---

## 1. Executive Summary

1. **None of the legacy repositories is a working product.** Across 11 repositories:
   - There is **no deployed contract address** anywhere.
   - There is **no contract test suite** for any contract that matters. The only contract tests are Art-Tokenization's, for a non-sports escrow.
   - **Most user-facing flows are mocked**: random wallet addresses, `setTimeout` "emails", localStorage state, hard-coded tournament arrays.
2. **The original BRT is recoverable only as a design.** It survives as one Solidity file saved as `.txt` (`../Poker/contracts/simplified_brt_contract.txt`) plus a product definition in the git history of `../Onchainfest-WebSite/index.html`.
   - The contract was never compiled in-repo, deployed or tested.
   - Every BRT path the Poker UI reaches is a stub that logs "Demo".
3. **There is effectively one sports codebase lineage, not four.**
   - `../PadelChain` and `../StrikeChain` are byte-identical except for `README.md` (150 of 151 files).
   - Both are snapshots of `../Sports`, whose HEAD is broken: all routes were deleted in commit `e50bed4`, and git conflict markers are committed.
   - Despite its name, PadelChain contains **no padel code**.
4. **padelflow is a rebranded bowling app.** Its real backend (Supabase SQL, results, standings, achievements) is the *Torneo La Negrita CRCC 2025* bowling system: games 0–300, pins, handicap, a `PERFECT_GAME` achievement.
   - The "PadelFlow" part is a static localStorage MVP under `public/mvp/`. It has **no match or scoring engine**.
   - `../LaNegrita-db` is an 80-byte README naming that same bowling event.
5. **Legacy code contains several CRITICAL patterns that must never be carried forward:**
   - **Plaintext private keys and mnemonics** in a Supabase table readable by anyone (padelflow).
   - **World-writable RLS** on results, standings and payments (padelflow).
   - An **API route that echoes the admin password** (padelflow).
   - A **repeatable `emergencyWithdraw` that can drain every event's escrow** (StrikeChain lineage).
   - A **double-payment path** in `PrizeDistribution.claimPrize` (poker-tournament-backend).
   - **Unauthenticated HTTP endpoints that release escrow** (Art-Tokenization).
   - A **Supabase `service_role` JWT committed in git history** (qr-code-hrke, commit `68fc1a6`). This one needs owner action now: rotate the keys (see §18).
6. **Every prize or trophy contract is owner- or organizer-self-certified.** No legacy code has evidence, attestation, dispute, correction or revocation. The primitive the new platform wants (**Result → Evidence → Attestation → Verification → Verified Achievement**) has **no legacy implementation at all**. It must be designed fresh in BRT-01.
7. **The legacy assets most worth salvaging, all as ADAPT and none as REUSE-as-is:**
   - The trophy contract *shape* (`../padelflow/contracts/PadelFlowNFTTrophy.sol`), including its duplicate-award guard.
   - The IPFS metadata generator (`../padelflow/lib/ipfs/metadata.ts`).
   - The wagmi/viem wallet config (`../padelflow/lib/wallet/config.ts`).
   - The Stripe webhook skeleton, which does verify signatures (`../padelflow/app/api/stripe/webhook/route.ts`).
   - The oracle-role separation and adapter pipeline pattern (`../Art-Tokenization/contracts/BattagliniEscrowNFT.sol`, `../Art-Tokenization/backend/src/`).
   - The Poker registration/prize schema shapes (`../Poker/supabase_schema.sql`).
   - The results → standings → achievements trigger pattern (`../padelflow/scripts/create-results-system-fixed.sql`).
   - The BRT tiering concept (participation vs podium, with value redemption).

---

## 2. Repositories Inspected

All 11 repositories were inspected at source level: contracts, SQL, API routes, libraries and pages, plus git history. READMEs were read but never taken as evidence of implementation.

| Repository | Files* | Commits | Date range | Stack | Primary nature |
|---|---|---|---|---|---|
| `../Poker` | 51 | 1 | 2025-08-27 | Next 14, Supabase, wagmi/Reown, viem, Base | Unfinished single-event poker app; holds the original BRT contract |
| `../poker-tournament-backend` | 16 | 3 | 2025-08-28 → 2025-11-08 | Remix-style Solidity, viem, Next fragments | "Fase 4B" extract: `PrizeDistribution.sol` plus an admin UI. Not buildable. |
| `../padelflow` | 357 | 104 | 2025-07-18 → 2026-03-31 | Next 15, React 19, Supabase, Stripe, wagmi v3, Hardhat, Pinata | Bowling registration/results app rebranded as PadelFlow, plus a static MVP and an NFT trophy |
| `../Sports` | 218 | 25 | 2025-05-08 → 2025-05-27 | Turbo monorepo, Next 15 (v0.dev), Foundry | Upstream of the StrikeChain lineage. HEAD is broken. |
| `../PadelChain` | 151 | 8 | → 2025-05-27 | same | Snapshot of Sports at `e9da9aa` plus a README-only rebrand |
| `../StrikeChain` | 151 | 8 | → 2025-05-27 | same | History-rewritten copy of PadelChain; only README.md differs |
| `../Art-Tokenization` | 32 | 1 | 2025-12-04 | Hardhat, OZ 5, Express, ethers v6, Vite | AI-generated art escrow MVP with a DHL "oracle" |
| `../LaNegrita-db` | 1 | 1 | 2025-06-13 | — | README only (bowling championship title) |
| `../Onchainfest-WebSite` | 19 | 151 | 2025-05-20 → 2025-12-02 | Static HTML on Vercel | Studio marketing site; git history holds the original $BRT definition |
| `../OLMO-Site---PeerProof` | 268 | 1 | 2025-09-24 | Purchased Bootstrap template | Marketing HTML for an HR/social-proof product |
| `../qr-code-hrke` | 11 | 34 | 2025-11-08 → 2025-11-09 | Next 14, Supabase | HRKey promo QR landing page and registration API |

\*Files excluding `node_modules`, `.next` and `.git`.

---

## 3. Historical Product Lineage

The chronology below is reconstructed from git histories.

```
2025-05  Sports (Turbo + v0.dev UI + StrikeChainEventManager.sol)       "StrikeChain" product name in code
            ├── snapshot e9da9aa ──► PadelChain  (same SHAs, README rebrand 2025-05-27)
            └── snapshot (authors rewritten) ──► StrikeChain (README rebrand 2025-05-27)
         Sports HEAD e50bed4 deletes all app routes; merges leave conflict markers.

2025-05-20 Onchainfest-WebSite: "Bragging Rights Tokens ($BRTs)" defined as champion-only NFTs
           (tournamentId, season, winner wallet; showcase / trade). Later removed from HEAD.

2025-06-13 LaNegrita-db created (title only: CRCC Bowling Championship 2025 – Torneo La Negrita).

2025-07   padelflow begins life as the La Negrita bowling registration/results app (v0 bot, team).

2025-08-27 Poker: OnChainFest Poker Series I (Costa Rica, Base). SimplifiedBRTPoker ERC-721 written
           (participation + champion/silver/bronze BRTs redeemable for RLUSD). Never deployed.
2025-08-28 poker-tournament-backend: "Fase 4B" PrizeDistribution.sol (USDC 50/30/20 on Base).

2025-09-24 OLMO/PeerProof marketing template (unrelated HR product).
2025-11-08 qr-code-hrke + hrkey-promo-jungle copy inside poker-tournament-backend (HRKey promo).

2025-11-30 → 2025-12-04 padelflow rebranded to PadelFlow: Stripe, MVP wizard, i18n,
           PadelFlowNFTTrophy.sol, IPFS/Pinata, wagmi, XRPL EVM network config.
2025-12-04 Art-Tokenization: single AI-generated commit (escrow + DHL oracle pattern).
2026-03-31 padelflow last commit (Vercel CVE bot PR).
```

**What the lineage shows:**

- **The product idea changed three times.** It went from a sponsor-funded escrow for generic tournaments (StrikeChain), to champion NFTs as bragging rights (website $BRT), to tiered, value-backed BRT NFTs per event (Poker), and finally to an NFT trophy bolted onto an event-management SaaS (padelflow).
- **Each iteration restarted from scratch** in a new repository rather than evolving a shared core. The result is three unrelated prize models (see §13) and two unrelated NFT models (see §16).
- **The real, repeated operational use case** is the Costa Rican bowling championship (La Negrita, CRCC). It is the only event with a working registration, payments and results backend (padelflow's SQL). It is also the pilot candidate most grounded in reality.
- **Sports named in legacy work:**
  - Poker: code.
  - Bowling: code, as padelflow's backend.
  - Padel: MVP configuration only.
  - Tennis, golf, bowling and volleyball: mock data in the StrikeChain UI.
  - Generic "sports": marketing only.
- **No legacy code is sport-agnostic by design.** Each repo hard-codes one sport's scoring, or none.

---

## 4. Original BRT Assets Recovered

### 4.1 Product definition (DOCUMENTED_ONLY)

- **Source:** `../Onchainfest-WebSite/index.html`, git history. It is present in early commits and removed from HEAD. `git log -S"Bragging Rights Tokens"` locates it.
- **Definition:** "Bragging Rights Tokens ($BRTs) are exclusive NFTs awarded only to tournament champions using the OnChainFest system."
- **Fields:** each token includes tournament ID, season and winner wallet.
- **Uses:** tokens could be showcased on public profiles, sold and traded.
- **Spanish copy** frames it as "nueva economía de reconocimiento y legado deportivo".
- **Conflict with the new vision:** a *sellable* trophy stops proving who achieved it. BRT-01 must separate the non-transferable Verified Achievement from any transferable collectible.

### 4.2 `SimplifiedBRTPoker` contract (DOCUMENTED_ONLY: source code, never built or deployed)

- **File:** `../Poker/contracts/simplified_brt_contract.txt`, 296 lines, `pragma ^0.8.19`.
  - Uses Remix-style versioned imports: `@openzeppelin/contracts@4.8.0/...`.
  - Inherits ERC721, ERC721URIStorage, Ownable, ReentrancyGuard and Counters.
  - Token name and symbol: `"OnChainFest Poker BRTs"` / `"BRT-POKER"`.
- **Constructor:** `(tournamentName, rlusdToken, treasuryWallet)`. One tournament per deployment.
- **Token types** (`nftType`):
  - 0 = participation
  - 1 = champion
  - 2 = second (silver)
  - 3 = third (bronze)
- **Participation NFT:** `mintParticipationNFT(player)` (L117), onlyOwner. One per address, enforced through `hasParticipationNFT`.
- **Podium BRTs.** Each position is configured through `BRTConfig{quantity, valuePerNFT, metadataURI, minted, configured}`. Minting:
  - `configureBRTPosition` (L67) and `configureAllBRTPositions` (L91) set the configs.
  - `mintBRTsForWinners(champion, second, third)` (L143) mints and finalizes.
  - `mintBRTsInstant(...)` (L161) overwrites the configs and mints in one call.
  - Each winner receives **`quantity` NFTs**, each carrying `valuePerNFT`.
- **Value and redemption:**
  - `redeemBRT(tokenId)` (L222–232) is token-owner-only and nonReentrant. It sets `redeemed = true` (L229) before calling `IERC20(rlusdToken).transferFrom(treasuryWallet, msg.sender, value)` (L232).
  - **The token's value is backed only by the treasury's ERC20 allowance.** There is no escrow.
  - The `transferFrom` return value is ignored.
- **Finalization:** a `tournamentFinalized` boolean is set by the winner-mint paths. There is no finalization event.
- **Metadata:** placeholder URIs such as `ipfs://participation-metadata/`. No metadata JSON, images or pinning exist (PLANNED).
- **Prize text is inconsistent:**
  - Poker email copy says 50/30/20 (`../Poker/email_service.ts` L234–236).
  - BRT templates imply 10×$5 + 10×$3.50 + 10×$1.50 = $100.

### 4.3 BRT application layer (MOCKED or unwired)

- **Admin page:** `../Poker/src/app/admin/nfts/page.tsx` imports the **stub** `../Poker/src/lib/flexible-nft-service.ts`. The stub says "Métodos placeholder (se implementarán cuando esté el contrato deployado)" (L55), and `mintParticipationNFT` returns `{success:true}` after logging "Demo".
- **Real write service:** `../Poker/src/lib/flexible_nft_service.ts` is a viem client driven by `BRT_ADMIN_PRIVATE_KEY`.
  - **Nothing imports it.**
  - **Its ABI does not match the contract.** It calls `configureBRTsForTournament`, `mintBRTsWithCustomConfig` and `isReadyToMintBRTs`, none of which exist. This implies a lost "FlexibleBRT" contract version.
  - It encodes values with `parseEther` (18 decimals), but RLUSD is configured with 6 decimals (`../Poker/src/lib/web3-config.ts` L66).
  - It signs `redeemBRT` with the admin key, so redemption would revert with "Not owner".
- **Dashboard:** `../Poker/src/components/FlexibleNFTDashboard.tsx` renders static zeros and "Smart contract pendiente de deploy" (L134).
- **Deployment status:** the contract address env var is literally `'0x[pendiente_configurar]'` (`../Poker/src/lib/flexible-nft-service.ts` L84). The RLUSD address is the placeholder `0x1234…7890` (`../Poker/env_example.sh` L27).

### 4.4 BRT data model (DOCUMENTED_ONLY: schema only, nothing writes these fields)

`../Poker/supabase_schema.sql` defines, on `tournament_registrations`:

- `final_position`, `prize_amount_rlusd`, `prize_tx_hash`
- `participation_nft_minted`, `participation_nft_tx_hash`, `participation_nft_token_id`
- `champion_nft_minted`, `champion_nft_tx_hash` (L104–105)

It also defines the tables `prize_distributions` and `prize_distribution_details`, and the `registration_status` enum: `invited → registered → payment_pending → payment_confirmed → nft_minted → completed`.

### 4.5 BRT verdict: implemented vs planned

| BRT element | Status |
|---|---|
| Champion-only NFT concept | DOCUMENTED_ONLY (website history) |
| Participation / champion / silver / bronze tiers | Contract source written. Never deployed. App path MOCKED. |
| RLUSD value backing and redemption | Contract source written. Unbacked (allowance-based). App path broken. |
| Tournament finalization | Contract boolean only. DB status never set. |
| NFT metadata | PLANNED (placeholder URIs) |
| Registrations and invitations | PARTIALLY_IMPLEMENTED. The route file `../Poker/src/app/register/[inviteCode]/page.tsx` is 0 bytes. RPC `increment_invite_usage` is never defined. |
| Payment monitoring (RLUSD `Transfer` logs) | IMPLEMENTED in isolation (`../Poker/payment_monitor_service.ts`, repo root, not part of `src/`). The UI hook is MOCKED: `../Poker/src/hooks/usePaymentMonitor.ts` L31–44 uses `Math.random()`. |
| Final positions, prizes, prize tx hashes, champion NFT tracking | DOCUMENTED_ONLY (schema columns, no writers) |
| Wallet ownership | PARTIALLY_IMPLEMENTED (wagmi connect with no signature/SIWE). The "created" wallets are random hex (`../Poker/src/app/register/page.tsx` L166). |
| Chain | Base / Base Sepolia only. **No XRPL or XRPL EVM reference exists in Poker.** |

**Conclusion.** The original BRT **was never a shipped product**. What survives is:

- a coherent *tiering and redemption idea*;
- a registration/prize schema; and
- a payment-log poller.

None of it carries evidence or verification. That is consistent with the new vision, which demotes NFTs to representations.

---

## 5. Repository-by-Repository Findings

### 5.1 `../Poker`

Covered in §4. Additional points:

- **Loose files.** Many root-level files are misplaced or duplicate Next.js files and are not part of the build:
  - `payment_webhook_api.ts`, `email_api_routes.ts`, `layout_tsx.ts`, `next_config.js`
  - `email_service.ts` and `email_service_complete.ts`
  - `payment_monitor_*.ts`
- **No `src/app/api` directory exists**, so no API route is live.
- **Web3Provider is never mounted.** The active `../Poker/src/app/layout.tsx` is the default create-next-app layout.
- **Mocked subsystems:**
  - Email: `../Poker/src/hooks/useEmailAutomation.ts` L176–183 returns `demo_` message ids.
  - Email UI: `../Poker/src/components/EmailDashboard.tsx` L62–91.
  - Random prizes: `../Poker/email_admin_page.ts` L121–122.
- **Misleading claims:**
  - The homepage claims "✅ Fase 2: Payment Monitor | ✅ Fase 3: Email Automation" (`../Poker/src/app/page.tsx` L43–47).
  - The README claims signature verification (`../Poker/readme_md.md` L142). Neither holds.
- **Schema conflict.** `../Poker/email_database_schema.sql` redefines `email_logs` with `CREATE TABLE IF NOT EXISTS`, so its extra columns are skipped when the main schema runs first. The inserts in `../Poker/email_api_routes.ts` L50–58 would then fail.
- **Tests:** none. Dependencies include next 14.0.4 (outdated) and OZ 4.8.0 with the deprecated `Counters`.

### 5.2 `../poker-tournament-backend`

- **Contract:** `../poker-tournament-backend/contracts/PrizeDistribution.sol` (147 lines, `^0.8.19`, OZ 4.8.0 Remix imports).
  - A single-tournament USDC pool with a fixed 50/30/20 split in basis points.
  - One role: `owner`.
- **Funding is not implemented.** `registerPlayerPayment` (L50–58) is onlyOwner and only increments `totalPrizePool += buyInAmount`. It never pulls tokens, so the pool figure is not tied to the contract balance.
- **Payout:** `distributePrizes` (L61–92) is onlyOwner and nonReentrant. It records `prizeClaimed[winner] = prize` (L78–80) **and** pushes the transfers (L83–85), without zeroing the mapping. `claimPrize()` (L95–103) then pays again. See §18.
- **Emergency path:** `emergencyWithdraw` (L138–142) is guarded by `require(!tournamentActive || block.timestamp > 0)`, which is always true.
- **Off-chain code:**
  - `../poker-tournament-backend/src/lib/prize-service.ts` hard-codes Base mainnet (L2) and reads `PRIZE_ADMIN_PRIVATE_KEY` (L105).
  - That service is constructed inside the `'use client'` component `../poker-tournament-backend/src/components/PrizeDashboard.tsx`.
  - The service uses `formatEther` for 6-decimal USDC (L177, L197–199, L217).
  - `../poker-tournament-backend/src/lib/prize-integration.ts` imports a non-existent `./email-service`.
- **Unrelated content:** `hrkey-promo-jungle/` is an HRKey promo app. Its RLS lets anon SELECT all registrants (`../poker-tournament-backend/hrkey-promo-jungle/supabase-setup.sql` L30–33).
- **Not buildable:** there is no root `package.json` or tsconfig, and no tests.

### 5.3 `../padelflow`

- **Two apps in one repo.**
  - A Next.js 15 app (`app/`, `lib/`, `scripts/*.sql`) that is really the La Negrita bowling system.
  - A static PadelFlow MVP (`public/mvp/*`) with localStorage persistence (`../padelflow/public/mvp/app.js` L2, L665–690, L729–739).
- **Bowling core, IMPLEMENTED:**
  - Player registration with bowling fields: `../padelflow/app/api/register-player/route.ts` L17, L102–113.
  - Game-level results: `player_series.game_1..3 CHECK (0..300)` (`../padelflow/scripts/create-results-system-fixed.sql` L17–42).
  - A standings trigger using `ROW_NUMBER()` ranking.
  - An achievements trigger (`PERFECT_GAME`, `HIGH_SERIES`) and a `tournament_events` feed (same file, about L146–201).
- **Padel:** the MVP only *configures* formats (americano, round-robin by pairs, elimination, best-of-3 sets, super tie-break) in `../padelflow/public/mvp/app.js` L293–393. **There is no match or score engine.** `../padelflow/public/mvp/dashboard.html` L916 lists "Update bracket/standings automatically" as a TODO.
- **Brackets:** PARTIALLY_IMPLEMENTED. `../padelflow/app/api/brackets/create/route.ts` creates bracket rows only. There is no pairing or advancement.
- **Stripe:** IMPLEMENTED, with correct signature verification through `constructEvent` (`../padelflow/lib/stripe-config.ts` L148–156; `../padelflow/app/api/stripe/webhook/route.ts` L31–41).
  - Writes go through the anon client.
  - There is no event idempotency.
  - It is branded "Torneo La Negrita" (`../padelflow/app/api/stripe/create-checkout/route.ts` L80).
- **NFT trophy:** `../padelflow/contracts/PadelFlowNFTTrophy.sol` is covered in §10 and §16.
  - It **will not compile** against the pinned OZ `^5.4.0`, because it imports the removed `Counters.sol` (L8, L22, L25).
  - Every address in `../padelflow/contracts/addresses.json` is empty.
  - There are no contract tests, although `hardhat.config.js` points to a non-existent `./test/contracts`.
- **IPFS:** the server libraries are IMPLEMENTED (`../padelflow/lib/ipfs/pinata.ts`, `metadata.ts`, `upload-trophy-metadata.ts`). The MVP path is MOCKED (`const pinataJWT = ''` falls back to `ipfs://QmPlaceholder...`, `../padelflow/public/mvp/web3-integration.js` L214–219).
- **XRPL EVM:** DOCUMENTED_ONLY. It appears in the Hardhat network config (chainId 1440002) but not in the wagmi chains (`../padelflow/lib/wallet/config.ts` L31).
- **Wallets:**
  - **Custodial:** `../padelflow/lib/wallet-service.ts` L36–48 generates keys and stores them in plaintext. The route `../padelflow/app/api/create-wallet/route.ts` L12 calls a non-existent method name.
  - **Non-custodial:** the wagmi components exist but no page mounts them.
- **Auth:** three inconsistent implementations. Details are in §18.
- **Noise:** about 45 debug, setup and guide pages and routes.
- **Build settings:** `ignoreBuildErrors: true` (`../padelflow/next.config.js` L34–38). Several dependencies are pinned to `latest`.
- **Exports and statistics:** IMPLEMENTED (`../padelflow/app/api/export/*`, `tournament-stats`).
- **Email:** MOCKED (`../padelflow/app/api/send-confirmation-email/route.ts` L22–26).
- **Pricing plans:** DOCUMENTED_ONLY. `../padelflow/app/page.tsx` L559–622 advertises plans that have no billing behind them.
- **i18n:** EN/ES/PT dictionaries in the MVP (`../padelflow/public/mvp/i18n.js`).
- **Tests:** Jest tests exist for auth, payment-utils and results-service. There is a CI workflow (`../padelflow/.github/workflows/ci.yml`).

### 5.4 `../Sports`, `../PadelChain`, `../StrikeChain`

- **One codebase.** It is covered in §19. The canonical readable copy is `../PadelChain`.
- **Contract:** `../PadelChain/packages/contracts/StrikeChainEventManager.sol` (contract `StrikeChain`, 160 lines, `^0.8.20`, OZ v4 import paths).
  - It has the same md5 (`dcae3d3b…`) in all four copies.
- **What the contract does:**
  - `createEvent` lets anyone create an event and escrows `sum(prizes[3])` through `transferFrom`.
  - `registerParticipant` lets anyone register any address set.
  - `submitWinners` is sponsor-only. It requires 3 distinct registered winners and pushes payouts. For team events it splits `amount / members.length`.
  - `emergencyWithdraw` is sponsor-only and can be repeated. See §18.
- **Frontend:** a Next 15 v0.dev UI. Everything in it is **MOCKED**.
  - The wallet (`../PadelChain/apps/web/lib/wallet-mock.ts` L60–77) returns a random address with a 90% simulated success rate.
  - Tournaments are hard-coded arrays (`../PadelChain/apps/web/app/tournaments/browse/page.tsx` L48–162; organizer and participant dashboards).
  - Form submit is `console.log` (`../PadelChain/apps/web/app/organizer/create/page.tsx` L62–67).
- **No link to the contract.** There are zero ABI or contract calls. The UI offers entry fees and N prize tiers, but the contract supports exactly 3 fixed amounts and no fees.
- **Test token:** `../PadelChain/packages/contracts/ERC20.sol` has an unrestricted `faucet` mint.
- **Tests:** none for the real contract. Sports keeps only the Foundry `Counter` template (`../Sports/packages/contracts/test/Counter.t.sol`).

### 5.5 `../Art-Tokenization`

- **Contract:** `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` (`^0.8.20`, OZ ^5.0.1). It is an ERC-721 for a single artwork plus a native-ETH escrow keyed by tracking-ID string. Roles:
  - `owner` (the seller), who handles refunds and admin changes;
  - `oracleAddress`, required by `onlyOracle` on `releaseFunds` (L89–92, L168–190);
  - `sellerSafeAddress`, the payout destination.
- **The chain from physical event to settlement:**
  1. DHL sends a webhook to `POST /webhook/dhl` (`../Art-Tokenization/backend/src/server.ts` L102–163).
  2. The adapter parses it (`../Art-Tokenization/backend/src/services/dhl.ts`).
  3. `isDelivered` checks the status string (L427–434).
  4. The backend signs with its oracle hot key (`../Art-Tokenization/backend/src/services/escrowContract.ts` L30).
  5. `releaseFunds` executes on-chain.
- **Mocked or missing pieces:**
  - The webhook signature check always returns `true`, in production too (`dhl.ts` L376–393).
  - The DHL API response is hard-coded (L459–472).
  - `POST /test/mock-dhl-delivery` (`server.ts` L169–210) is always registered and has no auth.
  - `/admin/release-funds` (L215–246) accepts any non-empty `adminKey`.
  - The refund timeout is not enforced (the contract check at L208–209 is commented out).
- **Tests:** Hardhat tests exist (`../Art-Tokenization/test/BattagliniEscrowNFT.test.ts`), but the reentrancy test is empty (L286–289).
- **Provenance:** a single AI-generated commit with no iteration.
- **Value to Bragging Rights:** architectural precedent only (see §17).

### 5.6 `../LaNegrita-db`

- An 80-byte `README.md` titled "Database of CRCC Bowling Championship 2025 - Torneo La Negrita".
- **No data, schema or history exists.**
- It is useful only as a pointer: the real La Negrita schema lives in `../padelflow/scripts/`.

### 5.7 `../Onchainfest-WebSite`

- A static studio marketing site (`../Onchainfest-WebSite/index.html`).
- It describes PadelFlow features ("automated brackets, wallet-based registration, and smart contract prize distribution…", around L818), all DOCUMENTED_ONLY.
- The original $BRT definition is in git history only (§4.1).
- `../Onchainfest-WebSite/vercel.json` sets a reasonable CSP baseline.
- The contact form is a `mailto:` link.
- The `img/brts*` and `img/sports*` files are brand assets.

### 5.8 `../OLMO-Site---PeerProof`

- A purchased "OLMO" landing-page template by DSAThemes, with PeerProof EN/ES pages added (`../OLMO-Site---PeerProof/PeerProof/EN/index.html`).
- **PeerProof is marketing copy only, and it is self-contradictory.** The hero talks about "employment references", while the rest of the page describes a testimonial widget.
- Testimonials are fabricated. Integrations are placeholders: `formspree.io/f/XXXXXX` and `G-XXXXXXX`.
- The PHP mailers are vulnerable to header injection (`../OLMO-Site---PeerProof/php/contactForm.php`).
- **There is no attestation or verification logic of any kind.** Nothing to salvage.

### 5.9 `../qr-code-hrke`

- An HRKey "JUNGLE" promo. A QR deep link redirects to `/promo-register?coupon=…` (`../qr-code-hrke/vercel.json`).
- The client-only form is `../qr-code-hrke/pages/promo-register.js`.
- The server route `../qr-code-hrke/pages/api/promo-register.js` inserts name, email, coupon, IP and user-agent using a server-only service-role client.
- **HEAD handles secrets correctly, but history does not** (CRITICAL; see §18):
  - Commit `68fc1a6` (`public/promo-register.html`) embedded a service-role JWT in browser code.
  - Commit `6fb817d` committed `.env.local`.
- The README claims RLS, a unique-email check and secret hygiene. None of these can be verified in the repo, and history contradicts the last one.
- **What it offers:** a small precedent for "server route + QR deep link" registration.

---

## 6. Implemented Capabilities

"Implemented" here means real executable code exists. It does not imply the code is secure, deployed or tested.

| Capability | Where | Notes |
|---|---|---|
| Player registration with duplicate-email check (bowling schema) | `../padelflow/app/api/register-player/route.ts` | No auth by design; PII-heavy |
| Game-level result entry (bowling) | `../padelflow/app/api/results/add-series/route.ts`, `../padelflow/scripts/create-results-system-fixed.sql` | Service key, **no auth** |
| Standings recompute (trigger, ROW_NUMBER ranking) | `../padelflow/scripts/create-results-system-fixed.sql` | Bowling metrics |
| Automatic achievements (PERFECT_GAME, HIGH_SERIES) plus an event feed | same | DB trigger; bowling-specific |
| Player profile page and API | `../padelflow/app/player-profile/[id]/page.tsx` | Display only |
| CSV exports and tournament statistics | `../padelflow/app/api/export/*`, `../padelflow/lib/export-utils.ts` | Export auth is fake (checks only for a `Bearer` prefix) |
| Stripe checkout and signature-verified webhook | `../padelflow/app/api/stripe/*`, `../padelflow/lib/stripe-config.ts` | No idempotency; anon writes |
| Manual payment status updates | `../padelflow/app/api/update-payment/route.ts` | **Unauthenticated** |
| ERC-721 trophy metadata generation and Pinata upload | `../padelflow/lib/ipfs/*` | Server-side |
| ERC20 Transfer-log payment polling (viem `getLogs`) | `../Poker/payment_monitor_service.ts` | Not wired into the app |
| On-chain sponsor escrow for top-3 prizes, including team split | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` | Untested; CRITICAL bug |
| On-chain USDC 50/30/20 distribution | `../poker-tournament-backend/contracts/PrizeDistribution.sol` | Untested; CRITICAL bugs |
| Oracle-gated escrow release, refund, ERC-721 transfer | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` | Tested (Hardhat) |
| Oracle relayer (pre-check, send, wait for receipt) | `../Art-Tokenization/backend/src/services/escrowContract.ts` | Hot key |
| QR deep link to server-side registration insert | `../qr-code-hrke/pages/api/promo-register.js`, `../qr-code-hrke/vercel.json` | No validation or rate limit |
| Share-page QR modal | `../padelflow/components/qr-share-modal.tsx` | Shares a URL only |

## 7. Partially Implemented Capabilities

| Capability | Where | Gap |
|---|---|---|
| Tournament entity | `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` L7–15, L150–153 | One seeded row; multiple conflicting SQL scripts |
| Brackets | `../padelflow/app/api/brackets/create/route.ts` | No pairing, match generation or advancement |
| Registration and invites (poker) | `../Poker/src/app/register/page.tsx`, `../Poker/src/lib/supabase.ts` | Route file is empty; RPC undefined; RLS blocks anon inserts |
| Non-custodial wallet (wagmi, Coinbase Smart Wallet, MetaMask, WalletConnect) | `../padelflow/lib/wallet/*`, `../padelflow/components/wallet/*` | Never mounted in any page |
| Wallet connect (Reown AppKit) | `../Poker/src/lib/web3-config.ts`, `../Poker/src/components/Web3Provider.tsx` | Provider never mounted; no SIWE |
| Teams (captain-keyed) | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` L81–86 | Overwrite and griefing bugs |
| Sponsor role | same, L21, L66 | Sponsor = organizer = result certifier |
| Admin tooling | `../padelflow/app/admin/*` | `/admin` has no auth guard |
| Custodial wallet creation | `../padelflow/lib/wallet-service.ts` | Broken (method name mismatch) and unsafe |
| Trophy contract | `../padelflow/contracts/PadelFlowNFTTrophy.sol` | Does not compile with the pinned OZ; never deployed |

## 8. Mocked Capabilities

| Capability | Evidence |
|---|---|
| Wallet connection (random address, 90% simulated success) | `../PadelChain/apps/web/lib/wallet-mock.ts` L60–77 (identical in StrikeChain) |
| "Created" Coinbase or smart wallets (random hex) | `../Poker/src/app/register/page.tsx` L161–167 |
| Tournament discovery, organizer and participant dashboards, match results | `../PadelChain/apps/web/app/tournaments/browse/page.tsx` L48, `organizer/dashboard/page.tsx` L28–130, `participant/dashboard/page.tsx` L34–160, `tournament/[id]/manage/page.tsx` L45–117 |
| Event creation submit | `../PadelChain/apps/web/app/organizer/create/page.tsx` L62–67 (`console.log`) |
| BRT minting and redemption from the app | `../Poker/src/lib/flexible-nft-service.ts` L55–67 |
| Payment monitor UI | `../Poker/src/hooks/usePaymentMonitor.ts` L31–44 (`Math.random() > 0.3`) |
| Email sending | `../Poker/src/hooks/useEmailAutomation.ts` L176–183; `../padelflow/app/api/send-confirmation-email/route.ts` L22–26 |
| PadelFlow organizer auth | `../padelflow/public/mvp/app.js` L729–730 (localStorage flag) |
| PadelFlow prize delivery and trophy status | `../padelflow/public/mvp/app.js` L822–847 (localStorage) |
| IPFS upload in the MVP | `../padelflow/public/mvp/web3-integration.js` L214–219 |
| DHL delivery API and webhook signature | `../Art-Tokenization/backend/src/services/dhl.ts` L376–393, L459–472 |
| Testimonials and integrations | `../OLMO-Site---PeerProof/PeerProof/EN/index.html` |

## 9. Documented-Only Capabilities

| Capability | Where claimed |
|---|---|
| Champion $BRT NFTs with a public showcase and trading | `../Onchainfest-WebSite/index.html` (git history) |
| NFT achievements, verified results, IPFS, MongoDB, RainbowKit, Base/USDC | `../PadelChain/README.md`, `../StrikeChain/README.md` |
| Dispute and verification layer, entry fees | `../PadelChain/apps/web/app/page.tsx` L168–173 (UI copy) |
| Signature verification, JWT auth, complete RLS (poker) | `../Poker/readme_md.md` |
| "✅" payment monitor and email automation phases | `../Poker/src/app/page.tsx` L43–47 |
| Base deployment of the trophy contract | `../padelflow/package.json` scripts; `../padelflow/contracts/addresses.json` is empty |
| XRPL EVM deployment | `../padelflow/hardhat.config.js` only |
| Organizer pricing plans ($19.99 one-off, $49/month) | `../padelflow/app/page.tsx` L559–622 |
| QR check-in / validation | `../padelflow/scripts/create-wallet-and-validation-tables.sql`, dropped by `../padelflow/scripts/remove-qr-tables.sql` |
| Payouts to player wallets | `../padelflow/lib/wallet-service.ts` L126–131 (comments) |
| Buyer self-refund after timeout, multisig seller Safe | `../Art-Tokenization/README.md` |
| PeerProof "verified references" | `../OLMO-Site---PeerProof/PeerProof/EN/index.html` |
| RLS, unique-email check, "no private keys exposed" | `../qr-code-hrke/README.md` (contradicted by history) |

---

## 10. Smart Contract Inventory

| Contract | File | Solidity / OZ | Standard | Roles | Key functions | Build / deploy / tests |
|---|---|---|---|---|---|---|
| `SimplifiedBRTPoker` | `../Poker/contracts/simplified_brt_contract.txt` | ^0.8.19 / OZ 4.8.0 (Remix imports) | ERC-721 + URIStorage | Ownable only | `configureBRTPosition`, `configureAllBRTPositions`, `mintParticipationNFT`, `mintBRTsForWinners`, `mintBRTsInstant`, `redeemBRT` | `.txt` file, not built / not deployed / no tests |
| `PrizeDistribution` | `../poker-tournament-backend/contracts/PrizeDistribution.sol` | ^0.8.19 / OZ 4.8.0 (Remix imports) | — (holds ERC20) | Ownable only | `registerPlayerPayment`, `distributePrizes`, `claimPrize`, `updatePrizePercentages`, `emergencyWithdraw`, `setTournamentActive` | Not built in repo / no address / no tests |
| `PadelFlowNFTTrophy` | `../padelflow/contracts/PadelFlowNFTTrophy.sol` | ^0.8.20 / OZ ^5.4.0 pinned but uses the removed `Counters` | ERC-721 + URIStorage + Pausable | Ownable only | `mint`, `mintBatch`, `getTournamentTokens`, `getTournamentInfo`, `totalMinted` | **Will not compile**; addresses empty; no tests |
| `StrikeChain` (EventManager) | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` (×4 identical copies) | ^0.8.20 / OZ v4 import paths | — (holds ERC20) | Per-event sponsor; Ownable unused | `createEvent`, `registerParticipant`, `submitWinners`, `emergencyWithdraw` | No build config in PadelChain/StrikeChain; no tests; no address |
| `TestToken` | `../PadelChain/packages/contracts/ERC20.sol` | ^0.8.20 | ERC-20 | none | `faucet` (unrestricted mint) | Test only |
| `BattagliniEscrowNFT` | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` | ^0.8.20 / OZ ^5.0.1 | ERC-721 + ETH escrow | owner, oracle, sellerSafe | `purchaseArtwork`, `releaseFunds`, `refundBuyer`, `setOracleAddress`, `setSellerSafeAddress` | Hardhat build and tests; no address |
| `Counter` (template) | `../Sports/packages/contracts/src/Counter.sol` | Foundry template | — | — | — | Template only |

**Chains referenced:**

- **Base (8453) and Base Sepolia (84532):** Poker, poker-tournament-backend, padelflow, Art-Tokenization, and Sports `verify.json`.
- **XRPL EVM sidechain (1440002):** config only, in `../padelflow/hardhat.config.js`.
- **No deployed address exists in any repository.**

## 11. Database / Domain Inventory

| Source | Tables / entities | Sport coupling | Assessment |
|---|---|---|---|
| `../Poker/supabase_schema.sql` | `tournaments` (buy-in, prize pool, Gnosis/contract addresses, status enum), `players` (email, country default "Costa Rica", wallet, **`coinbase_wallet_credentials JSONB`**), `tournament_invitations`, `tournament_registrations` (payment tx, NFT flags, final_position, prize tx), `payment_monitoring`, `email_logs`, `prize_distributions`, `prize_distribution_details`, `admin_users` | Low (poker-branded, but the fields are generic) | Best **registration and prize ledger shape**. RLS only on 4 tables; `admin_users` is exposed. |
| `../Poker/email_database_schema.sql` | `email_logs` (conflicting), `email_templates`, `email_queue` | None | Conflicts with the main schema |
| `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` (plus 26 other overlapping scripts) | `tournaments`, `players` (passport, league, gender, handicap, scratch, packages, CRC/USD, Stripe ids), `brackets` (JSONB matchups/winners), `tournament_rounds`, `tournament_standings`, auth and audit tables, views | **High (bowling)** | No migration framework; conflicting definitions; permissive RLS |
| `../padelflow/scripts/create-results-system-fixed.sql` | `player_series` (game_1..3 ≤ 300), `player_standings`, `tournament_events`, `player_achievements` (+ triggers) | **High (bowling)** | Best **result → standing → achievement → feed** pattern |
| `../padelflow/scripts/create-wallet-and-validation-tables.sql` | `player_wallets` (**plaintext private_key, mnemonic**), `validation_qrs`, `email_logs` | None | Must never be reused |
| `../padelflow/public/mvp/app.js` (localStorage) | tournament config (formats, sets, pairs, prize scheme, trophy status) | **High (padel)** | Config vocabulary reference only |
| `../qr-code-hrke` / `../poker-tournament-backend/hrkey-promo-jungle/supabase-setup.sql` | `promo_jungle_registrations` | None (HR promo) | Not relevant |
| Contracts (on-chain state) | BRT configs and NFT info; Event{prizes[3], winners[3], teams}; Trophy{tournamentId, place, winnerName}; Escrow{trackingId} | Fixed podium of 3 everywhere | None can express arbitrary results |

**Legacy assumptions that conflict with a sport-agnostic model:**

- **Competition shape.** A "tournament" is always a single flat event. There is no Competition → Season → Event → Match hierarchy. Every contract is one-event-per-deployment (Poker, poker-backend) or has a hard-coded top 3 (all four contracts).
- **Results.** A result is a *position* (1–3) or a bowling *game score* (0–300). There is no generic result value (time, distance, points, sets, win/loss) and no unit or measurement model.
- **Participants.** The participant is a wallet address (contracts) or an email row (DB). No Person/Athlete identity joins the two. Teams exist only as a captain-keyed address list (StrikeChain).
- **Achievements.** Achievements are hard-coded SQL enums tied to bowling thresholds, with no issuer, evidence or verification level.
- **Places.** Currency and country defaults are CRC and Costa Rica. Winner names are stored on-chain (PadelFlowNFTTrophy), so PII ends up immutable.
- **Missing lifecycle.** No entity has provisional, official, disputed, corrected or revoked states.

**Data that can generalize:**

- registration → payment → confirmation status machine;
- invitation codes;
- final position plus prize amount plus tx hash per registration;
- prize distribution header/detail;
- event feed rows;
- achievement rows (with a type registry);
- standings snapshots;
- the trophy triple (competition, place, recipient).

**Data that cannot generalize:**

- bowling `game_1..3`, pins, handicap and scratch;
- CRC packages and early-bird pricing;
- padel set and americano config as columns;
- `coinbase_wallet_credentials` and `player_wallets` key storage;
- Gnosis "private key" env vars.

## 12. Identity / Wallet Inventory

| Pattern | Where | Status | Verdict |
|---|---|---|---|
| Plaintext custodial keys and mnemonics in DB | `../padelflow/lib/wallet-service.ts`, `../padelflow/scripts/create-wallet-and-validation-tables.sql` L7–8, L55 | IMPLEMENTED (route broken) | **Never reuse** |
| "Encrypted wallet credentials" JSONB column | `../Poker/supabase_schema.sql` L64 | Schema only | **Never reuse** |
| Random-hex "created" wallets | `../Poker/src/app/register/page.tsx` L166 | MOCKED | Discard |
| Mock wallet context | `../PadelChain/apps/web/lib/wallet-mock.ts` | MOCKED | Discard |
| wagmi (Coinbase Smart Wallet, MetaMask, WalletConnect) on Base / Base Sepolia | `../padelflow/lib/wallet/config.ts`, `useWallet.ts` | PARTIALLY_IMPLEMENTED (unmounted) | ADAPT |
| Reown AppKit + wagmi | `../Poker/src/lib/web3-config.ts` | PARTIALLY_IMPLEMENTED (unmounted) | REFERENCE_ONLY |
| Signature-based wallet ownership proof (SIWE) | none | — | Must be built |
| Admin identity | `../padelflow/lib/auth*.ts` (3 variants), `../Poker` `admin_users` (unchecked) | Insecure | Discard; rebuild on a real auth provider plus roles |
| Person/Athlete identity independent of wallet | none | — | Must be designed (BRT-01) |
| Organization / federation identity | none (LaNegrita/CRCC appears only as a name) | — | Must be designed |

## 13. Payment / Settlement Inventory

| Mechanism | Where | Model | Status | Key weakness |
|---|---|---|---|---|
| Stripe fiat entry fees | `../padelflow/app/api/stripe/*` | Checkout plus webhook; marks the player paid | IMPLEMENTED | No idempotency; anon client writes |
| Manual payment verification | `../padelflow/app/api/update-payment/route.ts` | Admin toggles a status | IMPLEMENTED | Unauthenticated |
| On-chain RLUSD payment detection | `../Poker/payment_monitor_service.ts` | Poll ERC20 Transfer logs to the treasury; match on sender and amount | IMPLEMENTED (unwired) | One transfer can confirm many registrations; `tx.from` breaks smart wallets; no confirmations or reorg handling |
| Sponsor-funded prize escrow | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` | Sponsor deposits `sum(prizes[3])`; sponsor submits winners; push payout | IMPLEMENTED | Repeatable drain; self-certification; locks if fewer than 3 winners |
| Owner-registered USDC pool | `../poker-tournament-backend/contracts/PrizeDistribution.sol` | Counter-based pool; owner picks winners; push plus claim | IMPLEMENTED | Double pay; always-open drain; pool not collateralized |
| BRT value redemption | `../Poker/contracts/simplified_brt_contract.txt` | Treasury allowance pays the NFT holder on redeem | DOCUMENTED_ONLY (never deployed) | Unbacked; return value ignored |
| Oracle-released escrow | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` | Buyer deposits ETH; oracle releases or owner refunds | IMPLEMENTED (tested) | Owner can swap the oracle mid-escrow; no enforced timeout |
| Prize config (pool, % per place or NFT) | `../padelflow/public/mvp/app.js` L147–250 | localStorage | MOCKED | No settlement |

**The common gap.** No mechanism binds a payout to a verified result. Every payout is triggered by a single privileged key: owner, sponsor or oracle.

## 14. Tournament / Event Inventory

| Concept | Best legacy source | Status |
|---|---|---|
| Tournament lifecycle enum (upcoming → registration_open/closed → in_progress → finished/cancelled) | `../Poker/supabase_schema.sql` | Schema only |
| Tournament plus rounds (qualifying round, bracket keys) | `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` L86–96; `create-results-system-fixed.sql` L86–99 | IMPLEMENTED (bowling) |
| Brackets / categories | `../padelflow/app/api/brackets/*` | PARTIALLY_IMPLEMENTED |
| Format configuration (americano, round-robin, elimination, sets) | `../padelflow/public/mvp/app.js` L293–393 | MOCKED (config only) |
| Head-to-head matches | none in any SQL; UI mock only in `../PadelChain/apps/web/app/tournament/[id]/manage/page.tsx` | Not implemented |
| Individual vs team events | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` (`isTeamBased`) | IMPLEMENTED (buggy) |
| Registration deadline | same contract, L52–57 | Stored but never enforced |
| Invitations with max uses and expiry | `../Poker/supabase_schema.sql` | Schema only |
| Tournament discovery / browse | `../PadelChain/apps/web/app/tournaments/browse/page.tsx` | MOCKED |
| Organizer create wizard | `../PadelChain/apps/web/app/organizer/create/page.tsx`; `../padelflow/public/mvp/create-tournament.html` | MOCKED |

## 15. Result / Achievement Inventory

| Concept | Source | Status | Notes |
|---|---|---|---|
| Final position per registration | `../Poker/supabase_schema.sql` (`final_position`) | Schema only | — |
| Winners as 3 addresses | StrikeChain `submitWinners`; poker-backend `distributePrizes`; BRT `mintBRTsForWinners` | IMPLEMENTED (contracts) | Self-certified; exactly 3 |
| Game-level scores | `../padelflow/scripts/create-results-system-fixed.sql` `player_series` | IMPLEMENTED | Bowling |
| Derived standings | same (`update_player_standings`) | IMPLEMENTED | Recomputed by trigger; tracks previous position |
| Threshold achievements | same (`PERFECT_GAME` when `game_n = 300`, `HIGH_SERIES`) | IMPLEMENTED | Rule hard-coded in SQL; no issuer or evidence |
| Public event feed | same (`tournament_events` with `is_public`) | IMPLEMENTED | Good precedent for an activity/history log |
| Evidence, attestation, verification level, dispute, correction, revocation | **none anywhere** | — | Entirely new work |
| Records (best-ever) | none (only `highest_game` / `highest_series` per player) | — | New |
| Rankings across events | none | — | New |

## 16. Trophy / NFT Inventory

| Token | Source | Model | Transferable | Duplicate-award guard | Status |
|---|---|---|---|---|---|
| BRT-POKER participation | `../Poker/contracts/simplified_brt_contract.txt` L117 | 1 per address per contract | Yes | `hasParticipationNFT[address]` (bypassed with a new address) | DOCUMENTED_ONLY |
| BRT-POKER champion / silver / bronze | same, L143–215 | `quantity` NFTs per winner, each with an RLUSD value | Yes | `tournamentFinalized` (one mint per contract) | DOCUMENTED_ONLY |
| PadelFlow Trophy (PFTROPHY) | `../padelflow/contracts/PadelFlowNFTTrophy.sol` | 1 token per (recipient, tournamentId); stores place and winnerName on-chain | Yes | `hasReceivedTrophy[recipient][tournamentId]` (L94, L117). Not keyed per (tournament, place). | Source only; does not compile |
| Artwork NFT | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` | Single token id tied to an escrow | Yes | n/a | IMPLEMENTED (tested) |
| $BRT champion NFT (concept) | `../Onchainfest-WebSite/index.html` (history) | tournamentId, season, winner wallet; tradable | Yes | — | DOCUMENTED_ONLY |

**Metadata.** `../padelflow/lib/ipfs/metadata.ts` L84–187 is the only real metadata generator. Its attributes are Tournament, Place, Rarity, Winner, Format, Total Players, Date, Location, Prize Pool, Partner and Final Score. It should be extended with achievement id, verification level, attestation hash and issuer.

**Design conclusion for BRT-01.** None of these tokens references a verified achievement. The Trophy House must mint *from* an Achievement Registry entry: an achievement id plus an attestation digest. Transferability, and whether the achievement is soulbound or collectible, becomes an explicit per-trophy-class decision.

## 17. Oracle / External Verification Inventory

**What exists.** The only legacy oracle is `../Art-Tokenization`:

1. An external event (DHL delivery) arrives at the webhook, `POST /webhook/dhl` (`../Art-Tokenization/backend/src/server.ts` L102–163).
2. The adapter parses it (`../Art-Tokenization/backend/src/services/dhl.ts` `parseWebhookPayload` L404) into a normalized type (`../Art-Tokenization/backend/src/types/index.ts`, `DeliveryStatus` enum).
3. The decision is a boolean: `isDelivered` (L427–434).
4. A relayer signs with the oracle hot key (`../Art-Tokenization/backend/src/services/escrowContract.ts` L30).
5. The contract accepts it only through `onlyOracle` (`../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` L89–92).
6. Settlement is `releaseFunds` (L168–190).

Every other "verification" in the legacy estate is a privileged key asserting winners:

- `../PadelChain/packages/contracts/StrikeChainEventManager.sol` `submitWinners` (sponsor)
- `../poker-tournament-backend/contracts/PrizeDistribution.sol` `distributePrizes` (owner)
- `../Poker/contracts/simplified_brt_contract.txt` `mintBRTsForWinners` (owner)
- `../padelflow/contracts/PadelFlowNFTTrophy.sol` `mint` (owner)

**Patterns that evolve into a Sports Oracle (conceptually):**

- An oracle role separate from the owner or organizer, with rotation events (`OracleAddressUpdated`).
- A source-specific **adapter**, a **normalized evidence type**, a **decision**, and a **chain writer**, as separate layers.
- An explicit status enum instead of ad-hoc strings.
- Idempotent settlement through on-chain closed state, plus a relayer pre-check.

**Patterns that must not be carried over:**

- A single boolean verdict from one unauthenticated source.
- No stored evidence artefact or hash.
- No source or issuer identity.
- An always-true signature check.
- No replay window: no timestamp, nonce or raw-body HMAC.
- A hot key in `.env`.
- Unauthenticated test and admin release endpoints.
- The party who benefits choosing the evidence subject: the buyer supplies the tracking id (`purchaseArtwork(string _trackingId)`, L133).
- The owner being able to swap the oracle mid-escrow (L235–251).

**What the future Sports Oracle needs** (requirements for BRT-01, not a design):

1. **Evidence objects.** Each is content-addressed (hash) and carries type, source identity, capture time, ingestion time, chain of custody, and optional media, sensor or timing payloads.
2. **Signed attestations.** An attestation is an issuer's statement about a subject result, citing evidence hashes. It has an issuer identity and an **authority scope**: which sport, which competition, which role. It has a verification level on the spectrum SELF_REPORTED → EVENT_VERIFIED → ORGANIZER_VERIFIED → FEDERATION_VERIFIED → DATA_PROVIDER_VERIFIED → MULTI_SOURCE_VERIFIED → MACHINE_VERIFIED → CANONICAL_RECORD. It also carries a confidence and an expiry or validity window, and it is signed (e.g. EIP-712 or an equivalent off-chain signature).
3. **An authority registry.** It records who may attest what: organizations, federations, officials, data providers and machine sources, with key rotation and revocation.
4. **A lifecycle.** Results move through provisional → official. From official they can become disputed, and a dispute resolves to confirmed or corrected. Corrections supersede prior attestations, and revocation is possible. Nothing is overwritten; everything is appended.
5. **Aggregation policy.** The policy combines attestations into a verification level (multi-source quorum, federation override, and human review for low-confidence machine evidence).
6. **Settlement gating.** Prize, payout and trophy actions consume a **verified achievement reference** with a minimum verification level and a dispute window, never a raw winner list.
7. **Webhook and adapter hygiene.** Raw-body HMAC, a timestamp and nonce window, source allow-lists and idempotency keys.

## 18. Security Findings

Findings are ranked by severity. **None were fixed in BRT-00.** "Must not copy" applies to all of them.

### CRITICAL

| ID | Finding | Evidence |
|---|---|---|
| C-1 | **Supabase `service_role` JWT committed to git and shipped to browsers.** The key was mislabelled as an anon key. It remains in history after the file was deleted. It appears to grant full RLS bypass on the HRKey Supabase project. **Owner action required: rotate the project's JWT secret and keys, and audit access.** | `../qr-code-hrke/public/promo-register.html` @ commit `68fc1a6` (deleted in `81d1c0a`). Identified by the sub-inspection; the role claim was not independently decoded in BRT-00. |
| C-2 | **Plaintext private keys and mnemonics readable by anyone.** The `player_wallets` table stores `private_key` and `mnemonic` as TEXT, and its policy `"Players can view their own wallet" ... FOR SELECT USING (true)` exposes every row. | `../padelflow/scripts/create-wallet-and-validation-tables.sql` L7–8, L55; `../padelflow/lib/wallet-service.ts` L41–48 |
| C-3 | **World-writable results, standings, players and payments.** Policies use `USING (true)` for ALL, INSERT and UPDATE, and the anon key is hard-coded in source. | `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` L210–297; `../padelflow/lib/supabase.js` L3–5; `../padelflow/lib/supabase-server.ts` L7–10 |
| C-4 | **Admin password disclosed by an API.** `test-credentials` returns `expectedPassword`, and the auth guard calls it. | `../padelflow/app/api/auth/test-credentials/route.ts` L10–18; `../padelflow/components/auth-guard.tsx` L91 |
| C-5 | **Repeatable `emergencyWithdraw` drains other events' escrow.** The guard is `status != Finalized`; the function sets `Closed` and never zeroes prizes, so the sponsor can call it repeatedly. | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` L135–146 (identical in `../StrikeChain`, `../Sports`) |
| C-6 | **Double prize payment.** `distributePrizes` pushes the transfers *and* leaves `prizeClaimed[winner]` set, so `claimPrize` pays again. | `../poker-tournament-backend/contracts/PrizeDistribution.sol` L78–85, L95–103 |
| C-7 | **Owner can drain the prize pool at any time.** `require(!tournamentActive \|\| block.timestamp > 0)` is always true. | `../poker-tournament-backend/contracts/PrizeDistribution.sol` L139 |
| C-8 | **Anyone can trigger escrow release over HTTP.** There is an unauthenticated `/test/mock-dhl-delivery`, the webhook signature check is always true, and `/admin/release-funds` accepts any non-empty key. | `../Art-Tokenization/backend/src/server.ts` L169–246; `../Art-Tokenization/backend/src/services/dhl.ts` L376–393 |
| C-9 | **`admin_users` (with password hashes) and other tables have no RLS.** They would be exposed through PostgREST if deployed. | `../Poker/supabase_schema.sql` L181–184 (RLS on only 4 tables) |

### HIGH

| ID | Finding | Evidence |
|---|---|---|
| H-1 | **Organizer self-certification of winners** with no evidence, dispute window or participant confirmation. This applies to every prize and trophy contract. | `StrikeChainEventManager.sol` L96–114; `PrizeDistribution.sol` L61–92; `simplified_brt_contract.txt` L143; `PadelFlowNFTTrophy.sol` `mint` |
| H-2 | **Default and forgeable admin credentials.** Defaults `admin123` and `supersecreto`; a hard-coded `PadelFlow2025!`; a JWT fallback secret; an unsigned base64 "token". | `../padelflow/app/api/auth/login/route.ts` L8; `../padelflow/app/api/auth/simple-login/route.ts` L18, L35–41; `../padelflow/lib/auth.ts` L2–5; `../padelflow/app/api/auth/simple-verify/route.ts` L17–29 |
| H-3 | **Plaintext passwords logged.** | `../padelflow/app/api/auth/login/route.ts` L55–59 |
| H-4 | **Service-role writes to results and brackets with no auth.** | `../padelflow/app/api/results/add-series/route.ts`, `../padelflow/app/api/results/rounds/route.ts`, `../padelflow/app/api/brackets/*` |
| H-5 | **Fake bearer auth on batch delete, batch verify and PII export.** The check only looks for a `Bearer ` prefix. | `../padelflow/app/api/batch/delete-players/route.ts` L9–11; `../padelflow/app/api/export/*` |
| H-6 | **Unauthenticated payment updates and an unguarded `/admin`.** | `../padelflow/app/api/update-payment/route.ts`; `../padelflow/app/admin/page.tsx` |
| H-7 | **Prize pool not collateralized.** The accounting counter is unrelated to the balance, and there is no balance-delta check. | `PrizeDistribution.sol` L50–58 |
| H-8 | **BRT value unbacked.** It depends on the treasury's allowance, and the `transferFrom` return value is ignored. | `simplified_brt_contract.txt` L232 |
| H-9 | **Admin signing inside a client component.** It is one rename (to `NEXT_PUBLIC_*`) away from shipping the admin key to browsers. | `../poker-tournament-backend/src/components/PrizeDashboard.tsx`; `../poker-tournament-backend/src/lib/prize-service.ts` L105 |
| H-10 | **Payment double-credit and replay.** Matching uses only sender and amount, and there is no uniqueness on `payment_tx_hash`. | `../Poker/payment_monitor_service.ts` L191–209; `../Poker/supabase_schema.sql` |
| H-11 | **Custodial treasury key implied.** A `GNOSIS_SAFE_PRIVATE_KEY` env var exists, but a Safe has no single key. | `../Poker/env_example.sh` L20 |
| H-12 | **Registration griefing and impersonation.** Anyone can register any address, and captains can overwrite their teams. | `StrikeChainEventManager.sol` L75–91 |
| H-13 | **The beneficiary chooses the evidence subject.** The buyer supplies the tracking id. | `BattagliniEscrowNFT.sol` L133; `../Art-Tokenization/frontend/src/App.tsx` L229–233 |
| H-14 | **The owner can swap the oracle and payout address mid-escrow.** | `BattagliniEscrowNFT.sol` L235–251 |
| H-15 | **Mocks presented as production.** Random wallets are stored as payer addresses, "✅" phases are claimed, and the UI simulates success. | `../Poker/src/app/register/page.tsx` L138, L166; `../Poker/src/app/page.tsx` L43–47; `../PadelChain/apps/web/lib/wallet-mock.ts` |
| H-16 | **Registrant PII publicly readable** through an anon SELECT policy. | `../poker-tournament-backend/hrkey-promo-jungle/supabase-setup.sql` L30–33 |

### MEDIUM

| ID | Finding | Evidence |
|---|---|---|
| M-1 | **Stripe webhook weaknesses:** no event-id idempotency, anon client writes, `payment_failed` left as a TODO. | `../padelflow/app/api/stripe/webhook/route.ts` |
| M-2 | **Fund-lock and DoS paths.** Exactly 3 winners are required; empty teams cause division by zero; loops are unbounded; dust is locked. | `StrikeChainEventManager.sol` L101–126 |
| M-3 | **Decimal mismatches:** `parseEther` / `formatEther` applied to 6-decimal tokens. | `../Poker/src/lib/flexible_nft_service.ts`; `../poker-tournament-backend/src/lib/prize-service.ts` L177, L197–199 |
| M-4 | **Duplicate-award guard keyed per wallet, not per (competition, place).** Winner names (PII) are stored on-chain, and trophies are transferable. | `../padelflow/contracts/PadelFlowNFTTrophy.sol` L44, L94, L117 |
| M-5 | **`mintBRTsInstant` bypasses the `configured` guard.** The owner can override published tiers. | `simplified_brt_contract.txt` L161–179 |
| M-6 | **No state-machine enforcement.** Registration status can be changed freely, and on-chain finalization is not tied to the DB. | `../Poker/supabase_schema.sql`; `../Poker/src/lib/supabase.ts` |
| M-7 | **Open trigger and relay endpoints.** `/api/payment-monitor` GET needs no auth, and the email POST relies on in-memory rate limits. | `../Poker/payment_webhook_api.ts` L24–66; `../Poker/email_api_routes.ts` |
| M-8 | **Webhook design:** HMAC over re-serialized JSON, no replay window, open CORS, full body logging. | `../Art-Tokenization/backend/src/server.ts` L102–163 |
| M-9 | **Refund timeout not enforced**, and there is no buyer self-refund. | `BattagliniEscrowNFT.sol` L208–209 |
| M-10 | **Type and lint errors ignored at build time**, and dependencies are pinned to `latest`. | `../padelflow/next.config.js` L34–38; `../PadelChain/apps/web/next.config.mjs`; `../PadelChain/apps/web/package.json` |
| M-11 | **Contracts that cannot be built:** removed OZ `Counters`, Remix-only imports, OZ v4 paths with no build config. | `PadelFlowNFTTrophy.sol` L8; `PrizeDistribution.sol` L4–6; `StrikeChainEventManager.sol` L4–6 |
| M-12 | **Open service-role insert endpoint** with no validation, rate limit or dedupe. | `../qr-code-hrke/pages/api/promo-register.js` |
| M-13 | **Committed `.env.local`** containing a second project's anon key and EmailJS ids. | `../qr-code-hrke` @ commit `6fb817d` |
| M-14 | **Mail header injection** in template PHP. | `../OLMO-Site---PeerProof/php/contactForm.php` |

### LOW

| ID | Finding | Evidence |
|---|---|---|
| L-1 | Raw ERC20 `transfer` / `transferFrom` without SafeERC20 | all four prize/BRT contracts |
| L-2 | In-memory rate limiting, ineffective on serverless | `../padelflow/lib/rate-limit.ts`; `../Poker/payment_webhook_api.ts` |
| L-3 | Stale ownership records after NFT transfer (`nftInfo.owner`, `userNFTs`) | `simplified_brt_contract.txt` |
| L-4 | Error responses leak DB internals | `../qr-code-hrke/pages/api/promo-register.js` |
| L-5 | IP and user-agent stored without disclosure | `../qr-code-hrke/pages/api/promo-register.js` |
| L-6 | About 20 debug and test routes still reachable in production | `../padelflow/middleware.ts` L9–18 blocks only 2 prefixes |
| L-7 | Unrestricted public `faucet` mint (testnet token) | `../PadelChain/packages/contracts/ERC20.sol` L11–13 |
| L-8 | Fabricated testimonials published | `../OLMO-Site---PeerProof/PeerProof/EN/index.html` |

### INFORMATIONAL

| ID | Finding | Evidence |
|---|---|---|
| I-1 | No deployed contract addresses anywhere; `addresses.json` is empty | `../padelflow/contracts/addresses.json` |
| I-2 | Hard-coded placeholder or invalid addresses: an RLUSD `0x1234…7890`, and a 37-hex-character Gnosis seed address | `../Poker/env_example.sh` L27; `../Poker/supabase_schema.sql` L225 |
| I-3 | Outdated dependencies: next 14.0.4, OZ 4.8.0, deprecated `experimental.appDir` | `../Poker/package.json`; `../Poker/next.config.js` |
| I-4 | Good existing baselines: Stripe `constructEvent`, the Vercel CSP, and server-only env handling at qr-code-hrke HEAD | `../padelflow/lib/stripe-config.ts`; `../Onchainfest-WebSite/vercel.json` |
| I-5 | CEI and `nonReentrant` applied correctly in `BattagliniEscrowNFT`, with double-release and double-refund tests | `../Art-Tokenization/test/BattagliniEscrowNFT.test.ts` |
| I-6 | Template licensing: the purchased OLMO template is committed publicly | `../OLMO-Site---PeerProof` |

---

## 19. Duplication / Technical Debt

**Sports lineage duplication.** Measured by md5 over the working trees, with a CRLF-normalized diff where it mattered.

| Pair | Common paths | Byte-identical | Differ | Notes |
|---|---|---|---|---|
| `../PadelChain` vs `../StrikeChain` | 151 | **150** | 1 (`README.md`) | StrikeChain has the same history with rewritten authors |
| `../PadelChain` vs `../Sports` | 135 | 129 | 6 | Sports adds 83 files (forge-std, Foundry scaffold); PadelChain adds the 15 route files that Sports deleted in `e50bed4` |
| `StrikeChainEventManager.sol` | 4 copies | 4 identical (md5 `dcae3d3b08feee76e232af28a00d5958`) | 0 | `../Sports/packages/contracts/` and `/src/`, `../PadelChain/...`, `../StrikeChain/...` |

- **Independent capability count.** The three "sports" repos contribute **one** UI (about 7.2k lines of v0-generated TSX plus 50 shadcn primitives) and **one** 160-line contract.
- **Naming.** "PadelChain" contains no padel logic, and its in-code product name is "Strikechain" (`../PadelChain/apps/web/app/layout.tsx` L11).
- **Broken upstream.** Sports HEAD has committed conflict markers in `apps/web/package.json`, `apps/web/tailwind.config.ts` and `apps/web/lib/utils.ts`.

**Other duplication and debt:**

- **Poker:** two email services, two payment monitor variants (real vs simulated), two layouts, two next configs, two NFT services (stub vs real, with mismatched ABIs), and two email schemas.
- **padelflow:**
  - 27 overlapping SQL scripts with conflicting table definitions;
  - three `players` definitions and two `player_series` definitions;
  - 4 Supabase client variants and 3 auth implementations;
  - two wallet stacks (custodial vs wagmi) plus a third ethers v5 CDN stack in the MVP;
  - two apps (Next.js and the static MVP) with no shared state;
  - about 45 debug and guide pages.
- **HRKey promo:** duplicated in `../qr-code-hrke` and `../poker-tournament-backend/hrkey-promo-jungle/`.
- **Prize models:** three incompatible ones (sponsor escrow, owner counter pool, NFT redemption), plus a fourth in padelflow's localStorage.
- **Trophy models:** two incompatible NFT designs (BRT tiers with value vs PadelFlow one-per-tournament).
- **No shared library** or package across any repository.

## 20. Recommended Source-of-Truth Components

These are the designated *references* per concern. In every case the new implementation is written fresh.

| Concern | Designated legacy reference | Why this one |
|---|---|---|
| BRT product semantics (participation vs podium, redeemable value) | `../Poker/contracts/simplified_brt_contract.txt` + `../Onchainfest-WebSite/index.html` (history) | Only origin of BRT tiers |
| Registration / payment / prize ledger shape | `../Poker/supabase_schema.sql` | Cleanest generic columns and status enum |
| Result → standings → achievement → feed pipeline | `../padelflow/scripts/create-results-system-fixed.sql` | Only working derived-data pipeline |
| Trophy contract shape | `../padelflow/contracts/PadelFlowNFTTrophy.sol` | Duplicate guard, per-competition index, batch, pause |
| Trophy metadata | `../padelflow/lib/ipfs/metadata.ts`, `pinata.ts` | Only real generator and uploader |
| Wallet connection | `../padelflow/lib/wallet/config.ts` | wagmi on Base with Coinbase Smart Wallet |
| Fiat payments | `../padelflow/app/api/stripe/webhook/route.ts` | Correct signature verification |
| Sponsor escrow data model (teams, prize tiers) | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` | Only sponsor/team model; use as a spec, not code |
| Oracle role separation and adapter pipeline | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol`, `../Art-Tokenization/backend/src/` | Only oracle precedent |
| Contract test matrix skeleton | `../Art-Tokenization/test/BattagliniEscrowNFT.test.ts` | Only non-trivial contract tests |
| Organizer / participant UX flows | `../PadelChain/apps/web/app/**` | Most complete flow set (mock data) |
| Competition format vocabulary | `../padelflow/public/mvp/app.js` L293–393 | Padel formats as config |
| Contract toolchain scaffold | `../Sports/packages/contracts/` (Foundry) | Only Foundry setup |
| Pilot organization / event | La Negrita (CRCC bowling 2025), via `../padelflow` and `../LaNegrita-db` | Only real operational event |

## 21. What Can Be Reused

"Reuse" means lifting a concept, configuration or vocabulary nearly unchanged. **No source file is to be copied into this repository in BRT-00.**

- shadcn/ui primitives (`../PadelChain/apps/web/components/ui/*`). These are stock; install them fresh rather than copying.
- The Foundry project scaffold layout (`../Sports/packages/contracts/foundry.toml`, `remappings.txt`, CI `test.yml`).
- Network matrix values: Base 8453, Base Sepolia 84532, XRPL EVM 1440002 (`../padelflow/hardhat.config.js`, `../padelflow/contracts/addresses.json`).
- EN/ES/PT i18n dictionaries as translation seed material (`../padelflow/public/mvp/i18n.js`).
- The CSP header baseline (`../Onchainfest-WebSite/vercel.json`).
- The BRT tier vocabulary (participation, champion, silver, bronze).

## 22. What Must Be Adapted

| Component | Adaptation required |
|---|---|
| `../padelflow/contracts/PadelFlowNFTTrophy.sol` | Drop `Counters`. Use AccessControl (MINTER/ISSUER) instead of Ownable. Key by `achievementId` and attestation digest, with a guard per (competition, place/achievement). Move names off-chain. Decide on soulbound vs transferable. Add revoke/supersede. |
| `../padelflow/lib/ipfs/metadata.ts`, `pinata.ts` | Neutral branding; add achievement id, verification level, issuer, evidence and attestation references |
| `../padelflow/lib/wallet/config.ts` | Pin versions; parameterize chains; add SIWE; mount properly |
| `../padelflow/app/api/stripe/webhook/route.ts` | Service-role server client, event-id idempotency table, generic line items |
| `../Poker/supabase_schema.sql` table shapes | Generalize to Person/Athlete, Competition/Event, Participation; RLS on every table; unique tx hashes; remove custody columns |
| `../Poker/payment_monitor_service.ts` | Per-registration payment reference, idempotency on tx hash, confirmations and reorg handling, a server-side worker |
| `../padelflow/scripts/create-results-system-fixed.sql` pattern | Generic result values and units; rules engine per sport instead of hard-coded SQL thresholds; achievements issued via the Achievement Registry with provenance |
| `../Art-Tokenization/backend/src/services/escrowContract.ts` relayer | KMS/HSM signer; submit signed attestations rather than bare release calls |
| `../Art-Tokenization/test/BattagliniEscrowNFT.test.ts` | Test matrix template (role rejection, double-settle, refund paths) |
| `../PadelChain/apps/web/app/**` flows | Keep only the flow/IA design (create wizard, browse, dashboards, manage); rebuild on real data |
| `../qr-code-hrke` QR deep link to server insert | Signed QR parameters, zod validation, rate limit, dedupe, consent capture |
| `../padelflow/lib/export-utils.ts`, `logger.ts`, `error-handler.ts` | Minor cleanup |

## 23. What Must Be Rewritten

- **All prize and settlement contracts.** `StrikeChainEventManager.sol`, `PrizeDistribution.sol` and the BRT redemption logic become a new Prize Rail. It must have:
  - collateralized escrow per competition;
  - N-place and arbitrary split schedules;
  - settlement gated by verified-achievement references and a dispute window;
  - pull-based claims with single-claim guarantees;
  - SafeERC20;
  - a timelocked or multisig admin;
  - no owner drain.
- **The BRT contract.** Its semantics survive, re-expressed as Trophy classes minted from achievements.
- **The whole domain schema**, sport-agnostic and with a migration framework.
- **Auth and roles** (organizer, official, federation, admin), with RLS derived from them.
- **The match/result engine.** None exists for any head-to-head sport.
- **Bracket/pairing/advancement logic.** None exists.
- **Registration flows** (Poker's route is broken; padelflow's is bowling-specific).
- **The oracle webhook server** (`../Art-Tokenization/backend/src/server.ts`).
- **The redemption flow**, which must be user-signed.

## 24. What Must Never Be Reused

- **Any storage of private keys, mnemonics or "encrypted wallet credentials"** in an application DB: `../padelflow/lib/wallet-service.ts`, `player_wallets`, `../Poker/supabase_schema.sql` `coinbase_wallet_credentials`.
- **`USING (true)` RLS policies** for writes or for sensitive reads. This covers all padelflow SQL scripts and the hrkey promo.
- **Auth code:** `../padelflow/lib/auth*.ts`, `../padelflow/app/api/auth/*` (especially `test-credentials`), and the simple base64 tokens.
- **Emergency-withdraw designs** that the owner or sponsor can call at will: `PrizeDistribution.emergencyWithdraw`, `StrikeChain.emergencyWithdraw`.
- **Push-and-also-claim payout double bookkeeping** (`PrizeDistribution`).
- **Always-true signature verification**; test or admin endpoints that move funds; hot oracle keys in `.env`.
- **Admin private keys referenced from client components.**
- **Mock wallets and simulated success hooks:** `wallet-mock.ts`, `usePaymentMonitor.ts`, `useEmailAutomation.ts`.
- **The HRKey service-role key** and any credential found in git history. These must be rotated, not reused.
- **The OLMO/PeerProof template and copy.**
- **Sports HEAD** (broken), and StrikeChain as a separate source (a duplicate).

## 25. Proposed Reconstruction Sequence

The sequence below is a proposal for review. It does not authorize implementation.

| Phase | Name | Content | Legacy precedent |
|---|---|---|---|
| BRT-01 | Domain Ontology & Verification Model | Canonical entities (Person, Athlete, Team, Organization, Federation, Sport, Discipline, Competition, Event, Match, Participation, Result, Evidence, Attestation, Verification, Achievement, Record, Ranking, Prize, Payout, Trophy). Verification-level spectrum. Result lifecycle. Authority scopes. Sport-specific extension points (result schema per discipline). | Poker schema, padelflow results pipeline, Art oracle pattern |
| BRT-02 | Architecture & Trust Boundaries | Stack decision; custody policy (non-custodial by default); key management (KMS for oracle and issuer keys); on-chain vs off-chain boundary (what gets anchored); chain selection (Base / XRPL EVM); threat model built from §18 | — |
| BRT-03 | Identity & Organizations | Person/Athlete passport, wallet linking via SIWE, organization/federation identity, roles and RLS | padelflow wagmi config |
| BRT-04 | Competition & Participation | Competition/Event/Match hierarchy, formats as data, registration with invites/QR, fiat entry fees | Poker schema, PadelChain UX, padelflow Stripe, qr-code-hrke |
| BRT-05 | Result & Evidence Engine | Generic results, evidence objects, organizer attestations (ORGANIZER_VERIFIED as the first level) | padelflow result triggers |
| BRT-06 | Achievement Registry, Records & Rankings | Achievements derived from verified results; records and rankings as projections | padelflow achievements and standings |
| BRT-07 | Trophy House | Achievement-bound trophy contract with tests; metadata pipeline | PadelFlowNFTTrophy, metadata.ts, BRT tiers |
| BRT-08 | Prize Rail | Collateralized escrow, verification-gated settlement, claims, full test suite and audit | StrikeChain / PrizeDistribution as anti-patterns; Art escrow tests |
| BRT-09 | Sports Oracle v1 | Authority registry, signed attestations, adapters, disputes and corrections | Art-Tokenization pipeline |
| BRT-10+ | Sponsors, providers, officials, venues, media archive, external API, AI officiating foundation | — | Largely no precedent |

**Pilot recommendation.** Use a real, previously operated event (La Negrita / CRCC bowling) as the first dataset to validate that the ontology handles a non-bracket, score-based sport. Validate a head-to-head sport (padel) second.

## 26. Open Questions for BRT-01

1. **What is the canonical Result representation** across score-based (bowling, golf), time/distance (running), head-to-head (padel, football) and judged sports? One polymorphic `Result` with a per-discipline schema, or typed result families?
2. **What is the minimum verification level** that may trigger (a) an achievement, (b) a record, (c) a payout, (d) a trophy mint? Is it configurable per competition?
3. **Trophy transferability.** Is the canonical trophy soulbound? Should there be a separate transferable collectible (resolving the $BRT "sell or trade" conflict)?
4. **Anchoring.** What gets anchored on-chain (attestation hashes, achievements, trophies, prizes), and on which chain (Base, XRPL EVM, both)? Is RLUSD still a target settlement asset?
5. **Identity.** Is Person distinct from Athlete? How are minors, privacy and PII handled, given that legacy code wrote names on-chain? How are wallet-less athletes represented?
6. **Authority.** Who is allowed to attest for a competition? How is federation authority established, delegated and revoked? Can an organizer ever be the sole attestor for a prize-bearing result?
7. **Disputes.** What is the dispute window length? Who adjudicates? How do corrections supersede prior achievements, rankings and paid prizes (clawback or not)?
8. **Custody.** Is the platform strictly non-custodial? If smart wallets are used for onboarding, which provider, and who controls recovery?
9. **Prize funding sources.** Does funding come from sponsors, entry fees, the platform or federations? Are there multiple funders per competition? What is the fiat ↔ on-chain bridge policy (Stripe in, stablecoin out)?
10. **Teams.** How do team membership, rosters and prize splits work over time (substitutions, transfers)?
11. **Sport ontology governance.** Who defines Sports/Disciplines and their rule sets? Is it a platform-curated registry or a federation-contributed one?
12. **Legacy data.** Should any legacy data be migrated (La Negrita bowling results, if a production Supabase exists), or is the platform greenfield?
13. **Machine evidence.** What provenance is required for sensor, timing and video evidence (device identity, signing at capture), in preparation for AI officiating?
14. **Is BRT still the token name**, and does "Bragging Rights Token" survive as a user-facing concept for trophies?
