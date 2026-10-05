import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

// int8 (bigint) → number. Sequences stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds the safe integer range`);
  return n;
});

type Json = unknown;

export interface LedgerEntryTable {
  id: string;
  stream_id: string;
  stream_type: string;
  sequence: number;
  previous_hash: string;
  entry_hash: string;
  payload_hash: string;
  event_type: string;
  fact_table: string;
  fact_row_id: string;
  recorded_at: Date;
}

export interface StreamHeadTable {
  stream_id: string;
  stream_type: string;
  last_sequence: number;
  last_hash: string;
  updated_at: Date;
}

export interface OutboxEventTable {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_principal_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  payload: Json;
  recorded_at: Date;
}

export interface OutboxConsumptionTable {
  consumer: string;
  event_id: string;
  recorded_at?: Date;
}

export interface CommandIdempotencyTable {
  scope: string;
  idempotency_key: string;
  command_type: string;
  request_hash: string;
  response: Json;
  recorded_at: Date;
}

export interface JobTable {
  id: string;
  kind: string;
  payload: Json;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  run_after: Date;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface PrincipalTable {
  id: string;
  principal_type: string;
  label: string;
  fact_hash: string;
  recorded_at: Date;
}

export interface PrincipalKeyTable {
  id: string;
  principal_id: string;
  key_kind: string;
  algorithm: string;
  verification_material: Json;
  effective_from: Date;
  effective_to: Date | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface PrincipalKeyStatusChangeTable {
  id: string;
  key_id: string;
  kind: string;
  effective_from: Date;
  compromised_since: Date | null;
  reason: string;
  declared_by_principal_id: string | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface TrustAnchorTable {
  id: string;
  principal_id: string;
  recognition_scope: Json;
  basis_ref: string;
  governance_decision_ref: string;
  effective_from: Date;
  effective_to: Date | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface TrustAnchorStatusChangeTable {
  id: string;
  anchor_id: string;
  kind: string;
  effective_from: Date;
  reason: string;
  fact_hash: string;
  recorded_at: Date;
}

export interface AuthorityGrantTable {
  id: string;
  grantor_principal_id: string;
  grantee_principal_id: string;
  parent_grant_id: string | null;
  capabilities: string[];
  scope: Json;
  delegation: Json;
  constraints: Json;
  effective_from: Date;
  effective_to: Date | null;
  grant_hash: string;
  grantor_signature: Json | null;
  recorded_at: Date;
}

export interface AuthorityGrantStatusChangeTable {
  id: string;
  grant_id: string;
  kind: string;
  compromise: boolean;
  effective_from: Date;
  reason: string;
  declared_by_principal_id: string | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface ResultTable {
  id: string;
  scope_type: string;
  scope_target_id: string;
  fact_hash: string;
  recorded_at: Date;
}

export interface ResultDraftTable {
  id: string;
  result_id: string;
  author_principal_id: string;
  discipline_version_ref: string;
  content: Json;
  submitted_version_id: string | null;
  updated_at: Date;
}

export interface ResultVersionTable {
  id: string;
  result_id: string;
  version_number: number;
  discipline_version_ref: string;
  content_schema: string;
  content: Json;
  content_hash: string;
  submitted_by_principal_id: string;
  supersedes_version_id: string | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface ResultStatusTransitionTable {
  id: string;
  result_version_id: string;
  from_status: string | null;
  to_status: string;
  transition_code: string;
  actor_principal_id: string;
  authorization_proof_digest: string;
  reason: string | null;
  fact_hash: string;
  recorded_at: Date;
}

export interface ResultVersionStateTable {
  result_version_id: string;
  result_id: string;
  current_status: string;
  hold: boolean;
  updated_at: Date;
}

export interface ResultStateTable {
  result_id: string;
  current_version_id: string | null;
  latest_version_number: number;
  updated_at: Date;
}

export interface Database {
  'platform.ledger_entry': LedgerEntryTable;
  'platform.stream_head': StreamHeadTable;
  'platform.outbox_event': OutboxEventTable;
  'platform.outbox_consumption': OutboxConsumptionTable;
  'platform.command_idempotency': CommandIdempotencyTable;
  'platform.job': JobTable;
  'authority.principal': PrincipalTable;
  'authority.principal_key': PrincipalKeyTable;
  'authority.principal_key_status_change': PrincipalKeyStatusChangeTable;
  'authority.trust_anchor': TrustAnchorTable;
  'authority.trust_anchor_status_change': TrustAnchorStatusChangeTable;
  'authority.authority_grant': AuthorityGrantTable;
  'authority.authority_grant_status_change': AuthorityGrantStatusChangeTable;
  'results.result': ResultTable;
  'results.result_draft': ResultDraftTable;
  'results.result_version': ResultVersionTable;
  'results.result_status_transition': ResultStatusTransitionTable;
  'results.result_version_state': ResultVersionStateTable;
  'results.result_state': ResultStateTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
