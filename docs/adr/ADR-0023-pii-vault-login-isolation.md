# ADR-0023 — PII vault behind a dedicated login and an envelope-encryption port

- **Status:** Proposed
- **Date:** 2026-09-28
- **Origin:** BRT-04 (implements BRT-02 data-access model "PII vault isolation"; complements ADR-0009, ADR-0016)

## Context

BRT-02 requires personal data to be isolated from the rest of the platform. BRT-03R established one login per trust boundary, with NOINHERIT module roles. If the API login could assume the vault role, any SQL injection or logic bug on the API path could reach PII.

## Decision

1. **A dedicated login.** Private attributes live only in `identity_private.person_private`.
   - Only `br_identity_private` has privileges there, and only the dedicated login **`br_api_vault`** can assume it.
   - `br_api`, worker, maintenance and probe cannot. Membership is `INHERIT FALSE, SET TRUE, ADMIN FALSE`.
   - The vault role cannot DELETE; erasure is an explicit nulling update.
2. **An encryption port.** Values are stored as AES-256-GCM envelopes through the `PiiCipher` port, with the field name as AAD and a key id in each envelope. Idempotency fingerprints of PII use the cipher's keyed HMAC.
3. **The development cipher is honest about its limits.** It derives its key from an environment variable, refuses to run in production, and is **not** a KMS (no rotation, no HSM).
4. **Production fails closed.** With no KMS-backed cipher configured, the API does not register private-data endpoints' storage, and they answer `503 PRIVATE_DATA_UNAVAILABLE`.
5. **Authorization inside the vault transaction (BRT-04R).** Each vault operation first calls `identity_private.authorize_private_data(account, person)`:
   - It is `SECURITY DEFINER`, with `search_path = pg_catalog, pg_temp`, EXECUTE only for `br_identity_private`, and it returns a boolean.
   - It checks SELF control by an ACTIVE account under shared advisory locks that revocations take exclusively.
   - The vault role gains no identity grants, and guardians never access private data.
6. **No built-in keys (BRT-04R).** The development cipher requires explicit key material, or an explicitly requested ephemeral key.

## Consequences

**Benefits:**

- API-path compromise does not expose PII.
- Database dumps expose only ciphertext (subject to key handling).

**Costs:**

- Person creation and the vault write are two transactions on two logins. They are not atomic; an idempotent upsert makes retries converge.
- There is no check-then-use window. The price is a narrowly scoped SECURITY DEFINER function owned by the migration owner, and brief lock waits between vault operations and revocations for the same account or person.
- A KMS integration is still required before production can store PII.

## Alternatives considered

- **Same login, different role:** rejected. Any API compromise could `SET ROLE` to the vault.
- **pgcrypto in SQL:** rejected. Keys would reach the database session.
- **Storing PII unencrypted behind roles only:** rejected. It gives no protection for dumps or backups.
