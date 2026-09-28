# ADR-0016 — Key management: KMS for platform keys, never custody for third parties

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-02

## Context

The legacy code stored private keys and mnemonics in databases and environment variables (BRT-00 C-2, H-9, H-11), and used hot oracle keys (C-8). The platform itself needs signing (attestations, witness), anchoring and, later, settlement.

## Decision

1. **Platform keys are non-exportable cloud KMS/HSM keys, each with a separate purpose and IAM role:**
   - governance: individual keys, with **M-of-N** for anchor decisions;
   - platform signing;
   - platform witness: MFA-bound flow only;
   - anchoring: holds gas funds only;
   - data-encryption keys;
   - commitment-salt encryption.
2. **Settlement keys are never a single hot key.** Multisig or threshold signing plus policy co-signing; design deferred to the Prize Rail phase.
3. **Integration secrets live in a secret manager**, never in the DB or the repository.
4. **Third-party keys are never held.** This covers athletes, officials, organizations, federations, devices and embedded wallets. The platform stores public keys, addresses (CAIP-10), proofs and status only.
5. **Rotation cadence** is defined per key, every use is audited, and KMS logs are exported to tamper-evident storage.
6. **Regression guards:** CI secret scanning, and a schema lint that forbids key-material column names.

## Consequences

**Benefits:**

- Insider and external key theft is limited.
- Non-custodial posture.

**Costs:**

- A KMS vendor dependency. Abstracted behind the Crypto module's signer interface.
