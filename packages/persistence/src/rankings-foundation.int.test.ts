import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { newId } from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import {
  apiDb,
  buildAuthorityWorld,
  declaredNoParticipation,
  maintenanceDb,
  newTestAccount,
  operatorDb,
  ownerDb,
  probeDb,
  seedTestCatalog,
  type AuthorityWorld,
} from '@br/testkit';
import {
  createRankingFixtureDatabase,
  rankingOperatorDb,
  rankingWorkerDb,
  type RankingFixtureDatabase,
} from '@br/testkit/rankings';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  databaseUrls,
  operatorDatabaseUrl,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
} from './config';
import { createDb, type Db } from './db';
import { IdentityStore } from './identity-store';
import { listMigrations } from './migrate';
import { ResultLedger } from './result-ledger';
import { inTransaction, ModuleRole, type ModuleRole as Role, type TxContext } from './tx';

/**
 * BRT-10 Step 4 — persistence foundation (migrations 0023–0025, roles, grants, constraints).
 * No ranking store / writer exists yet: rows are written with direct SQL under the exact module role
 * the later validated writers will use. REFERENCE FIXTURES — NOT SPORTING TRUTH.
 */
const DENIED = { code: '42501' };
const APPEND_ONLY = { code: 'BR001' };
const CHECK = { code: '23514' };
const UNIQUE = { code: '23505' };
const h = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;
const hashOf = (tag: string, ref: { id: string; version: number }, doc: unknown) => {
  const r = platformCanonicalizer().hashCanonical(tag, ref.id, ref.version, doc);
  return { hash: r.contentHash as string, doc: r.normalized as Record<string, unknown> };
};
const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;
const asRole = <T>(db: Db, role: Role, fn: (ctx: TxContext) => Promise<T>) =>
  inTransaction(db, role, fn, 1);
const randomHash = () => `sha256:${randomBytes(32).toString('hex')}`;
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));

// ───────────────────────────── fixture builders (direct SQL) ─────────────────────────────

const FUTURE = '2099-01-01T00:00:00.000Z';
const systemSpec = (dv: string, patch: Record<string, unknown> = {}) => ({
  targetEngine: 'ranking-engine/1',
  displayName: 'Fictional 5K best marks',
  kind: 'PLATFORM',
  method: 'BEST_MARK',
  universe: {
    disciplineVersionId: dv,
    metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
    resultScope: 'CONTEST',
    holderType: 'ATHLETE',
    population: {},
  },
  comparator: { keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }] },
  requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
  recognition: { level: 'PLATFORM', sport: ['running'] },
  effectiveFrom: FUTURE,
  ...patch,
});

interface World {
  readonly api: Db;
  readonly owner: Db;
  readonly rop: Db;
  readonly rw: Db;
  readonly accountId: string;
  readonly dv: string;
}

async function createSystem(w: World, kind = 'PLATFORM') {
  const id = newId();
  await asRole(w.rop, ModuleRole.rankingRules, (ctx) =>
    sql`INSERT INTO ranking.system (id, code, name, kind, created_by_account_id, recorded_at)
        VALUES (${id}, ${`rk-${newId().slice(-12)}`}, 'Fictional system', ${kind}, ${w.accountId}, ${ctx.txTime})`.execute(
      ctx.trx,
    ),
  );
  return id;
}

async function createVersion(
  w: World,
  systemId: string,
  version: number,
  spec: Record<string, unknown>,
) {
  const s = hashOf(DomainTag.rankingSystemVersion, SchemaRef.rankingSystemVersion, spec);
  const u = hashOf(DomainTag.rankingUniverse, SchemaRef.rankingUniverse, {
    method: s.doc.method,
    universe: s.doc.universe,
    comparator: s.doc.comparator,
  });
  const d = s.doc as {
    targetEngine: string;
    kind: string;
    universe: { holderType: string };
    requirements: { minimumVerificationLevel: string };
    recognition: { level: string };
    owner?: { principalId: string; anchorId: string };
  };
  const id = newId();
  await asRole(w.rop, ModuleRole.rankingRules, (ctx) =>
    sql`INSERT INTO ranking.system_version (id, system_id, version, spec, spec_schema, spec_hash, universe_hash,
          target_engine, kind, method, discipline_version_id, metric_key, mark_metric_id, holder_type,
          minimum_verification_level, recognition_level, owner_principal_id, owner_anchor_id, effective_from,
          created_by_account_id, recorded_at)
        VALUES (${id}, ${systemId}, ${version}, ${json(s.doc)}, 'br:ranking-system-version@1', ${s.hash}, ${u.hash},
          ${d.targetEngine}, ${d.kind}, 'BEST_MARK', ${w.dv}, 'elapsedTimeMs', 'running.elapsed_time',
          ${d.universe.holderType}, ${d.requirements.minimumVerificationLevel}, ${d.recognition.level},
          ${d.owner?.principalId ?? null}, ${d.owner?.anchorId ?? null}, ${String(s.doc.effectiveFrom)},
          ${w.accountId}, ${ctx.txTime})`.execute(ctx.trx),
  );
  return { id, specHash: s.hash, universeHash: u.hash };
}

const setStatus = (w: World, versionId: string, status: 'PUBLISHED' | 'RETIRED') =>
  asRole(w.rop, ModuleRole.rankingRules, (ctx) =>
    sql`INSERT INTO ranking.system_version_status_change (id, system_version_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${versionId}, ${status}, ${w.accountId}, ${ctx.txTime})`.execute(
      ctx.trx,
    ),
  );

async function publishedSystem(w: World) {
  const systemId = await createSystem(w);
  const v = await createVersion(w, systemId, 1, systemSpec(w.dv));
  await setStatus(w, v.id, 'PUBLISHED');
  return { systemId, ...v };
}

const mark = (value: string) => ({
  metricId: 'running.elapsed_time',
  value,
  unit: 'ms',
  precision: 0,
});
const basis = () => ({
  resultId: newId(),
  resultVersionId: newId(),
  contentHash: h('a'),
  resultStatus: 'FINAL',
  competitionId: newId(),
  eventId: newId(),
  contestId: newId(),
  participantId: newId(),
  performanceOrdinal: 1,
  verificationRunId: newId(),
  verificationSnapshotHash: h('b'),
  verificationOutcomeHash: h('c'),
  verificationLevel: 'V2',
  evidenceBundleHash: h('d'),
  evidenceBundleAsOf: '2027-03-02T00:00:00.000Z',
  evidenceCommitment: h('e'),
  hold: 'ABSENT',
  occurredAt: '2027-03-01T10:00:00.000Z',
});
const entry = (rank: number, tied: boolean, value: string) => ({
  rank,
  tied,
  holder: { holderType: 'ATHLETE', holderId: newId() },
  value: mark(value),
  comparatorTrace: [{ key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', value }],
  basis: [basis()],
});

interface Sys {
  readonly systemId: string;
  readonly id: string;
  readonly specHash: string;
}

async function insertRun(
  w: World,
  sys: Sys,
  opts: { provenance?: string; entries?: unknown[]; blocked?: boolean; inputHash?: string } = {},
) {
  const provenance = opts.provenance ?? 'REFERENCE_FIXTURE';
  const entries = opts.entries ?? [entry(1, true, '900000'), entry(1, true, '900000')];
  const outcomeDoc = {
    engineVersion: 'ranking-engine/1',
    provenance,
    systemVersionId: sys.id,
    specHash: sys.specHash,
    asOf: '2027-06-01T00:00:00.000Z',
    publication: opts.blocked
      ? { state: 'BLOCKED', reasons: ['NO_RANKED_ENTRIES'] }
      : { state: 'PUBLISHABLE', reasons: [] },
    entries,
    candidates: [],
  };
  // A distinct inputs digest per run unless pinned (the engine input itself is not persisted).
  const inputHash = opts.inputHash ?? randomHash();
  const o = hashOf(DomainTag.rankingRunOutcome, SchemaRef.rankingRunOutcome, {
    ...outcomeDoc,
    inputHash,
  });
  const id = newId();
  const pub = o.doc.publication as { state: string; reasons: string[] };
  await asRole(w.rw, ModuleRole.rankings, (ctx) =>
    sql`INSERT INTO ranking.run (id, system_id, system_version_id, spec_hash, engine_version, provenance, input_hash,
          outcome_hash, outcome, as_of, publication_state, publication_reasons, entry_count, candidate_count, trigger, recorded_at)
        VALUES (${id}, ${sys.systemId}, ${sys.id}, ${sys.specHash}, 'ranking-engine/1', ${provenance}, ${inputHash},
          ${o.hash}, ${json(o.doc)}, ${'2027-06-01T00:00:00.000Z'}, ${pub.state}, ${pub.reasons},
          ${(o.doc.entries as unknown[]).length}, 0, 'STAFF_REQUEST', ${ctx.txTime})`.execute(
      ctx.trx,
    ),
  );
  return {
    id,
    inputHash,
    outcomeHash: o.hash,
    entries: o.doc.entries as Record<string, unknown>[],
    provenance,
  };
}

type Run = Awaited<ReturnType<typeof insertRun>>;
interface Lineage {
  readonly kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly prior?: { id: string; hash: string };
  readonly reasons?: string[];
}

function snapshotContent(sys: Sys, run: Run, lineage: Lineage) {
  return hashOf(DomainTag.rankingSnapshot, SchemaRef.rankingSnapshot, {
    systemId: sys.systemId,
    systemVersionId: sys.id,
    specHash: sys.specHash,
    kind: 'PLATFORM',
    method: 'BEST_MARK',
    engineVersion: 'ranking-engine/1',
    provenance: run.provenance,
    runInputHash: run.inputHash,
    runOutcomeHash: run.outcomeHash,
    asOf: '2027-06-01T00:00:00.000Z',
    lineage: {
      kind: lineage.kind,
      ...(lineage.prior === undefined
        ? {}
        : { priorSnapshotId: lineage.prior.id, priorSnapshotHash: lineage.prior.hash }),
      ...(lineage.reasons === undefined ? {} : { reasons: lineage.reasons }),
    },
    entries: run.entries,
  });
}

/** Publishes a snapshot of `run` (+ every entry) in one transaction; overrides simulate forgeries. */
async function insertSnapshot(
  w: World,
  sys: Sys,
  run: Run,
  lineage: Lineage = { kind: 'INITIAL' },
  over: { snapshotHash?: string; skipEntries?: boolean; tamperEntry?: boolean } = {},
) {
  const c = snapshotContent(sys, run, lineage);
  const id = newId();
  const entries = c.doc.entries as Record<string, unknown>[];
  await asRole(w.rw, ModuleRole.rankings, async (ctx) => {
    await sql`INSERT INTO ranking.snapshot (id, system_id, system_version_id, spec_hash, run_id, run_input_hash,
          run_outcome_hash, snapshot_hash, content, kind, method, engine_version, provenance, as_of, lineage_kind,
          previous_snapshot_id, corrects_snapshot_id, prior_snapshot_hash, lineage_reasons, entry_count, recorded_at)
        VALUES (${id}, ${sys.systemId}, ${sys.id}, ${sys.specHash}, ${run.id}, ${run.inputHash}, ${run.outcomeHash},
          ${over.snapshotHash ?? c.hash}, ${json(c.doc)}, 'PLATFORM', 'BEST_MARK', 'ranking-engine/1', ${run.provenance},
          ${'2027-06-01T00:00:00.000Z'}, ${lineage.kind},
          ${lineage.kind === 'FOLLOWS' ? (lineage.prior?.id ?? null) : null},
          ${lineage.kind === 'CORRECTS' ? (lineage.prior?.id ?? null) : null},
          ${lineage.prior?.hash ?? null}, ${lineage.reasons ?? []}, ${entries.length}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    if (over.skipEntries) return;
    for (const [i, e] of entries.entries()) {
      const holder = e.holder as { holderType: string; holderId: string };
      await sql`INSERT INTO ranking.snapshot_entry (snapshot_id, holder_type, holder_id, rank, tied, value,
            comparator_trace, basis, recorded_at)
          VALUES (${id}, ${holder.holderType}, ${holder.holderId}, ${over.tamperEntry && i === 0 ? 99 : (e.rank as number)},
            ${e.tied as boolean}, ${json(e.value)}, ${json(e.comparatorTrace)}, ${json(e.basis)}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
    }
  });
  return { id, hash: over.snapshotHash ?? c.hash };
}

async function makeWorld(api: Db, owner: Db, rop: Db, rw: Db, op: Db): Promise<World> {
  const identity = new IdentityStore(api);
  const catalog = await seedTestCatalog(identity, new CatalogStore(op));
  const { accountId } = await newTestAccount(identity, {
    withPerson: false,
    label: 'ranking-operator',
  });
  return { api, owner, rop, rw, accountId, dv: catalog.running5k };
}

// ═════════════════════════════ normal (canonical) integration database ═════════════════════════════

const api = apiDb();
const owner = ownerDb();
const probe = probeDb();
const maintenance = maintenanceDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const op = operatorDb();
let w: World;

beforeAll(async () => {
  w = await makeWorld(api, owner, rop, rw, op);
}, 120_000);
afterAll(async () => {
  await Promise.all([api, owner, probe, maintenance, rop, rw, op].map((d) => d.destroy()));
});

describe('BRT-10 migrations 0023–0025', () => {
  it('1–2. apply cleanly, in order, right after 0001–0022', async () => {
    const { rows } = await sql<{ version: string; name: string }>`
      SELECT version, name FROM br_migrations.applied ORDER BY version`.execute(owner);
    const files = listMigrations().map((m) => m.version);
    expect(rows.map((r) => r.version)).toEqual(files);
    const at = files.indexOf('0022');
    expect(files.slice(at, at + 4)).toEqual(['0022', '0023', '0024', '0025']);
    expect(rows.slice(at + 1, at + 4).map((r) => r.name)).toEqual([
      '0023_classification_derivation.sql',
      '0024_ranking_systems.sql',
      '0025_ranking_runs_snapshots.sql',
    ]);
  });

  it('3–4. required tables and columns exist', async () => {
    const { rows } = await sql<{ t: string }>`
      SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
      WHERE (table_schema = 'ranking' OR (table_schema = 'results' AND table_name LIKE 'classification\\_%')) AND table_type = 'BASE TABLE'
      ORDER BY 1`.execute(owner);
    expect(rows.map((r) => r.t)).toEqual([
      'ranking.classification_policy',
      'ranking.classification_policy_version',
      'ranking.classification_policy_version_status_change',
      'ranking.run',
      'ranking.run_dependency',
      'ranking.snapshot',
      'ranking.snapshot_entry',
      'ranking.system',
      'ranking.system_version',
      'ranking.system_version_status_change',
      'results.classification_derivation',
      'results.classification_input',
    ]);
    const cols = async (schema: string, table: string) =>
      (
        await sql<{ c: string }>`SELECT column_name AS c FROM information_schema.columns
          WHERE table_schema = ${schema} AND table_name = ${table}`.execute(owner)
      ).rows.map((r) => r.c);
    expect(await cols('ranking', 'system_version')).toEqual(
      expect.arrayContaining([
        'spec',
        'spec_hash',
        'universe_hash',
        'kind',
        'method',
        'minimum_verification_level',
        'recognition_level',
        'owner_principal_id',
        'owner_anchor_id',
        'effective_from',
      ]),
    );
    expect(await cols('ranking', 'run')).toEqual(
      expect.arrayContaining([
        'system_version_id',
        'spec_hash',
        'input_hash',
        'outcome_hash',
        'as_of',
        'engine_version',
        'trigger',
        'publication_state',
        'publication_reasons',
        'provenance',
      ]),
    );
    expect(await cols('ranking', 'snapshot')).toEqual(
      expect.arrayContaining([
        'run_id',
        'snapshot_hash',
        'content',
        'run_input_hash',
        'run_outcome_hash',
        'as_of',
        'previous_snapshot_id',
        'corrects_snapshot_id',
        'prior_snapshot_hash',
        'lineage_kind',
        'entry_count',
      ]),
    );
    expect(await cols('results', 'classification_input')).toEqual(
      expect.arrayContaining([
        'classification_version_id',
        'input_result_version_id',
        'input_content_hash',
        'input_status',
      ]),
    );
    // BRT-10 added no mutable rank / position / points / qualified column to any sporting row.
    const { rows: leaked } = await sql<{ c: string }>`
      SELECT table_schema || '.' || table_name || '.' || column_name AS c FROM information_schema.columns
      WHERE table_schema IN ('identity', 'competition', 'results', 'passport')
        AND column_name ~ '(^|_)(rank|ranking|position|points|qualified|standing)(_|$)'`.execute(
      owner,
    );
    // Only the pre-existing BRT-05 seeding source (a RANK_FROM_STAGE slot input, never a standing).
    expect(leaked).toEqual([{ c: 'competition.contestant.source_rank' }]);
  });

  it('5. important constraints and append-only triggers exist', async () => {
    const { rows } = await sql<{ n: string }>`
      SELECT conname AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid = c.connamespace
      WHERE s.nspname IN ('ranking', 'results')`.execute(owner);
    expect(rows.map((r) => r.n)).toEqual(
      expect.arrayContaining([
        'system_version_number_key',
        'system_version_spec_key',
        'system_version_pin_key',
        'system_version_kind_coherence',
        'classification_policy_version_pin_key',
        'classification_derivation_policy_pin_fk',
        'ranking_run_identity_key',
        'run_canonical_provenance_only',
        'snapshot_hash_key',
        'snapshot_run_key',
        'snapshot_lineage_coherence',
        'snapshot_canonical_provenance_only',
      ]),
    );
    const { rows: idx } = await sql<{ n: string }>`
      SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'ranking'`.execute(owner);
    expect(idx.map((r) => r.n)).toEqual(
      expect.arrayContaining(['snapshot_followed_once', 'snapshot_corrected_once']),
    );
    const { rows: trg } = await sql<{ t: string }>`
      SELECT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE (s.nspname = 'ranking' OR c.relname LIKE 'classification\\_%') AND g.tgname LIKE '%\\_append\\_only'
      ORDER BY 1`.execute(owner);
    expect(trg).toHaveLength(12);
  });

  it('14. migrations 0001–0022 are byte-identical to HEAD', () => {
    const repo = new URL('../../../', import.meta.url).pathname;
    for (const m of listMigrations().filter((x) => x.version <= '0022')) {
      const path = `db/migrations/${m.name}`;
      const committed = execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: repo })
        .toString()
        .trim();
      const working = execFileSync('git', ['hash-object', path], { cwd: repo }).toString().trim();
      expect(`${m.name}:${working}`).toBe(`${m.name}:${committed}`);
    }
  });
});

describe('ranking systems: immutable versions, one universe, raise-only floors', () => {
  it('6. a published version is immutable (UPDATE / DELETE / TRUNCATE refused, even for the owner)', async () => {
    const s = await publishedSystem(w);
    for (const stmt of [
      sql`UPDATE ranking.system_version SET spec = '{}'::jsonb WHERE id = ${s.id}`,
      sql`DELETE FROM ranking.system_version WHERE id = ${s.id}`,
      sql`UPDATE ranking.system SET name = 'renamed' WHERE id = ${s.systemId}`,
      sql`DELETE FROM ranking.system_version_status_change WHERE system_version_id = ${s.id}`,
      sql`TRUNCATE ranking.system_version CASCADE`,
    ])
      await expect(stmt.execute(owner)).rejects.toMatchObject(APPEND_ONLY);
  });

  it('a new version keeps the universe and kind; lifecycle is DRAFT → PUBLISHED → RETIRED, never backdated', async () => {
    const s = await publishedSystem(w);
    // Raised floor: same universe ⇒ a valid v2.
    const v2 = await createVersion(
      w,
      s.systemId,
      2,
      systemSpec(w.dv, {
        requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
      }),
    );
    expect(v2.universeHash).toBe(s.universeHash);
    // Another universe (window) ⇒ a different system.
    await expect(
      createVersion(
        w,
        s.systemId,
        3,
        systemSpec(w.dv, {
          universe: { ...systemSpec(w.dv).universe, window: { from: '2027-01-01T00:00:00.000Z' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BR171' });
    // Same spec again ⇒ duplicate immutable identity.
    await expect(createVersion(w, s.systemId, 4, systemSpec(w.dv))).rejects.toMatchObject(UNIQUE);
    await expect(setStatus(w, s.id, 'PUBLISHED')).rejects.toMatchObject({ code: 'BR173' });
    await setStatus(w, s.id, 'RETIRED');
    await expect(setStatus(w, v2.id, 'RETIRED')).rejects.toMatchObject({ code: 'BR173' });
    // effective_from before publication ⇒ refused.
    const past = await createVersion(
      w,
      s.systemId,
      5,
      systemSpec(w.dv, {
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        requirements: { minimumVerificationLevel: 'V4', minimumResultStatus: 'FINAL' },
      }),
    );
    await expect(setStatus(w, past.id, 'PUBLISHED')).rejects.toMatchObject({ code: 'BR174' });
  });

  it('floors and kind coherence are structural: PLATFORM ≥ V2 without owner; OFFICIAL needs an anchored owner', async () => {
    const sysId = await createSystem(w);
    await expect(
      createVersion(
        w,
        sysId,
        1,
        systemSpec(w.dv, {
          requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
        }),
      ),
    ).rejects.toMatchObject(CHECK);
    await expect(
      createVersion(w, sysId, 1, systemSpec(w.dv, { kind: 'OFFICIAL' })),
    ).rejects.toMatchObject({ code: 'BR170' });
    const off = await createSystem(w, 'OFFICIAL');
    await expect(
      createVersion(
        w,
        off,
        1,
        systemSpec(w.dv, {
          kind: 'OFFICIAL',
          requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
          recognition: { level: 'NATIONAL', sport: ['running'], region: ['CR'] },
          owner: { principalId: newId(), anchorId: newId() },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BR172' }); // the owner must be the principal of a real trust anchor
  });
});

describe('runs and snapshots in the NORMAL schema (canonical only)', () => {
  it('7. an empty RankingSnapshot is not representable', async () => {
    const s = await publishedSystem(w);
    const run = await insertRun(w, s, { provenance: 'CANONICAL_ASSEMBLY', entries: [] });
    // Even a (hypothetically) PUBLISHABLE empty run cannot become a snapshot.
    await expect(
      asRole(w.rw, ModuleRole.rankings, (ctx) =>
        sql`INSERT INTO ranking.snapshot (id, system_id, system_version_id, spec_hash, run_id, run_input_hash,
              run_outcome_hash, snapshot_hash, content, kind, method, engine_version, provenance, as_of, lineage_kind,
              entry_count, recorded_at)
            VALUES (${newId()}, ${s.systemId}, ${s.id}, ${s.specHash}, ${run.id}, ${run.inputHash}, ${run.outcomeHash},
              ${h('9')}, ${json({
                systemId: s.systemId,
                systemVersionId: s.id,
                specHash: s.specHash,
                kind: 'PLATFORM',
                method: 'BEST_MARK',
                engineVersion: 'ranking-engine/1',
                provenance: 'CANONICAL_ASSEMBLY',
                runInputHash: run.inputHash,
                runOutcomeHash: run.outcomeHash,
                asOf: '2027-06-01T00:00:00.000Z',
                lineage: { kind: 'INITIAL' },
                entries: [],
              })}, 'PLATFORM', 'BEST_MARK', 'ranking-engine/1', 'CANONICAL_ASSEMBLY', ${'2027-06-01T00:00:00.000Z'},
              'INITIAL', 0, ${ctx.txTime})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(CHECK);
  });

  it('fixture provenance never reaches the normal schema; a canonical entry needs a canonical FINAL basis', async () => {
    const s = await publishedSystem(w);
    await expect(insertRun(w, s, { provenance: 'REFERENCE_FIXTURE' })).rejects.toMatchObject(CHECK);
    // No FINAL producer exists, so a canonical snapshot can never be completed today (honest ceiling).
    const run = await insertRun(w, s, { provenance: 'CANONICAL_ASSEMBLY' });
    await expect(insertSnapshot(w, s, run)).rejects.toMatchObject({ code: 'BR181' });
    const { rows } = await sql<{
      n: string;
    }>`SELECT count(*)::text AS n FROM ranking.snapshot`.execute(owner);
    expect(rows[0]?.n).toBe('0');
  });

  it('10. a run is unique on (system version, inputs digest); run columns must equal the outcome', async () => {
    const s = await publishedSystem(w);
    const run = await insertRun(w, s, {
      provenance: 'CANONICAL_ASSEMBLY',
      blocked: true,
      entries: [],
    });
    await expect(
      insertRun(w, s, {
        provenance: 'CANONICAL_ASSEMBLY',
        blocked: true,
        entries: [],
        inputHash: run.inputHash,
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ranking_run_identity_key' });
    await expect(
      asRole(w.rw, ModuleRole.rankings, (ctx) =>
        sql`INSERT INTO ranking.run (id, system_id, system_version_id, spec_hash, engine_version, provenance, input_hash,
              outcome_hash, outcome, as_of, publication_state, publication_reasons, entry_count, candidate_count, trigger, recorded_at)
            SELECT ${newId()}, system_id, system_version_id, spec_hash, engine_version, provenance, ${h('7')},
              outcome_hash, outcome, as_of, 'PUBLISHABLE', '{}', entry_count, candidate_count, trigger, ${ctx.txTime}
            FROM ranking.run WHERE id = ${run.id}`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject({ code: 'BR175' });
  });
});

// ═════════════════════════════ classification derivation (normal schema) ═════════════════════════════

describe('classification derivation: `@2` versions only through the ledger role, with exact provenance', () => {
  const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
  const ledger = new ResultLedger(api, { conflictChecker: declaredNoParticipation });
  let aw: AuthorityWorld;
  let input: { resultVersionId: string; contentHash: string };
  let policy: { policyId: string; policyVersionId: string; specHash: string };
  const P1 = newId();

  beforeAll(async () => {
    aw = await buildAuthorityWorld(authority, 'rankings');
    // A real CONTEST version, accepted to PROVISIONAL through the existing ResultLedger.
    const result = await ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: newId() });
    const { draftId } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: aw.official.id,
      disciplineVersionRef: 'running.5k@1',
      content: {
        entries: [{ participantId: P1, outcome: 'RANKED' }],
        performances: [{ participantId: P1, ordinal: 1, mark: mark('900000') }],
      },
    });
    const sub = await ledger.submitDraft({
      draftId,
      actorPrincipalId: aw.official.id,
      scope: aw.contestScope,
      idempotencyKey: `submit-${newId()}`,
    });
    await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: aw.official.id,
      scope: aw.contestScope,
      idempotencyKey: `accept-${newId()}`,
    });
    input = { resultVersionId: sub.resultVersionId, contentHash: sub.contentHash };
    // A published ClassificationPolicy (operator login → br_ranking_rules).
    const spec = hashOf(DomainTag.classificationPolicy, SchemaRef.classificationPolicy, {
      targetEngine: 'classification-engine/1',
      displayName: 'Fictional heats table',
      scopeType: 'ROUND_CLASSIFICATION',
      disciplineVersionId: w.dv,
      minimumInputStatus: 'PROVISIONAL',
      primary: 'METRICS',
      keys: [
        {
          metric: 'elapsedTimeMs',
          markMetricId: 'running.elapsed_time',
          order: 'LOWER_IS_BETTER',
          source: 'PERFORMANCE',
          aggregation: 'MIN',
        },
      ],
    });
    const policyId = newId();
    const policyVersionId = newId();
    await asRole(rop, ModuleRole.rankingRules, async (ctx) => {
      await sql`INSERT INTO ranking.classification_policy (id, code, name, scope_type, created_by_account_id, recorded_at)
        VALUES (${policyId}, ${`cp-${newId().slice(-12)}`}, 'Fictional heats', 'ROUND_CLASSIFICATION', ${w.accountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO ranking.classification_policy_version (id, policy_id, version, spec, spec_schema, spec_hash,
          target_engine, scope_type, discipline_version_id, primary_comparator, minimum_input_status, created_by_account_id, recorded_at)
        VALUES (${policyVersionId}, ${policyId}, 1, ${json(spec.doc)}, 'br:classification-policy@1', ${spec.hash},
          'classification-engine/1', 'ROUND_CLASSIFICATION', ${w.dv}, 'METRICS', 'PROVISIONAL', ${w.accountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO ranking.classification_policy_version_status_change (id, policy_version_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${policyVersionId}, 'PUBLISHED', ${w.accountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
    });
    policy = { policyId, policyVersionId, specHash: spec.hash };
  }, 120_000);

  const content = (status = 'PROVISIONAL', inputsDigest = h('5')) =>
    hashOf(DomainTag.resultVersionContent, SchemaRef.resultVersionContentV2, {
      entries: [
        {
          participantId: P1,
          outcome: 'RANKED',
          rank: 1,
          tied: false,
          tieBreakKeys: [{ key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', value: '900000' }],
        },
      ],
      derivation: {
        derivedFrom: [
          { resultVersionId: input.resultVersionId, contentHash: input.contentHash, status },
        ],
        policy,
        disciplineVersionId: w.dv,
        engineVersion: 'classification-engine/1',
        inputsDigest,
      },
    });

  /**
   * Writes a `@2` version as the ResultLedger's module role would (Step 6), with optional derivation
   * and input rows. Direct SQL stands in for the not-yet-implemented validated ledger submission.
   */
  async function classify(
    opts: {
      scopeType?: string;
      derivation?: boolean;
      inputs?: { id: string; hash: string; status: string }[];
      header?: Partial<{ inputs_digest: string; input_count: number }>;
      contentStatus?: string;
    } = {},
  ) {
    const result = await ledger.createResult({
      scopeType: (opts.scopeType ?? 'ROUND_CLASSIFICATION') as 'ROUND_CLASSIFICATION',
      scopeTargetId: newId(),
    });
    const c = content(opts.contentStatus);
    const versionId = newId();
    await asRole(api, ModuleRole.results, async (ctx) => {
      await sql`INSERT INTO results.result_version (id, result_id, version_number, discipline_version_ref, content_schema,
          content, content_hash, submitted_by_principal_id, fact_hash, recorded_at)
        VALUES (${versionId}, ${result.id}, 1, 'running.5k@1', 'br:result-version-content@2', ${json(c.doc)}, ${c.hash},
          ${aw.official.id}, ${h('6')}, ${ctx.txTime})`.execute(ctx.trx);
      if (opts.derivation === false) return;
      await sql`INSERT INTO results.classification_derivation (result_version_id, policy_id, policy_version_id,
          policy_spec_hash, discipline_version_id, engine_version, inputs_digest, input_count, recorded_at)
        VALUES (${versionId}, ${policy.policyId}, ${policy.policyVersionId}, ${policy.specHash}, ${w.dv},
          'classification-engine/1', ${opts.header?.inputs_digest ?? h('5')}, ${opts.header?.input_count ?? 1}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      for (const i of opts.inputs ?? [
        { id: input.resultVersionId, hash: input.contentHash, status: 'PROVISIONAL' },
      ])
        await sql`INSERT INTO results.classification_input (classification_version_id, input_result_version_id,
            input_content_hash, input_status, recorded_at)
          VALUES (${versionId}, ${i.id}, ${i.hash}, ${i.status}, ${ctx.txTime})`.execute(ctx.trx);
    });
    return versionId;
  }

  it('a `@2` classification version commits with its derivation and the exact derivedFrom index', async () => {
    const id = await classify();
    const { rows } = await sql<{ n: string }>`
      SELECT input_result_version_id::text AS n FROM results.classification_input
      WHERE classification_version_id = ${id}`.execute(owner);
    expect(rows.map((r) => r.n)).toEqual([input.resultVersionId]);
    // Correction impact is a lookup: which classifications pin ResultVersion X?
    const { rows: impact } = await sql<{ n: string }>`
      SELECT classification_version_id::text AS n FROM results.classification_input
      WHERE input_result_version_id = ${input.resultVersionId}`.execute(owner);
    expect(impact.map((r) => r.n)).toContain(id);
    await expect(
      sql`UPDATE results.classification_input SET input_status = 'FINAL' WHERE classification_version_id = ${id}`.execute(
        owner,
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
  });

  it('`@2` content cannot exist without provenance, on a CONTEST Result, or disagreeing with its pins', async () => {
    await expect(classify({ derivation: false })).rejects.toMatchObject({ code: 'BR163' });
    await expect(classify({ scopeType: 'CONTEST' })).rejects.toMatchObject({ code: 'BR162' });
    await expect(classify({ header: { inputs_digest: h('4') } })).rejects.toMatchObject({
      code: 'BR164',
    });
    await expect(classify({ inputs: [] })).rejects.toMatchObject({ code: 'BR166' });
    await expect(
      classify({
        inputs: [{ id: input.resultVersionId, hash: input.contentHash, status: 'OFFICIAL' }],
      }),
    ).rejects.toMatchObject({ code: 'BR167' });
    // Pinned as OFFICIAL in content and index, but the input is only PROVISIONAL now.
    await expect(
      classify({
        contentStatus: 'OFFICIAL',
        inputs: [{ id: input.resultVersionId, hash: input.contentHash, status: 'OFFICIAL' }],
      }),
    ).rejects.toMatchObject({ code: 'BR168' });
  });

  it('only the ResultLedger role writes the derivation index; the ranking roles cannot', async () => {
    for (const [db, role] of [
      [rw, ModuleRole.rankings],
      [rop, ModuleRole.rankingRules],
    ] as const)
      await expect(
        asRole(db, role, (ctx) =>
          sql`INSERT INTO results.classification_derivation (result_version_id, policy_id, policy_version_id,
              policy_spec_hash, discipline_version_id, engine_version, inputs_digest, input_count, recorded_at)
            VALUES (${newId()}, ${newId()}, ${newId()}, ${h('1')}, ${newId()}, 'classification-engine/1', ${h('2')}, 1, ${ctx.txTime})`.execute(
            ctx.trx,
          ),
        ),
      ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(rw, ModuleRole.rankings, (ctx) =>
        sql`INSERT INTO results.result (id, scope_type, scope_target_id, fact_hash, recorded_at)
          VALUES (${newId()}, 'ROUND_CLASSIFICATION', ${newId()}, ${h('3')}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('policies store neither AVERAGE nor ORDINAL keys, and are immutable', async () => {
    const bad = (key: Record<string, unknown>) =>
      asRole(rop, ModuleRole.rankingRules, async (ctx) => {
        const pid = newId();
        await sql`INSERT INTO ranking.classification_policy (id, code, name, scope_type, created_by_account_id, recorded_at)
          VALUES (${pid}, ${`cp-${newId().slice(-12)}`}, 'bad', 'ROUND_CLASSIFICATION', ${w.accountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        const spec = {
          targetEngine: 'classification-engine/1',
          displayName: 'bad',
          scopeType: 'ROUND_CLASSIFICATION',
          disciplineVersionId: w.dv,
          minimumInputStatus: 'PROVISIONAL',
          primary: 'METRICS',
          keys: [
            {
              metric: 'elapsedTimeMs',
              markMetricId: 'running.elapsed_time',
              order: 'LOWER_IS_BETTER',
              source: 'PERFORMANCE',
              aggregation: 'MIN',
              ...key,
            },
          ],
        };
        await sql`INSERT INTO ranking.classification_policy_version (id, policy_id, version, spec, spec_schema, spec_hash,
            target_engine, scope_type, discipline_version_id, primary_comparator, minimum_input_status, created_by_account_id, recorded_at)
          VALUES (${newId()}, ${pid}, 1, ${json(spec)}, 'br:classification-policy@1', ${h('8')},
            'classification-engine/1', 'ROUND_CLASSIFICATION', ${w.dv}, 'METRICS', 'PROVISIONAL', ${w.accountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      });
    await expect(bad({ aggregation: 'AVERAGE' })).rejects.toMatchObject(CHECK);
    await expect(bad({ order: 'ORDINAL' })).rejects.toMatchObject(CHECK);
    await expect(
      sql`UPDATE ranking.classification_policy_version SET spec = '{}'::jsonb WHERE id = ${policy.policyVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
  });
});

// ═════════════════════════════ least privilege ═════════════════════════════

describe('BRT-10 role graph and grants (least privilege)', () => {
  it('11–12. logins reach exactly their module roles; nothing else', async () => {
    await expect(setRole(rop, 'br_ranking_rules')).resolves.toBeDefined();
    await expect(setRole(rw, 'br_rankings')).resolves.toBeDefined();
    await expect(setRole(rw, 'br_verification_reader')).resolves.toBeDefined();
    for (const role of [
      'br_rankings',
      'br_results',
      'br_records',
      'br_achievements',
      'br_verification',
      'br_rebuild',
      'br_owner',
    ])
      await expect(setRole(rop, role), `operator→${role}`).rejects.toMatchObject(DENIED);
    for (const role of [
      'br_ranking_rules',
      'br_results',
      'br_verification',
      'br_records',
      'br_achievements',
      'br_rebuild',
      'br_owner',
    ])
      await expect(setRole(rw, role), `worker→${role}`).rejects.toMatchObject(DENIED);
    for (const role of ['br_rankings', 'br_ranking_rules'])
      await expect(setRole(api, role), `api→${role}`).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{
      inh: boolean;
      su: boolean;
      cr: boolean;
      db: boolean;
      rls: boolean;
    }>`
      SELECT rolinherit AS inh, rolsuper AS su, rolcreaterole AS cr, rolcreatedb AS db, rolbypassrls AS rls
      FROM pg_roles WHERE rolname IN ('br_ranking_operator_app', 'br_ranking_worker_app')`.execute(
      owner,
    );
    expect(rows).toEqual([
      { inh: false, su: false, cr: false, db: false, rls: false },
      { inh: false, su: false, cr: false, db: false, rls: false },
    ]);
  });

  it('12. definitions are written only by br_ranking_rules; runs / snapshots only by br_rankings', async () => {
    const s = await publishedSystem(w);
    await expect(
      asRole(rw, ModuleRole.rankings, (ctx) =>
        sql`INSERT INTO ranking.system (id, code, name, kind, created_by_account_id, recorded_at)
          VALUES (${newId()}, ${`rk-${newId().slice(-12)}`}, 'x', 'PLATFORM', ${w.accountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(rw, ModuleRole.rankings, (ctx) =>
        sql`INSERT INTO ranking.system_version_status_change (id, system_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${s.id}, 'RETIRED', ${w.accountId}, ${ctx.txTime})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      asRole(rop, ModuleRole.rankingRules, (ctx) =>
        sql`INSERT INTO ranking.run (id) VALUES (${newId()})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
    for (const t of [
      'run',
      'run_dependency',
      'snapshot',
      'snapshot_entry',
      'system',
      'system_version',
    ])
      await expect(
        asRole(api, ModuleRole.results, (ctx) =>
          sql`SELECT 1 FROM ${sql.raw(`ranking.${t}`)} LIMIT 1`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(DENIED);
    // The ranking runtime reads canonical facts but can never write them.
    for (const stmt of [
      `INSERT INTO results.result_version (id) VALUES ('${newId()}')`,
      `INSERT INTO verification.run (id) VALUES ('${newId()}')`,
      `INSERT INTO record.record_mark (id) VALUES ('${newId()}')`,
      `INSERT INTO achievement.achievement (id) VALUES ('${newId()}')`,
    ])
      await expect(
        asRole(rw, ModuleRole.rankings, (ctx) => sql.raw(stmt).execute(ctx.trx)),
      ).rejects.toMatchObject(DENIED);
    // The definition operator reads no results, verification, evidence or PII.
    for (const t of [
      'results.result_version',
      'verification.run',
      'identity_private.person_profile',
      'evidence.evidence_item',
    ])
      await expect(
        asRole(rop, ModuleRole.rankingRules, (ctx) =>
          sql`SELECT 1 FROM ${sql.raw(t)} LIMIT 1`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(DENIED);
    // Rebuild reads every ranking table, writes none.
    await expect(
      asRole(maintenance, ModuleRole.rebuild, (ctx) =>
        sql`SELECT count(*) FROM ranking.snapshot`.execute(ctx.trx),
      ),
    ).resolves.toBeDefined();
    await expect(
      asRole(maintenance, ModuleRole.rebuild, (ctx) =>
        sql`INSERT INTO ranking.system (id) VALUES (${newId()})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('13. PUBLIC holds no privilege on any BRT-10 object; the unprivileged probe cannot read or write', async () => {
    const { rows } = await sql<{ t: string }>`
      SELECT table_schema || '.' || table_name || ':' || privilege_type AS t FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND (table_schema = 'ranking' OR table_name LIKE 'classification\\_%')`.execute(
      owner,
    );
    expect(rows).toEqual([]);
    const { rows: schema } = await sql<{ ok: boolean }>`
      SELECT has_schema_privilege('public', 'ranking', 'USAGE') AS ok`.execute(owner);
    expect(schema[0]?.ok).toBe(false);
    const { rows: fns } = await sql<{ f: string }>`
      SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE (n.nspname = 'ranking' OR p.proname LIKE '%classification%')
        AND (p.prosecdef OR has_function_privilege('public', p.oid, 'EXECUTE'))`.execute(owner);
    expect(fns).toEqual([]); // no SECURITY DEFINER, no PUBLIC EXECUTE
    for (const stmt of [
      'SELECT 1 FROM ranking.snapshot',
      `INSERT INTO ranking.snapshot (id) VALUES ('${newId()}')`,
      `INSERT INTO results.classification_input (classification_version_id) VALUES ('${newId()}')`,
    ])
      await expect(sql.raw(stmt).execute(probe)).rejects.toMatchObject(DENIED);
  });

  it('Step 15: the COMPLETE write authority of every BRT-10 role, in every schema, is exactly what the migrations grant', async () => {
    // Effective privileges (has_*_privilege), so a grant reached through any membership would show too.
    const ROLES = [
      'br_rankings',
      'br_ranking_rules',
      'br_ranking_staff_reader',
      'br_ranking_worker_app',
      'br_ranking_operator_app',
    ];
    const { rows: tables } = await sql<{ g: string }>`
      SELECT r.role || ' ' || n.nspname || '.' || c.relname || ':' || p.p AS g
      FROM unnest(${ROLES}::text[]) r(role)
      CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(p)
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
        AND has_table_privilege(r.role, c.oid, p.p)
      ORDER BY 1`.execute(owner);
    expect(tables.map((r) => r.g)).toEqual([
      // 0023 + 0024: the six definition tables, INSERT only (append-only facts).
      'br_ranking_rules platform.audit_event:INSERT', // 0026
      'br_ranking_rules platform.command_idempotency:INSERT', // 0026
      'br_ranking_rules platform.outbox_event:INSERT', // 0026
      'br_ranking_rules ranking.classification_policy:INSERT',
      'br_ranking_rules ranking.classification_policy_version:INSERT',
      'br_ranking_rules ranking.classification_policy_version_status_change:INSERT',
      'br_ranking_rules ranking.system:INSERT',
      'br_ranking_rules ranking.system_version:INSERT',
      'br_ranking_rules ranking.system_version_status_change:INSERT',
      // 0028: the one class-B projection it refreshes (never TRUNCATE: that is br_rebuild's).
      'br_ranking_rules ranking_read.system_card:DELETE',
      'br_ranking_rules ranking_read.system_card:INSERT',
      'br_ranking_rules ranking_read.system_card:UPDATE',
      'br_rankings platform.audit_event:INSERT', // 0026
      'br_rankings platform.outbox_event:INSERT', // 0026
      // 0025: runs, dependencies, snapshots, entries — INSERT only.
      'br_rankings ranking.run:INSERT',
      'br_rankings ranking.run_dependency:INSERT',
      'br_rankings ranking.snapshot:INSERT',
      'br_rankings ranking.snapshot_entry:INSERT',
      // 0028: the projections of the facts it writes.
      'br_rankings ranking_read.leaderboard_entry:DELETE',
      'br_rankings ranking_read.leaderboard_entry:INSERT',
      'br_rankings ranking_read.leaderboard_entry:UPDATE',
      'br_rankings ranking_read.run_candidate:DELETE',
      'br_rankings ranking_read.run_candidate:INSERT',
      'br_rankings ranking_read.run_candidate:UPDATE',
      'br_rankings ranking_read.run_card:DELETE',
      'br_rankings ranking_read.run_card:INSERT',
      'br_rankings ranking_read.run_card:UPDATE',
      'br_rankings ranking_read.snapshot_card:DELETE',
      'br_rankings ranking_read.snapshot_card:INSERT',
      'br_rankings ranking_read.snapshot_card:UPDATE',
      // 0029 (round read) and 0030 (staff reader) grant no write at all; the NOINHERIT logins hold
      // nothing until they SET ROLE.
    ]);
    // No column-level write grant exists beside the table grants (a narrower INSERT / UPDATE would
    // otherwise escape the table inventory above).
    const { rows: columns } = await sql<{ g: string }>`
      SELECT r.role || ' ' || n.nspname || '.' || c.relname || '.' || a.attname || ':' || p.p AS g
      FROM unnest(${ROLES}::text[]) r(role)
      CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(p)
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND has_column_privilege(r.role, c.oid, a.attnum, p.p)
        AND NOT has_table_privilege(r.role, c.oid, p.p)`.execute(owner);
    expect(columns).toEqual([]);
    // The module roles are members of nothing (the inventory above is their whole authority).
    const { rows: member } = await sql<{ m: string }>`
      SELECT r.rolname AS m FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.member
      WHERE r.rolname IN ('br_rankings', 'br_ranking_rules', 'br_ranking_staff_reader')`.execute(
      owner,
    );
    expect(member).toEqual([]);
  });

  it('application roles cannot bypass immutability (no UPDATE / DELETE / TRUNCATE grant anywhere)', async () => {
    const { rows } = await sql<{ t: string }>`
      SELECT grantee || ' ' || table_schema || '.' || table_name || ':' || privilege_type AS t
      FROM information_schema.role_table_grants
      -- Class-A facts only: schema ranking + results.classification_* (the class-B ranking_read.*
      -- projections are writable by their writer and br_rebuild by design, ADR-0048 §9).
      WHERE (table_schema = 'ranking' OR (table_schema = 'results' AND table_name LIKE 'classification\\_%'))
        AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND grantee <> 'br_owner'`.execute(
      owner,
    );
    expect(rows).toEqual([]);
    const { rows: own } = await sql<{ o: string }>`
      SELECT DISTINCT tableowner AS o FROM pg_tables WHERE schemaname = 'ranking' OR tablename LIKE 'classification\\_%'`.execute(
      owner,
    );
    expect(own).toEqual([{ o: 'br_owner' }]);
  });
});

// ═════════════════════════════ throwaway fixture database (positive snapshot paths) ═════════════════════════════

describe('REFERENCE FIXTURE overlay database (br_rkfx_*): snapshots, uniqueness and lineage', () => {
  let fx: RankingFixtureDatabase;
  let fw: World;
  const fdbs: Db[] = [];

  beforeAll(async () => {
    fx = await createRankingFixtureDatabase();
    const urls = databaseUrls(fx.database);
    const mk = (u: string | undefined) => {
      const d = createDb(u as string, { max: 2 });
      fdbs.push(d);
      return d;
    };
    fw = await makeWorld(
      mk(urls.api),
      mk(urls.owner),
      mk(rankingOperatorDatabaseUrl(fx.database)),
      mk(rankingWorkerDatabaseUrl(fx.database)),
      mk(operatorDatabaseUrl(fx.database)),
    );
  }, 180_000);
  afterAll(async () => {
    await Promise.all(fdbs.map((d) => d.destroy()));
    await fx.destroy();
  }, 60_000);

  it('a fixture snapshot publishes with all its entries and is then immutable', async () => {
    const s = await publishedSystem(fw);
    const run = await insertRun(fw, s);
    const snap = await insertSnapshot(fw, s, run);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ranking.snapshot_entry WHERE snapshot_id = ${snap.id}`.execute(
      fw.owner,
    );
    expect(rows[0]?.n).toBe(2);
    for (const stmt of [
      sql`UPDATE ranking.snapshot SET entry_count = 3 WHERE id = ${snap.id}`,
      sql`DELETE FROM ranking.snapshot_entry WHERE snapshot_id = ${snap.id}`,
      sql`UPDATE ranking.run SET publication_state = 'BLOCKED' WHERE id = ${run.id}`,
      sql`TRUNCATE ranking.snapshot CASCADE`,
    ])
      await expect(stmt.execute(fw.owner)).rejects.toMatchObject(APPEND_ONLY);
  });

  it('8 & 10. snapshot identity: one snapshot per run, unique snapshot hash', async () => {
    const s = await publishedSystem(fw);
    const run = await insertRun(fw, s);
    const first = await insertSnapshot(fw, s, run);
    await expect(
      insertSnapshot(fw, s, run, { kind: 'FOLLOWS', prior: first }),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'snapshot_run_key',
    });
    const run2 = await insertRun(fw, s);
    await expect(
      insertSnapshot(fw, s, run2, { kind: 'FOLLOWS', prior: first }, { snapshotHash: first.hash }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'snapshot_hash_key' });
  });

  it('9. correction lineage: FOLLOWS / CORRECTS pin the prior by id + hash; corrected at most once', async () => {
    const s = await publishedSystem(fw);
    const a = await insertSnapshot(fw, s, await insertRun(fw, s));
    const b = await insertSnapshot(fw, s, await insertRun(fw, s), { kind: 'FOLLOWS', prior: a });
    const c = await insertSnapshot(fw, s, await insertRun(fw, s), {
      kind: 'CORRECTS',
      prior: b,
      reasons: ['RESULT_SUPERSEDED'],
    });
    const { rows } = await sql<{ id: string; prev: string | null; corr: string | null }>`
      SELECT id::text, previous_snapshot_id::text AS prev, corrects_snapshot_id::text AS corr
      FROM ranking.snapshot WHERE system_id = ${s.systemId} ORDER BY recorded_at, id`.execute(
      fw.owner,
    );
    expect(rows).toEqual([
      { id: a.id, prev: null, corr: null },
      { id: b.id, prev: a.id, corr: null },
      { id: c.id, prev: null, corr: b.id },
    ]);
    // As-corrected is a query: b is corrected by c; nothing was rewritten.
    const { rows: asCorrected } = await sql<{ id: string }>`
      SELECT s.id::text FROM ranking.snapshot s WHERE s.system_id = ${s.systemId}
        AND NOT EXISTS (SELECT 1 FROM ranking.snapshot x WHERE x.corrects_snapshot_id = s.id)
      ORDER BY s.recorded_at, s.id`.execute(fw.owner);
    expect(asCorrected.map((r) => r.id)).toEqual([a.id, c.id]);
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), {
        kind: 'CORRECTS',
        prior: b,
        reasons: ['RESULT_REVOKED'],
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'snapshot_corrected_once' });
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), { kind: 'FOLLOWS', prior: a }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'snapshot_followed_once' });
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), { kind: 'CORRECTS', prior: c }),
    ).rejects.toMatchObject(CHECK); // a correction needs reasons
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), {
        kind: 'FOLLOWS',
        prior: { id: c.id, hash: h('0') },
      }),
    ).rejects.toMatchObject({ code: 'BR179' }); // prior hash must match
    await expect(insertSnapshot(fw, s, await insertRun(fw, s))).rejects.toMatchObject({
      code: 'BR179',
    }); // second INITIAL
  });

  it('a snapshot needs a PUBLISHABLE run, a PUBLISHED version, every entry, and exact entries', async () => {
    const s = await publishedSystem(fw);
    const blocked = await insertRun(fw, s, { blocked: true });
    await expect(insertSnapshot(fw, s, blocked)).rejects.toMatchObject({ code: 'BR178' });
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), undefined, { skipEntries: true }),
    ).rejects.toMatchObject({
      code: 'BR182',
    });
    await expect(
      insertSnapshot(fw, s, await insertRun(fw, s), undefined, { tamperEntry: true }),
    ).rejects.toMatchObject({
      code: 'BR180',
    });
    const draft = await createSystem(fw);
    const dv = await createVersion(fw, draft, 1, systemSpec(fw.dv));
    const draftSys = { systemId: draft, ...dv };
    // A run of a DRAFT version is recordable (it reports its blockers) but never publishable.
    await expect(insertSnapshot(fw, draftSys, await insertRun(fw, draftSys))).rejects.toMatchObject(
      { code: 'BR178' },
    );
  });
});
