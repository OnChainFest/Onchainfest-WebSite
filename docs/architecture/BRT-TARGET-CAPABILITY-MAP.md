# Bragging Rights — Target Capability Map

| Field | Value |
|---|---|
| Origin | BRT-00 (repository archaeology) |
| Status | Draft for review. Describes capabilities, not implementation. The domain ontology is deferred to BRT-01. |
| Related | [`../archaeology/BRT-00-REPOSITORY-ARCHAEOLOGY.md`](../archaeology/BRT-00-REPOSITORY-ARCHAEOLOGY.md), [`../archaeology/BRT-00-SALVAGE-MATRIX.md`](../archaeology/BRT-00-SALVAGE-MATRIX.md) |

## 1. Vision

Bragging Rights is **a global infrastructure for verified sports achievement, competition and rewards**. It is sport-agnostic: padel, bowling, poker, running, football and other sports share one domain model, with sport-specific rules supplied as data and extensions.

The **canonical primitive is a verified sporting fact**, not an NFT:

```
Result ──► Evidence ──► Attestation ──► Verification ──► Verified Achievement
```

Downstream consequences are **derived** from Verified Achievements and never asserted independently:

```
Verified Achievement ──► Record
                     ──► Ranking
                     ──► Qualification
                     ──► Prize ──► Payout
                     ──► Trophy (digital representation, e.g. NFT)
                     ──► Historical Profile (Athlete Passport)
```

**What the legacy code did.** Every legacy prize and trophy contract inverted this flow. A privileged key asserted winners, and money or NFTs moved directly (archaeology §17–18). The target architecture exists to make that inversion impossible.

## 2. Architectural principles

These principles are derived from the legacy failures listed in archaeology §18.

1. **Evidence before consequence.** No prize, payout, record, ranking or trophy may be created without a reference to a Verified Achievement that meets the consequence's minimum verification level.
2. **Attestations, not booleans.** The oracle outputs signed statements: *who* (issuer and authority scope) asserts *what* (a subject result), *based on which evidence* (content hashes), *when*, and *with what confidence*. Verification levels are computed from attestations by policy.
3. **Append-only history.** Corrections supersede. Revocations are explicit records. Nothing is overwritten. Disputes are first-class.
4. **Separation of roles.** The organizer, sponsor/funder, official, attestor, settlement executor and platform admin are distinct roles. No single key can both certify a result and receive or reclaim its funds.
5. **Non-custodial by default.** The platform never stores user private keys or mnemonics. Service keys (issuer, relayer) live in a KMS/HSM and are scoped and rotatable.
6. **Sport-agnostic core, sport-specific extensions.** The core knows Competitions, Participations and Results. Scoring, formats and achievement rules are per-discipline definitions.
7. **Chain as anchor, not database.** Operational data lives off-chain with strict RLS. The chain anchors attestation digests, verified achievements, trophies and escrowed value.
8. **Honest status.** No mocked flow ships as if it were real. Every simulated or placeholder path is flagged in code and UI.

## 3. Capability layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  EXPERIENCE      Athlete Passport · Organizer Console · Trophy House ·       │
│                  Marketplaces (Sponsor / Provider) · Public Hall of Fame    │
├──────────────────────────────────────────────────────────────────────────────┤
│  CONSEQUENCES    Achievement Registry · Records · Rankings · Qualification · │
│                  Prize Rail / Escrow / Settlement · Trophy issuance         │
├──────────────────────────────────────────────────────────────────────────────┤
│  TRUST           Evidence Layer · Sports Oracle / Verification Engine ·      │
│                  Authority Registry · Disputes & Corrections                │
├──────────────────────────────────────────────────────────────────────────────┤
│  OPERATIONS      Competition & Event Engine · Participation / Registration · │
│                  Match / Result Engine · Officials · Venues                 │
├──────────────────────────────────────────────────────────────────────────────┤
│  FOUNDATION      Sports Ontology · Identity (Person / Athlete / Org /        │
│                  Federation) · Administration & Governance · External API   │
├──────────────────────────────────────────────────────────────────────────────┤
│  FUTURE          Media / Historical Archive · AI Officiating Foundation      │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 4. Module catalogue and legacy precedent

The "Legacy precedent" column names the best available reference from BRT-00. "None" means the module is greenfield. **Maturity of precedent** rates how much the legacy code helps:

- **High**: a sound design exists and needs adaptation.
- **Medium**: a useful pattern exists with major flaws.
- **Low**: vocabulary or UX only.
- **None**: no precedent.

| # | Module | Responsibility | Legacy precedent | Maturity of precedent |
|---|---|---|---|---|
| M1 | **Athlete Passport** | Person/Athlete identity, linked wallets (SIWE), privacy/PII controls, verified history, public profile | `../padelflow/lib/wallet/config.ts` (wagmi, Coinbase Smart Wallet); `../padelflow/app/player-profile/[id]/page.tsx` (profile UX) | Low–Medium |
| M2 | **Organization / Federation Identity** | Organizations, clubs, federations; membership; verified org keys; delegation of authority | `../LaNegrita-db/README.md` (pilot org name only) | None |
| M3 | **Sports Ontology** | Sport → Discipline → format and rule definitions; result schemas per discipline; units | `../padelflow/public/mvp/app.js` L293–393 (padel formats); `../padelflow/scripts/create-results-system-fixed.sql` (bowling scoring) | Low |
| M4 | **Competition & Event Engine** | Competition, Season, Event, Stage, Match hierarchy; lifecycle; brackets/pairing/advancement | `../Poker/supabase_schema.sql` (lifecycle enum); `../padelflow/scripts/SETUP_SUPABASE_COMPLETE.sql` (rounds/brackets); `../PadelChain/apps/web/app/organizer/*` (UX) | Low |
| M5 | **Participation / Registration** | Entries (individual/team), invites, QR, eligibility, entry fees, check-in | `../Poker/supabase_schema.sql` (registrations, invitations, status machine); `../padelflow/app/api/stripe/*` (fiat fees); `../qr-code-hrke/pages/api/promo-register.js` (QR → server insert); `../Poker/payment_monitor_service.ts` (on-chain payment detection) | Medium |
| M6 | **Match / Result Engine** | Capture results per discipline schema; provisional → official lifecycle; derived standings | `../padelflow/scripts/create-results-system-fixed.sql` (results → standings triggers) | Medium (pattern), None (head-to-head) |
| M7 | **Evidence Layer** | Content-addressed evidence objects (score sheets, timing files, sensor data, video, photos); provenance and chain of custody | `../Art-Tokenization/backend/src/types/index.ts` (normalized payload type); `../padelflow/lib/ipfs/pinata.ts` (content-addressed storage) | Low |
| M8 | **Sports Oracle / Verification Engine** | Authority registry; signed attestations; verification-level policy; disputes, corrections, revocations, supersession; source adapters | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` (`onlyOracle` role separation); `../Art-Tokenization/backend/src/services/*` (adapter → decision → relayer) | Medium (structure), None (attestation semantics) |
| M9 | **Achievement Registry** | Canonical Verified Achievements, derived from verified results by rules; issuer and provenance; anchoring | `../padelflow/scripts/create-results-system-fixed.sql` (`player_achievements` triggers); `../Poker/contracts/simplified_brt_contract.txt` (tiers) | Low–Medium |
| M10 | **Records** | Best-ever marks by scope (world, national, venue, age group); ratification; supersession | `../padelflow` `highest_game` / `highest_series` columns only | None |
| M11 | **Rankings** | Rating/ranking systems per discipline; points tables; snapshots over time | `../padelflow` `update_player_standings` (in-event standings) | Low |
| M12 | **Prize Rail / Escrow / Settlement** | Collateralized prize pools, multi-funder escrow, split schedules, verification-gated settlement, claims, refunds, fiat on-ramp | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` (sponsor/team model, anti-pattern); `../poker-tournament-backend/contracts/PrizeDistribution.sol` (bps split, anti-pattern); `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` (tested escrow, CEI) | Medium (as spec + anti-pattern list) |
| M13 | **Trophy House** | Digital trophies minted *from* achievements; trophy classes (soulbound vs collectible); metadata; display | `../padelflow/contracts/PadelFlowNFTTrophy.sol` (shape, duplicate guard); `../padelflow/lib/ipfs/metadata.ts`; `../Poker/contracts/simplified_brt_contract.txt` (BRT tiers, redemption idea) | High (for shape) |
| M14 | **Sponsor Marketplace** | Sponsors discover and fund competitions and prizes; branding rights; reporting | `../PadelChain/packages/contracts/StrikeChainEventManager.sol` (sponsor funds event); `../PadelChain/apps/web` (organizer/sponsor UX) | Low |
| M15 | **Provider Marketplace** | Timing, data, streaming and venue-service providers; integration listings | None | None |
| M16 | **Officials / Referee Network** | Official identity, certification, assignment, attestation authority | None | None |
| M17 | **Venue Network** | Venues, courts/lanes, certified measurement (e.g. lane or track certification) | None (La Negrita / CRCC is a venue-bound event only) | None |
| M18 | **Media / Historical Archive** | Historical results, media, event feeds, Hall of Fame | `../padelflow` `tournament_events` public feed | Low |
| M19 | **AI Officiating Foundation** | Media/sensor ingestion, CV/sensor analysis, rules engine, confidence, human review | None | None |
| M20 | **Administration / Governance** | Roles, permissions, RLS, audit log, multisig/timelock admin for contracts, platform policy | `../padelflow` audit tables (`login_attempts`, `security_events`) as a concept only; all legacy auth is DISCARD | None (usable) |
| M21 | **External API / Developer Platform** | Public read API for verified achievements, records and rankings; write APIs for providers; webhooks | `../padelflow/public/openapi.yaml`, `../padelflow/lib/export-utils.ts` (CSV) | Low |

## 5. Core flow (target)

```
 Organizer ─► Competition/Event (M4) ─► Registrations (M5) ─► Matches/Results (M6)
                                                                   │
            Timing HW / Sensors / Video / Score sheets ─► Evidence (M7)
                                                                   │
     Organizer / Official / Federation / Data provider / Machine ─► Attestations (M8)
                                                                   │
                                        Verification policy (M8) ─► Verification level
                                                                   │
                                                   Dispute window (M8)
                                                                   │
                                                  Verified Achievement (M9)
                     ┌──────────────┬──────────────┬───────────────┼──────────────┐
                     ▼              ▼              ▼               ▼              ▼
                Record (M10)   Ranking (M11)  Qualification   Prize/Payout   Trophy (M13)
                                               (M4)           (M12)
                                                                   │
                                                   Athlete Passport / Archive (M1, M18)
```

## 6. Verification spectrum (requirements input to BRT-01)

| Level | Meaning | Typical issuer | Legacy analogue |
|---|---|---|---|
| SELF_REPORTED | The athlete claims the result | Athlete | none |
| EVENT_VERIFIED | Captured by the event system of record | Event software | padelflow `player_series` entry (unauthenticated) |
| ORGANIZER_VERIFIED | Organizer attests | Organizer key | StrikeChain `submitWinners`, PrizeDistribution `distributePrizes`, BRT `mintBRTsForWinners` (all unsigned, self-certified) |
| FEDERATION_VERIFIED | A federation with scope over the sport and region attests | Federation key | none |
| DATA_PROVIDER_VERIFIED | An accredited data or timing provider attests | Provider key | Art-Tokenization DHL adapter (mocked) |
| MULTI_SOURCE_VERIFIED | A quorum of independent attestations agrees | Policy | none |
| MACHINE_VERIFIED | A signed sensor, timing or CV pipeline attests, with confidence | Device / pipeline key | none |
| CANONICAL_RECORD | Ratified as the canonical record after the dispute window | Governance | none |

**Required attestation properties:**

- evidence provenance (hashes and source identity);
- issuer identity and authority scope;
- signature;
- capture and issuance timestamps;
- confidence;
- validity window;
- supersedes / revokes references;
- dispute linkage.

## 7. AI officiating implications (future scope only)

```
Camera / sensor / timing hardware ─► media ingestion ─► CV / sensor analysis ─► sport rules engine
   ─► confidence evaluation ─► human review (when below threshold) ─► event decision
   ─► Evidence (M7) ─► Attestation (MACHINE_VERIFIED, M8) ─► verified result (M6/M9)
```

Implications to preserve now so that nothing blocks this later:

- **Evidence and devices.** Evidence must support high-volume media and sensor streams, with device identity and at-capture signing.
- **Decision granularity.** Results must be decomposable into *decisions* (foul, out, score, card, false start), each able to carry its own evidence and attestation, not only a final result.
- **Rules as data.** The rules engine must be per-discipline data (M3) so that machine and human decisions reference the same rule identifiers.
- **Confidence.** Confidence and human-review outcomes are attestation fields, not side channels.
- **Latency.** Real-time outputs (for example spoken referee announcements) need a low-latency decision path that is separate from the slower attestation/anchoring path.

## 8. Legacy source map by capability

The table below lists, for each capability, the best legacy source and what to avoid.

| Capability | Primary legacy reference | Secondary | Avoid |
|---|---|---|---|
| Trophies / NFTs | `../padelflow/contracts/PadelFlowNFTTrophy.sol`, `../padelflow/lib/ipfs/*` | `../Poker/contracts/simplified_brt_contract.txt` | Owner-only mint, on-chain PII, transferable-by-default |
| Prize escrow / settlement | `../Art-Tokenization/contracts/BattagliniEscrowNFT.sol` (+ tests) | `../PadelChain/.../StrikeChainEventManager.sol` (model) | `PrizeDistribution` claim/drain, StrikeChain `emergencyWithdraw` |
| Oracle / verification | `../Art-Tokenization/backend/src/*` (layering) | — | Boolean verdicts, hot keys, always-true HMAC |
| Registration & payments | `../Poker/supabase_schema.sql`, `../padelflow/app/api/stripe/*` | `../Poker/payment_monitor_service.ts`, `../qr-code-hrke` | Custodial wallets, permissive RLS |
| Results / standings / achievements | `../padelflow/scripts/create-results-system-fixed.sql` | — | Hard-coded sport thresholds in SQL |
| Wallet / identity | `../padelflow/lib/wallet/*` | `../Poker/src/lib/web3-config.ts` | `wallet-service.ts`, mock wallets |
| Organizer / participant UX | `../PadelChain/apps/web/app/**` | `../padelflow/app/admin/*`, `../padelflow/public/mvp/*` | Hard-coded data presented as real |
| Contract toolchain | `../Sports/packages/contracts` (Foundry) | `../Art-Tokenization/hardhat.config.ts` | Remix-only imports, removed OZ APIs |

## 9. Deferred to BRT-01

- The full ontology: entity definitions, relationships and cardinalities.
- The Result representation strategy across sport families.
- The attestation data format and signature scheme.
- The on-chain / off-chain boundary and chain selection.
- Minimum verification levels per consequence type.
- The custody and onboarding policy.

See archaeology §26 for the complete open-question list.
