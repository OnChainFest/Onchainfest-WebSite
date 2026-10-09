# ADR-0036 — A counterparty DENY blocks V1 unless the same evaluation fully meets the V2 certification exception

- **Status:** Accepted (BRT-07R)
- **Date:** 2026-09-29
- **Origin:** BRT-07. Reconciles BRT-01 verification model §5.3 with §6 and ADR-0005 (cumulative levels).

## Context: two accepted statements that conflict

BRT-01 contains two accepted statements:

1. **§6 V1 and ADR-0005.** V1 requires "no unresolved DENY from a counterparty". Levels are cumulative: "each level includes all criteria of the levels below", so V2 ⇒ V1 ⇒ V0.
2. **§5.3.** A participant DENY "blocks V1 … It does not block V2, since a certifying official outranks a participant".

Read literally together, they contradict each other. A counterparty DENY fails V1. Because every level includes the ones below, it would then also fail V2, which §5.3 explicitly says must not happen. No reading keeps both sentences literally true. One of them has to be qualified.

## Interpretation

§5.3 names the one situation where a participant's disagreement stops being decisive: an authorized official has **certified** the result (V2). We qualify the V1 criterion to cover exactly that situation, and nothing else. Cumulative integrity (V2 ⇒ V1 ⇒ V0) stays intact.

## Decision

`NO_COUNTERPARTY_DENY` (V1) has three outcomes. The trace states each one explicitly with its own reason codes, so there is no hidden special case:

| Situation in this evaluation | Status | Reasons |
| --- | --- | --- |
| No active DENY from a counterparty or the submitter | `PASS` | `NO_COUNTERPARTY_DENY` |
| A counterparty/submitter DENY exists **and** the V2 certification exception is fully met: `OFFICIAL_DECLARATION` = PASS **and** `NO_AUTHORIZED_DENY` = PASS | `PASS` | `COUNTERPARTY_DENY_PRESENT`, `COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION`, `V2_OFFICIAL_DECLARATION_PASSED`, `V2_NO_AUTHORIZED_DENY_PASSED` |
| A counterparty/submitter DENY exists and the exception is not met | `FAIL` (`UNKNOWN` when only unresolved-participation deniers exist) | `COUNTERPARTY_DENY` (or `PARTICIPATION_UNKNOWN`), `V2_CERTIFICATION_EXCEPTION_NOT_MET` |

Rules:

- **Normal V1.** An unresolved counterparty DENY fails V1. Without V2 the result is V0 at most.
- **The exception needs the whole certification.** A valid official declaration is not enough on its own. The same snapshot must also show no DENY from an authorized, non-conflicted result authority. An official's `RESULT_ACCURATE` without a V2 declaration never outranks a participant.
- **An authorized official DENY is never outranked.** It fails `NO_AUTHORIZED_DENY`, which blocks V2. It also removes the exception, so a counterparty DENY blocks V1 as well.
- **The dispute stays visible.** The exception does not hide the disagreement. The public body reports `activeDispute: true`, and the `CONTRADICTING_ATTESTATION` flag is raised.
- **Stricter policies are allowed.** A policy may add `NO_ACTIVE_DISPUTE`, which fails on any active DENY. The development reference policy uses it from V2 upward. A policy can never make the exception looser.

### Examples (all are regression tests in `packages/verification/src/engine.test.ts`)

1. A counterparty AFFIRM and no DENY → **V1**.
2. An AFFIRM plus a counterparty DENY, with no V2 certification → V1 fails (`V2_CERTIFICATION_EXCEPTION_NOT_MET`) → **V0 at most**.
3. Example 2 plus a valid V2 declaration and no authorized DENY → the exception applies → **V2, with V1 satisfied**.
4. A valid declaration plus a DENY from an authorized official → `NO_AUTHORIZED_DENY` fails → **V2 blocked**. The exception is not met, so the counterparty DENY also blocks V1 (V0).

## Trust tiers (why certification, and only certification, outranks a participant)

| Tier | Who | What their DENY does |
| --- | --- | --- |
| Participant / counterparty | A principal certainly on a participant's side, or the submitter | Blocks V1 unless the result is fully certified in the same evaluation |
| Registered official (V1) / unaffiliated third party | On no side | A registered official corroborates at V1 without authority. A DENY from a principal with no side and no authority has no standing (`NO_STANDING`) |
| Authorized result authority (V2) | A principal exercising `ATTEST_RESULT`/`DECLARE_OFFICIAL` through a valid, scoped, non-conflicted chain at the fact's time | Always blocks V2, and cancels the exception |

## Consequences

- Both BRT-01 statements hold, with §6's V1 criterion qualified as above. Levels remain cumulative.
- No production producer exists for `RESULT_OFFICIAL` or T5 (ADR-0035), so with real data the exception can never apply today. Real behaviour therefore equals the literal V1 rule. The exception is proven with reference fixtures.
- The exception is computed inside the V1 criterion from the same snapshot. It never depends on an earlier run, on ordering, or on a manual override.

## Alternatives considered

- **Literal cumulative reading (a participant DENY blocks V2 through V1):** contradicts §5.3.
- **Non-cumulative V2 (V2 without V1):** breaks ADR-0005 and every consumer that relies on "V2 ⇒ V1".
- **An official's `RESULT_ACCURATE` outranks the DENY at V1:** broader than §5.3, which ties outranking to certification.
- **`OFFICIAL_DECLARATION` alone triggers the exception:** would let a certification contested by an authorized official still override participants. Rejected in favour of requiring `NO_AUTHORIZED_DENY` too.
