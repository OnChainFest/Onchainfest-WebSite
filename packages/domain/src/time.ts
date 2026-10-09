/**
 * Time semantics (BRT-02 §5.1, normative):
 *
 * | timestamp        | kind                          |
 * |------------------|-------------------------------|
 * | signedAt         | signer assertion (untrusted)  |
 * | expiresAt        | signer/server assertion        |
 * | receivedAt       | platform-observed              |
 * | issuedAt         | platform-observed acceptance   |
 * | recordedAt       | database transaction time      |
 * | effectiveFrom/To | authority-effective time       |
 * | compromisedSince | authority-effective, retroactive |
 *
 * Online authority is evaluated at `issuedAt`. `signedAt` alone never establishes authority.
 */
export type Instant = Date;

/**
 * Tolerance for EXTERNALLY supplied clocks only: signer-asserted `signedAt`, device clocks,
 * wallet/WebAuthn signature freshness (BRT-02 §5.1 rule 7).
 *
 * It must NEVER be applied to the effective time of platform-recorded authority facts
 * (grants, keys, anchors, ordinary revocations): those must satisfy
 * `effectiveFrom >= recordedAt` exactly — see `assertNotBackdated`.
 */
export const SIGNER_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Strict no-backdating rule for online authority facts (BRT-02 §5.1 rules 3–4, BRT-03R):
 * effective time may equal or follow the trusted platform recording time, never precede it.
 * Future (scheduled) effective times are allowed.
 */
export function isBackdated(effectiveFrom: Instant, recordedAt: Instant): boolean {
  return effectiveFrom.getTime() < recordedAt.getTime();
}

/** Canonical BR-JSON timestamp: UTC, exactly millisecond precision. */
export function toCanonicalTimestamp(instant: Instant): string {
  if (Number.isNaN(instant.getTime())) throw new TypeError('invalid instant');
  return instant.toISOString();
}

export function truncateToMillis(instant: Instant): Instant {
  return new Date(Math.trunc(instant.getTime()));
}

/** Half-open validity interval [from, to). `to === undefined` means open-ended. */
export interface ValidityWindow {
  readonly effectiveFrom: Instant;
  readonly effectiveTo?: Instant;
}

export function isWithin(window: ValidityWindow, at: Instant): boolean {
  const t = at.getTime();
  return (
    t >= window.effectiveFrom.getTime() &&
    (window.effectiveTo === undefined || t < window.effectiveTo.getTime())
  );
}

/** True when `inner` lies entirely within `outer` (open ends treated as +∞). */
export function windowContains(outer: ValidityWindow, inner: ValidityWindow): boolean {
  if (inner.effectiveFrom.getTime() < outer.effectiveFrom.getTime()) return false;
  if (outer.effectiveTo === undefined) return true;
  if (inner.effectiveTo === undefined) return false;
  return inner.effectiveTo.getTime() <= outer.effectiveTo.getTime();
}

/**
 * Temporal context of an act. `issuedAt` is authoritative for online acts.
 * `offlineCapture` is a BRT-03 placeholder for the approved-offline-device exception
 * (BRT-02 §5.1 rule 2); the engine does not honour it yet.
 */
export interface ActTimes {
  readonly signedAt?: Instant;
  readonly receivedAt?: Instant;
  readonly issuedAt: Instant;
  readonly offlineCapture?: OfflineCaptureClaim;
}

export interface OfflineCaptureClaim {
  readonly capturedAt: Instant;
  readonly capturedAtAssurance: 'DEVICE_SIGNED' | 'TRUSTED_TIMESTAMP';
  readonly deviceId: string;
}
