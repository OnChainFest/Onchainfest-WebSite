import type { DisciplineVersionSpec } from '@br/competition';
import { staticParticipationChecker, type AuthorityFacts, type AnchorFact } from '@br/authority';
import {
  newId,
  type AuthorityGrant,
  type AuthorityScope,
  type Capability,
  type Principal,
  type PrincipalType,
  type RecognitionScope,
  type Uuid,
} from '@br/domain';
import {
  type AuthorityStore,
  type IdentityStore,
  type CatalogStore,
  type CompetitionHierarchyResolver,
  type CompetitionStore,
  type OrganizationStore,
  type PrincipalKeyCeremony,
  type ResultLedger,
  type StructureStore,
  inTransaction,
  ModuleRole,
  bootstrapDatabase,
  createDb,
  databaseUrls,
  operatorDatabaseUrl,
  devRolePasswords,
  migrate,
  resetDatabase,
  type Db,
} from '@br/persistence';
import type { EphemeralSigner } from '@br/evidence';
import { sql } from 'kysely';

export const TEST_DATABASE = process.env.BR_TEST_DATABASE_NAME ?? 'bragging_rights_test';

export function testUrls() {
  return databaseUrls(TEST_DATABASE);
}

/** Recreates the integration database from scratch: roles, hardening, schemas, migrations. */
export async function prepareIntegrationDatabase(): Promise<void> {
  await bootstrapDatabase(databaseUrls().admin, [TEST_DATABASE], devRolePasswords());
  await resetDatabase(databaseUrls().admin, TEST_DATABASE);
  await migrate(testUrls().owner);
}

/** Login br_api: may assume br_authority, br_results, br_identity, br_organizations, br_public_read. */
export function apiDb(): Db {
  return createDb(testUrls().api);
}

/** Login br_api_vault: may assume br_identity_private only (PII vault). */
export function vaultDb(): Db {
  return createDb(testUrls().vault, { max: 4 });
}

/** BRT-05R: login br_operator_app — may assume br_catalog only (INTERNAL catalog mutation). */
export function operatorDb(): Db {
  const url = operatorDatabaseUrl(TEST_DATABASE);
  if (url === undefined) throw new Error('no operator database URL');
  return createDb(url, { max: 2 });
}

/** Login br_worker_app: may assume br_worker only. */
export function workerDb(): Db {
  return createDb(testUrls().worker, { max: 4 });
}

/** Login br_maintenance: may assume br_rebuild only. */
export function maintenanceDb(): Db {
  return createDb(testUrls().maintenance, { max: 2 });
}

export function ownerDb(): Db {
  return createDb(testUrls().owner, { max: 2 });
}

export function probeDb(): Db {
  return createDb(testUrls().probe, { max: 1 });
}

/**
 * Explicit test data source for conflict-of-interest checks: "no principal participates".
 * Production has no such default — without participation data, conflict-sensitive actions fail
 * closed (BRT-03R). Tests that exercise conflicts declare participations explicitly.
 */
export const declaredNoParticipation = staticParticipationChecker(
  [],
  'test-declared-no-participation',
);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A platform principal + PLATFORM-level anchor, plus an organizer and an official. */
export interface AuthorityWorld {
  readonly platform: Principal;
  readonly platformAnchorId: Uuid;
  readonly organizer: Principal;
  readonly official: Principal;
  readonly outsider: Principal;
  readonly competitionId: Uuid;
  readonly contestId: Uuid;
  /** Platform → organizer grant (may delegate). */
  readonly organizerGrant: AuthorityGrant;
  /** Organizer → official grant scoped to one contest. */
  readonly officialGrant: AuthorityGrant;
  readonly contestScope: AuthorityScope;
}

export async function buildAuthorityWorld(
  store: AuthorityStore,
  label = 'test',
): Promise<AuthorityWorld> {
  const register = (principalType: PrincipalType, name: string) =>
    store.registerPrincipal({ principalType, label: `${name} (${label})` });
  const platform = await register('PLATFORM', 'platform');
  const organizer = await register('ORGANIZATION', 'club organizer');
  const official = await register('PERSON', 'referee');
  const outsider = await register('PERSON', 'outsider');
  const { anchorId } = await store.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'test bootstrap',
    governanceDecisionRef: `test-${label}`,
  });
  const competitionId = newId();
  const contestId = newId();
  const competitionScope: AuthorityScope = {
    sport: ['padel'],
    recognitionLevel: ['PLATFORM'],
    competition: [competitionId],
  };
  const contestScope: AuthorityScope = { ...competitionScope, contest: [contestId] };
  const { grant: organizerGrant } = await store.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: organizer.id,
    capabilities: ['GRANT_AUTHORITY', 'SUBMIT_RESULT', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL'],
    scope: competitionScope,
    delegation: {
      allowed: true,
      maxDepth: 1,
      capabilitiesDelegable: ['SUBMIT_RESULT', 'ACCEPT_RESULT'],
    },
  });
  const { grant: officialGrant } = await store.issueGrant({
    actorPrincipalId: organizer.id,
    grantorPrincipalId: organizer.id,
    granteePrincipalId: official.id,
    parentGrantId: organizerGrant.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT'],
    scope: contestScope,
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  return {
    platform,
    platformAnchorId: anchorId,
    organizer,
    official,
    outsider,
    competitionId,
    contestId,
    organizerGrant,
    officialGrant,
    contestScope,
  };
}

// ───────────── in-memory fact builders for pure engine tests ─────────────

export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

export function principal(principalType: PrincipalType, recordedAt = T0): Principal {
  return { id: newId(), principalType, label: principalType.toLowerCase(), recordedAt };
}

export function anchor(
  principalId: Uuid,
  recognitionScope: RecognitionScope,
  recordedAt = T0,
  window: { from?: Date; to?: Date } = {},
): AnchorFact {
  return {
    id: newId(),
    principalId,
    recognitionScope,
    basisRef: 'test',
    governanceDecisionRef: 'test',
    effectiveFrom: window.from ?? recordedAt,
    ...(window.to === undefined ? {} : { effectiveTo: window.to }),
    recordedAt,
    factHash: `sha256:${'a'.repeat(64)}`,
  };
}

export function grant(input: {
  grantor: Uuid;
  grantee: Uuid;
  parent?: Uuid;
  capabilities: readonly Capability[];
  scope: AuthorityScope;
  delegable?: readonly Capability[];
  maxDepth?: number;
  from?: Date;
  to?: Date;
  recordedAt?: Date;
}): AuthorityGrant {
  const delegable = input.delegable ?? [];
  const recordedAt = input.recordedAt ?? input.from ?? T0;
  return {
    id: newId(),
    grantorPrincipalId: input.grantor,
    granteePrincipalId: input.grantee,
    ...(input.parent === undefined ? {} : { parentGrantId: input.parent }),
    capabilities: input.capabilities,
    scope: input.scope,
    delegation: {
      allowed: delegable.length > 0,
      maxDepth: input.maxDepth ?? (delegable.length > 0 ? 1 : 0),
      capabilitiesDelegable: delegable,
    },
    constraints: { mustNotBeParticipant: true },
    effectiveFrom: input.from ?? recordedAt,
    ...(input.to === undefined ? {} : { effectiveTo: input.to }),
    grantHash: `sha256:${newId().replaceAll('-', '').padEnd(64, '0')}`,
    recordedAt,
  };
}

export function facts(partial: Partial<AuthorityFacts>): AuthorityFacts {
  return {
    principals: [],
    keys: [],
    keyStatusChanges: [],
    anchors: [],
    anchorStatusChanges: [],
    grants: [],
    grantStatusChanges: [],
    ...partial,
  };
}

// ───────────── BRT-04 identity fixtures (fictional data only) ─────────────

let subjectCounter = 0;

/** Signs in a fresh test-provider subject; optionally creates its SELF person. */
export async function newTestAccount(
  identity: IdentityStore,
  options: { withPerson?: boolean; label?: string } = {},
): Promise<{ accountId: string; personId: string | null }> {
  subjectCounter += 1;
  const { accountId } = await identity.signIn({
    provider: 'test',
    providerSubject: `${options.label ?? 'user'}-${subjectCounter}-${newId()}`,
    method: 'TEST',
  });
  if (options.withPerson === false) return { accountId, personId: null };
  const { personId } = await identity.createPerson({
    actorAccountId: accountId,
    relation: 'SELF',
    idempotencyKey: `self-${accountId}`,
  });
  return { accountId, personId };
}

export function uniqueSlug(prefix = 'athlete'): string {
  return `${prefix}-${newId().replace(/-/g, '').slice(-12)}`;
}

// ───────────── BRT-05 competition fixtures (fictional data only) ─────────────

export const PADEL_DOUBLES_SPEC: DisciplineVersionSpec = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['setsWon', 'gamesWon'],
    properties: {
      setsWon: { type: 'integer', minimum: 0, maximum: 5 },
      gamesWon: { type: 'integer', minimum: 0, maximum: 99 },
    },
  },
  metrics: [
    { key: 'setsWon', valueType: 'INTEGER', unit: 'sets' },
    { key: 'gamesWon', valueType: 'INTEGER', unit: 'games' },
  ],
  comparator: {
    outcomeModel: 'WIN_LOSS_DRAW',
    primary: 'HEAD_TO_HEAD_WINNER',
    keys: [
      { metric: 'setsWon', order: 'HIGHER_IS_BETTER' },
      { metric: 'gamesWon', order: 'HIGHER_IS_BETTER' },
    ],
  },
  validation: { bounds: [{ metric: 'setsWon', min: '0', max: '3' }] },
  allowedContestTypes: ['MATCH'],
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
  evidenceExpectations: ['SIGNED_SCORESHEET'],
};

export const TENNIS_SINGLES_SPEC: DisciplineVersionSpec = {
  ...PADEL_DOUBLES_SPEC,
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

export const RUNNING_5K_SPEC: DisciplineVersionSpec = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['elapsedTimeMs'],
    properties: { elapsedTimeMs: { type: 'integer', minimum: 0 } },
  },
  metrics: [{ key: 'elapsedTimeMs', valueType: 'DURATION_MS', unit: 'ms' }],
  comparator: {
    outcomeModel: 'RANKED',
    primary: 'METRICS',
    keys: [{ metric: 'elapsedTimeMs', order: 'LOWER_IS_BETTER' }],
  },
  validation: { bounds: [{ metric: 'elapsedTimeMs', min: '600000' }] },
  allowedContestTypes: ['HEAT'],
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

export interface TestCatalog {
  readonly operatorAccountId: string;
  readonly padelDoubles: string;
  readonly tennisSingles: string;
  readonly running5k: string;
  readonly singleElimination: string;
  readonly roundRobin: string;
}

/** Creates and publishes a small fictional catalog with unique codes (safe to call repeatedly). */
export async function seedTestCatalog(
  identity: IdentityStore,
  catalog: CatalogStore,
): Promise<TestCatalog> {
  const operator = await newTestAccount(identity, { withPerson: false, label: 'operator' });
  const op = operator.accountId;
  const tag = newId().replace(/-/g, '').slice(-8);
  const k = () => `cat-${newId()}`;
  const sport = async (code: string, name: string) =>
    (
      await catalog.createSport({
        operatorAccountId: op,
        code: `${code}${tag}`,
        name,
        idempotencyKey: k(),
      })
    ).sportId;
  const version = async (
    sportId: string,
    sportCode: string,
    code: string,
    name: string,
    spec: DisciplineVersionSpec,
  ) => {
    const { disciplineId } = await catalog.createDiscipline({
      operatorAccountId: op,
      sportId,
      code: `${sportCode}${tag}.${code}`,
      name,
      idempotencyKey: k(),
    });
    const { disciplineVersionId } = await catalog.createDisciplineVersion({
      operatorAccountId: op,
      disciplineId,
      spec,
      idempotencyKey: k(),
    });
    await catalog.publishDisciplineVersion({ operatorAccountId: op, disciplineVersionId });
    return disciplineVersionId;
  };
  const format = async (code: string, engineId: string) => {
    const { formatTemplateId } = await catalog.createFormatTemplate({
      operatorAccountId: op,
      code: `${code}-${tag}`,
      name: code,
      idempotencyKey: k(),
    });
    const { formatVersionId } = await catalog.createFormatVersion({
      operatorAccountId: op,
      formatTemplateId,
      engineId,
      engineVersion: 1,
      idempotencyKey: k(),
    });
    await catalog.publishFormatVersion({ operatorAccountId: op, formatVersionId });
    return formatVersionId;
  };
  const padel = await sport('padel', 'Padel');
  const tennis = await sport('tennis', 'Tennis');
  const running = await sport('running', 'Running');
  return {
    operatorAccountId: op,
    padelDoubles: await version(padel, 'padel', 'doubles', 'Padel doubles', PADEL_DOUBLES_SPEC),
    tennisSingles: await version(
      tennis,
      'tennis',
      'singles',
      'Tennis singles',
      TENNIS_SINGLES_SPEC,
    ),
    running5k: await version(running, 'running', '5k', 'Running 5K', RUNNING_5K_SPEC),
    singleElimination: await format('single-elimination', 'single-elimination'),
    roundRobin: await format('round-robin', 'round-robin'),
  };
}

/** An organization with an OWNER account (SELF person) able to create competitions. */
export async function newOrganizer(identity: IdentityStore, orgs: OrganizationStore) {
  const owner = await newTestAccount(identity, { label: 'organizer' });
  const slug = uniqueSlug('org');
  const { organizationId } = await orgs.createOrganization({
    actorAccountId: owner.accountId,
    orgType: 'CLUB',
    slug,
    profile: { displayName: 'Fictional Organizer Club' },
    idempotencyKey: `org-${slug}`,
  });
  return {
    ownerAccountId: owner.accountId,
    ownerPersonId: owner.personId as string,
    organizationId,
    slug,
  };
}

/** A fresh account with SELF person and athlete; returns ids (fictional). */
export async function newAthlete(
  identity: IdentityStore,
  label = 'athlete',
  displayName = 'Fictional Athlete',
) {
  const acct = await newTestAccount(identity, { label });
  const slug = uniqueSlug(label);
  const { athleteId } = await identity.createAthlete({
    actorAccountId: acct.accountId,
    personId: acct.personId as string,
    slug,
    profile: { displayName },
    idempotencyKey: `ath-${slug}`,
  });
  return { accountId: acct.accountId, personId: acct.personId as string, athleteId, slug };
}

// ───────────── BRT-06 result fixtures (fictional data only) ─────────────

/**
 * Builds Competition → Event (tennis singles, single elimination, 2 entrants) → Contest, then a
 * Result and an exact submitted ResultVersion through the BRT-05 competition-aware ResultLedger
 * (`createCompetitionResultLedger`, never a bare ResultLedger). A fictional platform anchor grants
 * a fictional referee SUBMIT_RESULT on the competition. Returns the ids; nothing is accepted,
 * made official or verified.
 */
export async function newContestResult(deps: {
  db: Db;
  identity: IdentityStore;
  orgs: OrganizationStore;
  comps: CompetitionStore;
  structure: StructureStore;
  authority: AuthorityStore;
  ledger: ResultLedger;
  resolver: CompetitionHierarchyResolver;
  catalog: TestCatalog;
  organizer?: Awaited<ReturnType<typeof newOrganizer>>;
}) {
  const org = deps.organizer ?? (await newOrganizer(deps.identity, deps.orgs));
  const k = () => `fx-${newId()}`;
  const { competitionId } = await deps.comps.createCompetition({
    actorAccountId: org.ownerAccountId,
    organizerOrganizationId: org.organizationId,
    slug: uniqueSlug('evc'),
    profile: { name: 'Fictional Evidence Open', timezone: 'UTC' },
    idempotencyKey: k(),
  });
  await deps.comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
  const { eventId } = await deps.comps.createEvent({
    actorAccountId: org.ownerAccountId,
    competitionId,
    slug: uniqueSlug('eve'),
    disciplineVersionId: deps.catalog.tennisSingles,
    formatVersionId: deps.catalog.singleElimination,
    settings: { name: 'Fictional Singles' },
    idempotencyKey: k(),
  });
  await deps.comps.openRegistration({ actorAccountId: org.ownerAccountId, eventId });
  const athletes = [];
  for (let i = 0; i < 2; i++) {
    const a = await newAthlete(deps.identity, 'evplayer', `Fictional Player ${i + 1}`);
    athletes.push(a);
    await deps.comps.register({
      actorAccountId: a.accountId,
      eventId,
      athleteId: a.athleteId,
      eligibilityDeclared: true,
      idempotencyKey: k(),
    });
  }
  await deps.comps.closeRegistration({ actorAccountId: org.ownerAccountId, eventId });
  await deps.structure.lockField({
    actorAccountId: org.ownerAccountId,
    eventId,
    idempotencyKey: k(),
  });
  await deps.structure.seedField({
    actorAccountId: org.ownerAccountId,
    eventId,
    method: 'DETERMINISTIC_DRAW',
    idempotencyKey: k(),
  });
  await deps.structure.generatePlan({
    actorAccountId: org.ownerAccountId,
    eventId,
    idempotencyKey: k(),
  });
  const contest = await inTransaction(deps.db, ModuleRole.competition, async (ctx) => {
    const { rows } = await sql<{ contest_id: string; participant_id: string }>`
      SELECT c.id AS contest_id, t.participant_id FROM competition.contest c
      JOIN competition.contestant t ON t.contest_id = c.id
      WHERE c.event_id = ${eventId} AND t.participant_id IS NOT NULL ORDER BY c.sequence, t.slot`.execute(
      ctx.trx,
    );
    const first = rows[0];
    if (first === undefined) throw new Error('no contest generated');
    return {
      contestId: first.contest_id,
      participantIds: rows
        .filter((r) => r.contest_id === first.contest_id)
        .map((r) => r.participant_id),
    };
  });

  const platform = await deps.authority.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'platform (evidence fixture)',
  });
  await deps.authority.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'fixture',
    governanceDecisionRef: `fixture-${newId()}`,
  });
  const referee = await deps.authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'fictional referee (fixture)',
  });
  await deps.authority.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: referee.id,
    capabilities: ['SUBMIT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  const result = await deps.ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: contest.contestId as Uuid,
  });
  const content = (winner: string, loser: string) => ({
    entries: [
      {
        participantId: winner,
        outcome: 'WIN',
        primaryMark: { metricId: 'tennis.match.sets', value: '2', unit: 'sets', precision: 0 },
      },
      {
        participantId: loser,
        outcome: 'LOSS',
        primaryMark: { metricId: 'tennis.match.sets', value: '0', unit: 'sets', precision: 0 },
      },
    ],
  });
  const [p1, p2] = contest.participantIds;
  if (p1 === undefined || p2 === undefined) throw new Error('contest has no participants');
  const scope = {
    ...(await deps.resolver.scopeOf('CONTEST', contest.contestId)),
    recognitionLevel: ['PLATFORM'],
  } as AuthorityScope;
  const submit = async (winner: string, loser: string) => {
    const { draftId } = await deps.ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: referee.id,
      disciplineVersionRef: 'tennis.singles@1',
      content: content(winner, loser),
    });
    return deps.ledger.submitDraft({
      draftId,
      actorPrincipalId: referee.id,
      scope,
      idempotencyKey: k(),
    });
  };
  const v1 = await submit(p1, p2);
  return {
    organizer: org,
    competitionId,
    eventId,
    contestId: contest.contestId,
    participantIds: [p1, p2],
    athletes,
    refereePrincipalId: referee.id,
    resultId: result.id,
    resultVersionId: v1.resultVersionId,
    contentHash: v1.contentHash,
    /** Submits another (different) version of the same Result — e.g. a correction. */
    submitNextVersion: () => submit(p2, p1),
  };
}

/** Registers a PUBLIC key through the proof-of-possession ceremony, signing with `signer`. */
export async function registerSigningKey(
  ceremony: PrincipalKeyCeremony,
  actorAccountId: string,
  principalId: string,
  signer: EphemeralSigner,
): Promise<string> {
  const prepared = await ceremony.prepareKeyRegistration({
    actorAccountId,
    idempotencyKey: `kp-${newId()}`,
    principalId,
    algorithm: signer.algorithm,
    publicJwk: signer.publicJwk,
  });
  const { keyId } = await ceremony.submitKeyRegistration({
    actorAccountId,
    idempotencyKey: `ks-${newId()}`,
    principalId,
    challengeId: prepared.challengeId,
    proof: {
      proofType: 'DIRECT_SIGNATURE',
      scheme: 'JWS_DETACHED',
      ...signer.signJws(prepared.signing.kid, prepared.statementHash),
    },
  });
  return keyId;
}

/** Signs a prepared statement exactly as an external signer would (in memory only). */
export function signPrepared(
  signer: EphemeralSigner,
  prepared: { challengeId: string; statementHash: string; signing: { kid: string } },
) {
  return {
    challengeId: prepared.challengeId,
    proof: {
      proofType: 'DIRECT_SIGNATURE',
      scheme: 'JWS_DETACHED',
      ...signer.signJws(prepared.signing.kid, prepared.statementHash),
    },
  };
}
