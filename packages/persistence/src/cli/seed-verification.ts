import { REFERENCE_POLICY_CODE, REFERENCE_POLICY_SPEC } from '@br/verification';
import { sql } from 'kysely';
import { databaseUrls, verificationOperatorDatabaseUrl } from '../config';
import { createDb } from '../db';
import { IdentityStore } from '../identity-store';
import { inTransaction, ModuleRole } from '../tx';
import { VerificationPolicyStore, VerificationService } from '../verification-store';

/**
 * BRT-07 development seed. ALL DATA IS FICTIONAL. Builds on `pnpm db:seed:evidence` (the Fictional
 * Padel Open's first submitted ResultVersion): publishes the fictional development REFERENCE policy
 * (`br-dev-reference`, NOT a universal truth standard) through the dedicated operator login, binds
 * it to the event's exact DisciplineVersion and requests one real evaluation.
 *
 * Only real, producible canonical facts are used: no RESULT_OFFICIAL, T5, sanction, identity,
 * ratification, registered-official or any synthetic engine fixture, and NO AuthorityGrant is
 * created to reach a level (an ATTEST_RESULT grant is not a registered official — BRT-07R). The
 * honest real-data result is printed: V0 (the seeded submitter is a referee principal without a
 * Person mapping, so independence cannot be proven; the organizer's AFFIRM has no V1 standing).
 *
 * Idempotent: fixed idempotency keys; re-running finds the existing policy/binding and the
 * unchanged snapshot maps to the same run, so the output is identical.
 * Run: pnpm db:seed:competition && pnpm db:seed:evidence && pnpm db:seed:verification
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');
const db = createDb(databaseUrls().api, { max: 4 });
const operatorUrl = verificationOperatorDatabaseUrl();
if (operatorUrl === undefined) throw new Error('no verification operator database URL');
const vop = createDb(operatorUrl, { max: 2 });
const identity = new IdentityStore(db);
const policies = new VerificationPolicyStore(vop);
const verification = new VerificationService(db);

try {
  const contest = await inTransaction(db, ModuleRole.competition, async (ctx) => {
    const { rows } = await sql<{
      competition_id: string;
      discipline_version_id: string;
      contest_id: string;
    }>`
      SELECT c.id AS competition_id, e.discipline_version_id, ct.id AS contest_id
      FROM competition.competition_slug s
      JOIN competition.competition c ON c.id = s.competition_id
      JOIN competition.event e ON e.competition_id = c.id
      JOIN competition.contest ct ON ct.event_id = e.id
      WHERE s.slug = 'fictional-padel-open' ORDER BY ct.sequence LIMIT 1`.execute(ctx.trx);
    return rows[0];
  });
  const found =
    contest === undefined
      ? undefined
      : await inTransaction(db, ModuleRole.results, async (ctx) => {
          const { rows } = await sql<{ id: string }>`
            SELECT v.id FROM results.result r JOIN results.result_version v ON v.result_id = r.id
            WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ${contest.contest_id}
            ORDER BY v.version_number LIMIT 1`.execute(ctx.trx);
          return rows[0] === undefined ? undefined : { ...contest, result_version_id: rows[0].id };
        });
  if (found === undefined)
    throw new Error('run `pnpm db:seed:evidence` first (no seeded ResultVersion found)');

  // 1–2 · Fictional development reference policy (operator login only), bound to the exact DisciplineVersion.
  const { accountId: operator } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:verification-operator',
    method: 'TEST',
  });
  const { policyId } = await policies.createPolicy({
    operatorAccountId: operator,
    code: REFERENCE_POLICY_CODE,
    name: 'Fictional development reference policy',
    idempotencyKey: 'seed:verification:policy',
  });
  const version = await policies.createPolicyVersion({
    operatorAccountId: operator,
    policyId,
    spec: REFERENCE_POLICY_SPEC,
    idempotencyKey: 'seed:verification:policy:v1',
  });
  await policies.changeVersionStatus({
    operatorAccountId: operator,
    policyVersionId: version.policyVersionId,
    status: 'PUBLISHED',
  });
  await policies.bindPolicy({
    operatorAccountId: operator,
    disciplineVersionId: found.discipline_version_id,
    policyVersionId: version.policyVersionId,
    idempotencyKey: 'seed:verification:binding',
  });

  // 3 · One real evaluation (idempotent: unchanged facts ⇒ the same run).
  const r = await verification.evaluate({
    actor: { internal: true },
    resultVersionId: found.result_version_id,
  });
  if (r.kind !== 'RUN') throw new Error(`no applicable policy: ${r.reason}`);
  const blockers = (lvl: string) =>
    (r.run.outcome.levels.find((l) => l.level === lvl)?.criteria ?? [])
      .filter((c) => c.status !== 'PASS')
      .map((c) => ({ kind: c.kind, status: c.status, reasons: c.reasons }));
  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        policy: {
          code: REFERENCE_POLICY_CODE,
          version: version.version,
          note: 'fictional development reference policy — not a universal truth standard',
        },
        resultVersionId: found.result_version_id,
        run: {
          runId: r.run.runId,
          snapshotHash: r.run.snapshotHash,
          outcomeHash: r.run.outcomeHash,
          highestSatisfiedLevel: r.run.highestSatisfiedLevel,
          label: r.run.label,
        },
        realProductionCeiling: {
          reached: r.run.highestSatisfiedLevel,
          note: 'the seeded version is submitted by a referee principal with no Person mapping (its side is unknowable), and no REGISTERED_OFFICIAL producer exists — V1 is honestly not reachable here; see `pnpm demo:verification` for real counterparty V1',
          v1Blocked: blockers('V1'),
          v2Blocked: blockers('V2'),
        },
        pages: [`/verifications/${r.run.runId}`],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([db.destroy(), vop.destroy()]);
}
