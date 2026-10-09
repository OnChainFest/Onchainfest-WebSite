import { isWithin, type Instant, type KeyStatusChange, type PrincipalKey } from '@br/domain';

/**
 * Key admissibility for ACCEPTING a new signed statement (BRT-02 §5.1, identity & authority §5.4
 * step 1). Evaluated at T = issuedAt — the platform-observed acceptance time — over every key fact
 * known now (asOf = T). The signer-asserted `signedAt` can only make things STRICTER (a compromise
 * with t₀ ≤ signedAt also refuses); it can never resurrect an expired, rotated, revoked or
 * compromised key, because T is not signer-controlled. No clock slack is applied to key facts.
 *
 * After acceptance the statement is an immutable fact: a later compromise declaration never deletes
 * or rewrites it. Whether it stays eligible for trust ("as known now" vs "as known then") is
 * BRT-07's evaluation, from the key facts the Evidence Bundle carries.
 */
export type KeyAdmissibility =
  | { readonly admissible: true }
  | {
      readonly admissible: false;
      readonly reason:
        | 'KEY_UNKNOWN'
        | 'KEY_NOT_OWNED'
        | 'KEY_NOT_VALID_AT_TIME'
        | 'KEY_REVOKED'
        | 'KEY_COMPROMISED'
        | 'KEY_ALGORITHM_UNSUPPORTED';
    };

export function evaluateKeyAdmissibility(input: {
  readonly key: PrincipalKey | undefined;
  readonly statusChanges: readonly KeyStatusChange[];
  readonly issuerPrincipalId: string;
  /** Platform-observed acceptance time (T). */
  readonly issuedAt: Instant;
  /** Signer assertion; used only to refuse (compromise t₀ ≤ signedAt), never to admit. */
  readonly signedAt?: Instant;
  readonly supportedAlgorithms: readonly string[];
}): KeyAdmissibility {
  const { key } = input;
  if (key === undefined) return { admissible: false, reason: 'KEY_UNKNOWN' };
  if (key.principalId !== input.issuerPrincipalId)
    return { admissible: false, reason: 'KEY_NOT_OWNED' };
  if (key.keyKind !== 'JWK' || !input.supportedAlgorithms.includes(key.algorithm))
    return { admissible: false, reason: 'KEY_ALGORITHM_UNSUPPORTED' };
  const t = input.issuedAt.getTime();
  if (!isWithin(key, input.issuedAt)) return { admissible: false, reason: 'KEY_NOT_VALID_AT_TIME' };
  const signed = input.signedAt?.getTime();
  for (const change of input.statusChanges) {
    if (change.keyId !== key.id) continue;
    // Only facts already recorded at T are known "as of T" (a future-recorded fact cannot exist).
    if (change.recordedAt.getTime() > t) continue;
    if (change.kind === 'COMPROMISED') {
      const t0 = change.compromisedSince.getTime();
      if (t >= t0 || (signed !== undefined && signed >= t0))
        return { admissible: false, reason: 'KEY_COMPROMISED' };
    } else if (change.effectiveFrom.getTime() <= t) {
      return { admissible: false, reason: 'KEY_REVOKED' };
    }
  }
  return { admissible: true };
}
