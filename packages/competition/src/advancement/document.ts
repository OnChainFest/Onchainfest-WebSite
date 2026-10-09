import { platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { AdvancementAssignment } from './resolve';

/**
 * Canonical advancement documents (ADR-0065), hashed by the platform canonicalizer exactly like
 * every other BR document (no second hashing mechanism):
 *   · `br:advancement-assignment@1` — one target's state + structured provenance; its hash is the
 *     `digest` stored with each committed fact (equal digest ⇔ same entrant for the same reasons);
 *   · `br:advancement-decision@1` — one unit's decision (preview or committed), assignments in
 *     target order. No timestamps, no actor, no random ids: identical inputs ⇒ identical hash.
 */
export const ADVANCEMENT_ENGINE = 'advancement-engine/1';

export interface AdvancementPolicyRef {
  readonly code: string;
  readonly version: number;
  readonly specHash: string;
}

export type DigestedAssignment = AdvancementAssignment & { readonly digest: string };

export interface AdvancementDecisionDocument {
  readonly engine: typeof ADVANCEMENT_ENGINE;
  readonly eventId: string;
  readonly unit: string;
  readonly kind: 'RESOLUTION' | 'OVERRIDE' | 'OVERRIDE_REVOKED';
  readonly policy: AdvancementPolicyRef;
  readonly reason?: string;
  readonly assignments: readonly DigestedAssignment[];
}

/** JSON without `undefined` members (the canonical form has no undefined). */
function clean<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function assignmentDigest(a: AdvancementAssignment): string {
  return platformCanonicalizer().hashCanonical(
    'ledger-fact',
    SchemaRef.advancementAssignment.id,
    SchemaRef.advancementAssignment.version,
    clean({
      target: a.target,
      state: a.state,
      ...(a.participantId === undefined ? {} : { participantId: a.participantId }),
      ...(a.reason === undefined ? {} : { reason: a.reason }),
      provenance: a.provenance,
    }),
  ).contentHash;
}

/** Deterministic target order: contest slots by (contestId, slot); fields by (transition, ordinal). */
export function targetKey(t: AdvancementAssignment['target']): string {
  return t.kind === 'SLOT'
    ? `slot:${t.contestId}:${String(t.slot).padStart(2, '0')}`
    : `field:${t.transitionKey}:${String(t.ordinal).padStart(5, '0')}`;
}

export function advancementDecision(input: {
  eventId: string;
  unit: string;
  kind: AdvancementDecisionDocument['kind'];
  policy: AdvancementPolicyRef;
  reason?: string;
  assignments: readonly AdvancementAssignment[];
}): { document: AdvancementDecisionDocument; hash: string } {
  const assignments = [...input.assignments]
    .sort((a, b) => (targetKey(a.target) < targetKey(b.target) ? -1 : 1))
    .map((a) => clean({ ...a, digest: assignmentDigest(a) }));
  const document: AdvancementDecisionDocument = clean({
    engine: ADVANCEMENT_ENGINE,
    eventId: input.eventId,
    unit: input.unit,
    kind: input.kind,
    policy: input.policy,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    assignments,
  });
  const hash = platformCanonicalizer().hashCanonical(
    'ledger-fact',
    SchemaRef.advancementDecision.id,
    SchemaRef.advancementDecision.version,
    document,
  ).contentHash;
  return { document, hash };
}
