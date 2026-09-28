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
  bootstrapDatabase,
  createDb,
  databaseUrls,
  devRolePasswords,
  migrate,
  resetDatabase,
  type Db,
} from '@br/persistence';

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

/** Login br_api: may assume br_authority and br_results. */
export function apiDb(): Db {
  return createDb(testUrls().api);
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
