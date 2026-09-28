import {
  newId,
  type AggregateType,
  type DomainEvent,
  type DomainEventType,
  type Uuid,
} from '@br/domain';
import type { OutboxEventTable } from './db';
import type { TxContext } from './tx';

export interface NewDomainEvent {
  readonly eventType: DomainEventType;
  readonly eventVersion?: number;
  readonly aggregateType: AggregateType;
  readonly aggregateId: Uuid;
  readonly actorPrincipalId?: Uuid;
  readonly causationId?: string;
  readonly correlationId?: string;
  /** ids, hashes, statuses only — never PII. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Writes a domain event in the caller's transaction (transactional outbox, ADR-0012). */
export async function emitEvent(ctx: TxContext, event: NewDomainEvent): Promise<DomainEvent> {
  const row: OutboxEventTable = {
    id: newId(),
    event_type: event.eventType,
    event_version: event.eventVersion ?? 1,
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    actor_principal_id: event.actorPrincipalId ?? null,
    causation_id: event.causationId ?? null,
    correlation_id: event.correlationId ?? null,
    payload: event.payload,
    recorded_at: ctx.txTime,
  };
  await ctx.trx.insertInto('platform.outbox_event').values(row).execute();
  return toDomainEvent(row);
}

export function toDomainEvent(row: OutboxEventTable): DomainEvent {
  return {
    eventId: row.id as Uuid,
    eventType: row.event_type as DomainEventType,
    eventVersion: row.event_version,
    aggregateType: row.aggregate_type as AggregateType,
    aggregateId: row.aggregate_id as Uuid,
    occurredAt: row.recorded_at,
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    ...(row.actor_principal_id === null
      ? {}
      : { actorPrincipalId: row.actor_principal_id as Uuid }),
    payload: row.payload as Readonly<Record<string, unknown>>,
  };
}
