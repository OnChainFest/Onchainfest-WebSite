import type { Uuid } from './ids';
import type { Instant } from './time';

export const DomainEventType = {
  ResultCreated: 'ResultCreated',
  ResultSubmitted: 'ResultSubmitted',
  ResultProvisional: 'ResultProvisional',
  ResultRejected: 'ResultRejected',
  PrincipalRegistered: 'PrincipalRegistered',
  PrincipalKeyRegistered: 'PrincipalKeyRegistered',
  PrincipalKeyStatusChanged: 'PrincipalKeyStatusChanged',
  TrustAnchorRecognized: 'TrustAnchorRecognized',
  TrustAnchorChanged: 'TrustAnchorChanged',
  AuthorityGrantIssued: 'AuthorityGrantIssued',
  AuthorityGrantRevoked: 'AuthorityGrantRevoked',
} as const;
export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

export const AggregateType = {
  RESULT: 'RESULT',
  RESULT_VERSION: 'RESULT_VERSION',
  PRINCIPAL: 'PRINCIPAL',
  PRINCIPAL_KEY: 'PRINCIPAL_KEY',
  TRUST_ANCHOR: 'TRUST_ANCHOR',
  AUTHORITY_GRANT: 'AUTHORITY_GRANT',
} as const;
export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/** BRT-02 system architecture §11.2. Payloads carry ids, hashes and statuses — never PII. */
export interface DomainEvent<
  P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly eventId: Uuid;
  readonly eventType: DomainEventType;
  readonly eventVersion: number;
  readonly aggregateType: AggregateType;
  readonly aggregateId: Uuid;
  readonly occurredAt: Instant;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly actorPrincipalId?: Uuid;
  readonly payload: P;
}
