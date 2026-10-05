import type {
  AuthorityScope,
  Capability,
  PrincipalType,
  RecognitionScope,
  ResultVersionStatus,
} from '@br/domain';
import type { RawParticipation, RawPolicy, RawVerificationFacts } from '@br/verification';
import { sql } from 'kysely';
import { loadBundleFacts } from './evidence-reader';
import { resultVersionPath, type ResolvedResultVersion, type ScopePath } from './evidence-support';
import type { TxContext } from './tx';

/**
 * BRT-07 raw fact loader (br_verification, read-only). Loads a SUPERSET of the canonical facts a
 * VerificationSnapshot needs — every history row, any order — and never filters by time itself:
 * the pure assembler applies the cutoff, re-verifies hashes/signatures and detects clock
 * inconsistencies. Reads ids, hashes, codes and timestamps only: no profile, name, slug, contact,
 * vault or auth-identity table is touched.
 */

export interface ApplicablePolicy extends RawPolicy {
  readonly bindingId: string;
  readonly bindingEffectiveFrom: Date;
}

export type PolicyResolution =
  | { readonly ok: true; readonly policy: ApplicablePolicy }
  | {
      readonly ok: false;
      readonly reason: 'NO_DISCIPLINE_VERSION' | 'NO_BINDING' | 'POLICY_VERSION_NOT_PUBLISHED';
    };

/** The DisciplineVersion an exact ResultVersion is judged under (the event's pinned version). */
export async function disciplineVersionOf(
  ctx: TxContext,
  path: ScopePath | undefined,
): Promise<{ disciplineVersionId?: string; evidenceExpectations?: string[] }> {
  if (path?.eventId === undefined) return {};
  const { rows } = await sql<{ id: string; expectations: string[] | null }>`
    SELECT dv.id, (SELECT array_agg(x) FROM jsonb_array_elements_text(dv.spec->'evidenceExpectations') AS x) AS expectations
    FROM competition.event e JOIN sports.discipline_version dv ON dv.id = e.discipline_version_id
    WHERE e.id = ${path.eventId}`.execute(ctx.trx);
  const r = rows[0];
  return r === undefined
    ? {}
    : {
        disciplineVersionId: r.id,
        ...(r.expectations === null ? {} : { evidenceExpectations: r.expectations }),
      };
}

/**
 * The PUBLISHED policy version bound to the exact DisciplineVersion at time T (as known at T):
 * the latest binding with effective_from ≤ T; its version must be PUBLISHED and not RETIRED at T.
 * No fallback policy exists: anything else fails closed.
 */
export async function resolveApplicablePolicy(
  ctx: TxContext,
  disciplineVersionId: string | undefined,
  at: Date,
): Promise<PolicyResolution> {
  if (disciplineVersionId === undefined) return { ok: false, reason: 'NO_DISCIPLINE_VERSION' };
  const { rows } = await sql<{
    binding_id: string;
    effective_from: Date;
    policy_version_id: string;
    policy_id: string;
    code: string;
    version: number;
    spec: unknown;
    spec_hash: string;
    published: boolean;
    retired: boolean;
  }>`
    SELECT b.id AS binding_id, b.effective_from, v.id AS policy_version_id, v.policy_id, p.code, v.version, v.spec, v.spec_hash,
           EXISTS (SELECT 1 FROM verification.policy_version_status_change s
                   WHERE s.policy_version_id = v.id AND s.status = 'PUBLISHED' AND s.recorded_at <= ${at}) AS published,
           EXISTS (SELECT 1 FROM verification.policy_version_status_change s
                   WHERE s.policy_version_id = v.id AND s.status = 'RETIRED' AND s.recorded_at <= ${at}) AS retired
    FROM verification.policy_binding b
    JOIN verification.policy_version v ON v.id = b.policy_version_id
    JOIN verification.policy p ON p.id = v.policy_id
    WHERE b.discipline_version_id = ${disciplineVersionId} AND b.effective_from <= ${at} AND b.recorded_at <= ${at}
    ORDER BY b.effective_from DESC, b.seq DESC LIMIT 1`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return { ok: false, reason: 'NO_BINDING' };
  if (!r.published || r.retired) return { ok: false, reason: 'POLICY_VERSION_NOT_PUBLISHED' };
  return {
    ok: true,
    policy: {
      bindingId: r.binding_id,
      bindingEffectiveFrom: r.effective_from,
      policyId: r.policy_id,
      policyVersionId: r.policy_version_id,
      code: r.code,
      version: r.version,
      spec: r.spec,
      specHash: r.spec_hash,
    },
  };
}

const ids = (xs: Iterable<string | null | undefined>) =>
  [...new Set([...xs].filter((x): x is string => typeof x === 'string'))].sort();

/** Loads every raw canonical fact for one exact ResultVersion under one policy (no filtering). */
export async function loadRawVerificationFacts(
  ctx: TxContext,
  rv: ResolvedResultVersion,
  policy: RawPolicy,
): Promise<RawVerificationFacts> {
  const path = await resultVersionPath(ctx, rv);
  if (path === undefined) throw new Error('result version hierarchy could not be resolved');
  const { rows: versionRows } = await sql<{
    content: unknown;
    submitted_by_principal_id: string;
    recorded_at: Date;
  }>`SELECT content, submitted_by_principal_id, recorded_at FROM results.result_version WHERE id = ${rv.resultVersionId}`.execute(
    ctx.trx,
  );
  const version = versionRows[0];
  if (version === undefined) throw new Error('result version row missing');
  const { rows: transitions } = await sql<{
    to_status: ResultVersionStatus;
    recorded_at: Date;
    seq: number;
  }>`
    SELECT to_status, recorded_at, (row_number() OVER (ORDER BY recorded_at, id))::int AS seq
    FROM results.result_status_transition WHERE result_version_id = ${rv.resultVersionId}`.execute(
    ctx.trx,
  );
  const { rows: superseding } = await sql<{ id: string; recorded_at: Date }>`
    SELECT id, recorded_at FROM results.result_version WHERE supersedes_version_id = ${rv.resultVersionId}`.execute(
    ctx.trx,
  );
  const discipline = await disciplineVersionOf(ctx, path);
  const bundleFacts = await loadBundleFacts(ctx, rv.resultVersionId);

  const evidenceIds = ids(bundleFacts.evidence.map((e) => e.evidenceId));
  const storedEvidence =
    evidenceIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            descriptor: unknown;
            descriptor_hash: string;
            content_hash: string;
          }>`
            SELECT id, descriptor, descriptor_hash, content_hash FROM evidence.item WHERE id = ANY(${evidenceIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;
  const { rows: attestations } = await sql<{
    id: string;
    statement: unknown;
    statement_hash: string;
    proof: unknown;
    key_id: string;
    issuer_principal_id: string;
  }>`SELECT id, statement, statement_hash, proof, key_id, issuer_principal_id FROM attestation.attestation
     WHERE subject_type = 'RESULT_VERSION' AND subject_id = ${rv.resultVersionId}`.execute(ctx.trx);
  const attestationIds = attestations.map((a) => a.id);
  const retractions =
    attestationIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            statement: unknown;
            statement_hash: string;
            proof: unknown;
            key_id: string;
          }>`
            SELECT id, statement, statement_hash, proof, key_id FROM attestation.retraction
            WHERE attestation_id = ANY(${attestationIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const keyIds = ids([...attestations.map((a) => a.key_id), ...retractions.map((r) => r.key_id)]);
  const keys =
    keyIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            principal_id: string;
            key_kind: string;
            algorithm: string;
            verification_material: Record<string, unknown>;
            fact_hash: string;
            effective_from: Date;
            effective_to: Date | null;
            recorded_at: Date;
          }>`SELECT id, principal_id, key_kind, algorithm, verification_material, fact_hash, effective_from, effective_to, recorded_at
             FROM authority.principal_key WHERE id = ANY(${keyIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const keyChanges =
    keyIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            key_id: string;
            kind: 'ROTATED' | 'REVOKED' | 'COMPROMISED';
            effective_from: Date;
            compromised_since: Date | null;
            recorded_at: Date;
          }>`SELECT id, key_id, kind, effective_from, compromised_since, recorded_at
             FROM authority.principal_key_status_change WHERE key_id = ANY(${keyIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;

  // Authority: every grant held by an issuer (or the submitter), their full parent chains, the
  // anchors of every grantor and every status change — the BRT-03 engine re-walks the chains.
  const issuers = ids([
    version.submitted_by_principal_id,
    ...attestations.map((a) => a.issuer_principal_id),
  ]);
  const { rows: grants } = await sql<{
    id: string;
    grantor_principal_id: string;
    grantee_principal_id: string;
    parent_grant_id: string | null;
    capabilities: Capability[];
    scope: AuthorityScope;
    delegation: { allowed: boolean; maxDepth: number; capabilitiesDelegable?: Capability[] };
    grant_hash: string;
    effective_from: Date;
    effective_to: Date | null;
    recorded_at: Date;
  }>`
    WITH RECURSIVE chain AS (
      SELECT g.* FROM authority.authority_grant g WHERE g.grantee_principal_id = ANY(${issuers}::uuid[])
      UNION
      SELECT p.* FROM authority.authority_grant p JOIN chain c ON p.id = c.parent_grant_id
    ) SELECT id, grantor_principal_id, grantee_principal_id, parent_grant_id, capabilities, scope, delegation,
             grant_hash, effective_from, effective_to, recorded_at FROM chain`.execute(ctx.trx);
  const grantIds = ids(grants.map((g) => g.id));
  const grantChanges =
    grantIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            grant_id: string;
            compromise: boolean;
            effective_from: Date;
            recorded_at: Date;
          }>`
            SELECT id, grant_id, compromise, effective_from, recorded_at FROM authority.authority_grant_status_change
            WHERE grant_id = ANY(${grantIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const grantors = ids(grants.map((g) => g.grantor_principal_id));
  const anchors =
    grantors.length === 0
      ? []
      : (
          await sql<{
            id: string;
            principal_id: string;
            recognition_scope: RecognitionScope;
            fact_hash: string;
            effective_from: Date;
            effective_to: Date | null;
            recorded_at: Date;
          }>`SELECT id, principal_id, recognition_scope, fact_hash, effective_from, effective_to, recorded_at
             FROM authority.trust_anchor WHERE principal_id = ANY(${grantors}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;
  const anchorIds = ids(anchors.map((a) => a.id));
  const anchorChanges =
    anchorIds.length === 0
      ? []
      : (
          await sql<{ id: string; anchor_id: string; effective_from: Date; recorded_at: Date }>`
            SELECT id, anchor_id, effective_from, recorded_at FROM authority.trust_anchor_status_change
            WHERE anchor_id = ANY(${anchorIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const participation = await loadRawParticipation(ctx, path, rv, [
    ...issuers,
    ...bundleFacts.evidence.flatMap((e) =>
      e.source.principalId === undefined ? [] : [e.source.principalId],
    ),
  ]);
  const sidePrincipals = ids([
    ...participation.personPrincipals.map((p) => p.principalId),
    ...participation.organizationPrincipals.map((p) => p.principalId),
  ]);
  const principalIds = ids([
    ...issuers,
    ...grants.flatMap((g) => [g.grantor_principal_id, g.grantee_principal_id]),
    ...anchors.map((a) => a.principal_id),
    ...bundleFacts.evidence.flatMap((e) =>
      e.source.principalId === undefined ? [] : [e.source.principalId],
    ),
    ...sidePrincipals,
  ]);
  const { rows: principals } = await sql<{
    id: string;
    principal_type: PrincipalType;
    recorded_at: Date;
  }>`
    SELECT id, principal_type, recorded_at FROM authority.principal WHERE id = ANY(${principalIds}::uuid[])`.execute(
    ctx.trx,
  );

  const opt = <K extends string, V>(k: K, v: V | null | undefined) =>
    v === null || v === undefined ? {} : ({ [k]: v } as Record<K, V>);
  return {
    policy,
    resultVersion: {
      resultVersionId: rv.resultVersionId,
      resultId: rv.resultId,
      versionNumber: rv.versionNumber,
      contentHash: rv.contentHash,
      contentSchema: rv.contentSchema,
      content: version.content,
      submittedByPrincipalId: version.submitted_by_principal_id,
      recordedAt: version.recorded_at,
      scopeType: rv.scopeType,
      scopeTargetId: rv.scopeTargetId,
    },
    statusTransitions: transitions.map((t) => ({
      toStatus: t.to_status,
      recordedAt: t.recorded_at,
      seq: t.seq,
    })),
    supersedingVersions: superseding.map((s) => ({
      resultVersionId: s.id,
      recordedAt: s.recorded_at,
    })),
    hierarchy: {
      level: path.level as 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST',
      competitionId: path.competitionId as string,
      ...opt('eventId', path.eventId),
      ...opt('roundId', path.roundId),
      ...opt('contestId', path.contestId),
      ...opt('sport', path.sport),
      ...opt('discipline', path.discipline),
      ...opt('region', path.region),
    },
    discipline,
    bundleFacts,
    storedEvidence: storedEvidence.map((e) => ({
      evidenceId: e.id,
      descriptor: e.descriptor,
      descriptorHash: e.descriptor_hash,
      contentHash: e.content_hash,
    })),
    storedAttestations: attestations.map((a) => ({
      attestationId: a.id,
      statement: a.statement,
      statementHash: a.statement_hash,
      proof: a.proof,
      keyId: a.key_id,
    })),
    storedRetractions: retractions.map((r) => ({
      retractionId: r.id,
      statement: r.statement,
      statementHash: r.statement_hash,
      proof: r.proof,
      keyId: r.key_id,
    })),
    keys: keys.map((k) => ({
      keyId: k.id,
      principalId: k.principal_id,
      keyKind: k.key_kind,
      algorithm: k.algorithm,
      verificationMaterial: k.verification_material,
      factHash: k.fact_hash,
      effectiveFrom: k.effective_from,
      ...opt('effectiveTo', k.effective_to),
      recordedAt: k.recorded_at,
    })),
    keyStatusChanges: keyChanges.map((c) => ({
      statusChangeId: c.id,
      keyId: c.key_id,
      kind: c.kind,
      effectiveFrom: c.effective_from,
      ...opt('compromisedSince', c.compromised_since),
      recordedAt: c.recorded_at,
    })),
    authority: {
      principals: principals.map((p) => ({
        principalId: p.id,
        principalType: p.principal_type,
        recordedAt: p.recorded_at,
      })),
      anchors: anchors.map((a) => ({
        anchorId: a.id,
        principalId: a.principal_id,
        recognitionScope: a.recognition_scope,
        factHash: a.fact_hash,
        effectiveFrom: a.effective_from,
        ...opt('effectiveTo', a.effective_to),
        recordedAt: a.recorded_at,
      })),
      anchorStatusChanges: anchorChanges.map((c) => ({
        statusChangeId: c.id,
        anchorId: c.anchor_id,
        effectiveFrom: c.effective_from,
        recordedAt: c.recorded_at,
      })),
      grants: grants.map((g) => ({
        grantId: g.id,
        grantorPrincipalId: g.grantor_principal_id,
        granteePrincipalId: g.grantee_principal_id,
        ...opt('parentGrantId', g.parent_grant_id),
        capabilities: g.capabilities,
        scope: g.scope,
        delegation: g.delegation,
        grantHash: g.grant_hash,
        effectiveFrom: g.effective_from,
        ...opt('effectiveTo', g.effective_to),
        recordedAt: g.recorded_at,
      })),
      grantStatusChanges: grantChanges.map((c) => ({
        statusChangeId: c.id,
        grantId: c.grant_id,
        compromise: c.compromise,
        effectiveFrom: c.effective_from,
        recordedAt: c.recorded_at,
      })),
    },
    participation,
  };
}

/** A relation's full status history, in append order (the assembler applies the cutoff). */
type History = { status: string; recorded_at: string }[];
const historyOf = (table: string, fk: string, ref: string) =>
  sql.raw(`COALESCE((SELECT jsonb_agg(jsonb_build_object('status', h.status, 'recorded_at', h.recorded_at) ORDER BY h.seq)
    FROM ${table} h WHERE h.${fk} = ${ref}), '[]'::jsonb)`);
const statusChanges = (h: History) =>
  h.map((c) => ({ status: c.status, recordedAt: new Date(c.recorded_at) }));

/**
 * Structural participation rows for the result's competition / event / contest: participants,
 * contest slots and status transitions (occurrence window), athlete → person, team memberships
 * (full ACTIVE / ENDED history), team managers,
 * team affiliation labels, declared lineups, guardians, Person ↔ PERSON Principal and
 * Organization ↔ ORGANIZATION Principal mappings, the organizer organization, its OWNER/ADMIN
 * persons and operational competition staff. Ids and times only.
 */
export async function loadRawParticipation(
  ctx: TxContext,
  path: ScopePath,
  rv: ResolvedResultVersion,
  relevantPrincipals: readonly string[],
): Promise<RawParticipation> {
  const competitionId = path.competitionId as string;
  const { rows: comp } = await sql<{ organizer_organization_id: string }>`
    SELECT organizer_organization_id FROM competition.competition WHERE id = ${competitionId}`.execute(
    ctx.trx,
  );
  const organizerOrganizationId = comp[0]?.organizer_organization_id;
  if (organizerOrganizationId === undefined) throw new Error('competition missing');
  const participants =
    path.eventId === undefined
      ? []
      : (
          await sql<{
            id: string;
            participant_kind: 'INDIVIDUAL' | 'TEAM';
            athlete_id: string | null;
            team_id: string | null;
            recorded_at: Date;
          }>`SELECT id, participant_kind, athlete_id, team_id, recorded_at FROM competition.participant WHERE event_id = ${path.eventId}`.execute(
            ctx.trx,
          )
        ).rows;
  const contestants =
    rv.scopeType !== 'CONTEST' || path.contestId === undefined
      ? undefined
      : (
          await sql<{ participant_id: string | null; recorded_at: Date }>`
            SELECT participant_id, recorded_at FROM competition.contestant WHERE contest_id = ${path.contestId}`.execute(
            ctx.trx,
          )
        ).rows;
  const contestStatusChanges =
    rv.scopeType !== 'CONTEST' || path.contestId === undefined
      ? undefined
      : (
          await sql<{ status: string; recorded_at: Date }>`
            SELECT status, recorded_at FROM competition.contest_status_change
            WHERE contest_id = ${path.contestId} ORDER BY seq`.execute(ctx.trx)
        ).rows;
  const teamIds = ids(participants.map((p) => p.team_id));
  const memberships =
    teamIds.length === 0
      ? []
      : (
          await sql<{ id: string; team_id: string; athlete_id: string; history: History }>`
            SELECT m.id, m.team_id, m.athlete_id,
                   ${historyOf('competition.team_membership_status_change', 'team_membership_id', 'm.id')} AS history
            FROM competition.team_membership m
            WHERE m.team_id = ANY(${teamIds}::uuid[])`.execute(ctx.trx)
        ).rows;
  const managers =
    teamIds.length === 0
      ? []
      : (
          await sql<{ team_id: string; person_id: string; recorded_at: Date }>`
            SELECT team_id, person_id, recorded_at FROM competition.team_manager WHERE team_id = ANY(${teamIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;
  const teamOrgs =
    teamIds.length === 0
      ? []
      : (
          await sql<{ id: string; organization_id: string; recorded_at: Date }>`
            SELECT id, organization_id, recorded_at FROM competition.team
            WHERE id = ANY(${teamIds}::uuid[]) AND organization_id IS NOT NULL`.execute(ctx.trx)
        ).rows;
  const lineups =
    path.contestId === undefined
      ? []
      : (
          await sql<{ participant_id: string; athlete_id: string; recorded_at: Date }>`
            SELECT l.participant_id, m.athlete_id, m.recorded_at
            FROM competition.lineup l JOIN competition.lineup_member m ON m.lineup_id = l.id
            WHERE l.contest_id = ${path.contestId}`.execute(ctx.trx)
        ).rows;
  const athleteIds = ids([
    ...participants.map((p) => p.athlete_id),
    ...memberships.map((m) => m.athlete_id),
    ...lineups.map((l) => l.athlete_id),
  ]);
  const athletes =
    athleteIds.length === 0
      ? []
      : (
          await sql<{ id: string; person_id: string; recorded_at: Date }>`
            SELECT id, person_id, recorded_at FROM identity.athlete WHERE id = ANY(${athleteIds}::uuid[])`.execute(
            ctx.trx,
          )
        ).rows;
  const athletePersons = ids(athletes.map((a) => a.person_id));
  const guardians =
    athletePersons.length === 0
      ? []
      : (
          await sql<{
            guardian_person_id: string;
            dependent_person_id: string;
            effective_from: Date;
            history: History;
          }>`
            SELECT g.guardian_person_id, g.dependent_person_id, g.effective_from,
                   ${historyOf('identity.guardian_relationship_status_change', 'guardian_relationship_id', 'g.id')} AS history
            FROM identity.guardian_relationship g
            WHERE g.dependent_person_id = ANY(${athletePersons}::uuid[])`.execute(ctx.trx)
        ).rows;
  const admins = (
    await sql<{ person_id: string; history: History }>`
      SELECT m.person_id,
             ${historyOf('organizations.membership_status_change', 'membership_id', 'm.id')} AS history
      FROM organizations.membership m
      WHERE m.organization_id = ${organizerOrganizationId} AND m.membership_role IN ('OWNER', 'ADMIN')`.execute(
      ctx.trx,
    )
  ).rows;
  const staff = (
    await sql<{ person_id: string; history: History }>`
      SELECT st.person_id,
             ${historyOf('competition.competition_staff_status_change', 'staff_id', 'st.id')} AS history
      FROM competition.competition_staff st
      WHERE st.competition_id = ${competitionId}`.execute(ctx.trx)
  ).rows;
  const persons = ids([
    ...athletePersons,
    ...guardians.map((g) => g.guardian_person_id),
    ...managers.map((m) => m.person_id),
    ...admins.map((a) => a.person_id),
    ...staff.map((s) => s.person_id),
  ]);
  const relevant = ids(relevantPrincipals);
  const personPrincipals = (
    await sql<{ person_id: string; principal_id: string; recorded_at: Date }>`
      SELECT person_id, principal_id, recorded_at FROM identity.person_principal
      WHERE person_id = ANY(${persons}::uuid[]) OR principal_id = ANY(${relevant}::uuid[])`.execute(
      ctx.trx,
    )
  ).rows;
  const orgs = ids([organizerOrganizationId, ...teamOrgs.map((t) => t.organization_id)]);
  const organizationPrincipals = (
    await sql<{ organization_id: string; principal_id: string; recorded_at: Date }>`
      SELECT organization_id, principal_id, recorded_at FROM organizations.organization_principal
      WHERE organization_id = ANY(${orgs}::uuid[]) OR principal_id = ANY(${relevant}::uuid[])`.execute(
      ctx.trx,
    )
  ).rows;

  return {
    ...(contestants === undefined
      ? {}
      : {
          contestants: contestants.map((c) => ({
            ...(c.participant_id === null ? {} : { participantId: c.participant_id }),
            recordedAt: c.recorded_at,
          })),
        }),
    participants: participants.map((p) => ({
      participantId: p.id,
      kind: p.participant_kind,
      ...(p.athlete_id === null ? {} : { athleteId: p.athlete_id }),
      ...(p.team_id === null ? {} : { teamId: p.team_id }),
      recordedAt: p.recorded_at,
    })),
    athletes: athletes.map((a) => ({
      athleteId: a.id,
      personId: a.person_id,
      recordedAt: a.recorded_at,
    })),
    ...(contestStatusChanges === undefined
      ? {}
      : {
          contestStatusChanges: contestStatusChanges.map((c) => ({
            status: c.status,
            recordedAt: c.recorded_at,
          })),
        }),
    teamMemberships: memberships.map((m) => ({
      teamId: m.team_id,
      athleteId: m.athlete_id,
      statusChanges: statusChanges(m.history),
    })),
    teamManagers: managers.map((m) => ({
      teamId: m.team_id,
      personId: m.person_id,
      recordedAt: m.recorded_at,
    })),
    teamOrganizations: teamOrgs.map((t) => ({
      teamId: t.id,
      organizationId: t.organization_id,
      recordedAt: t.recorded_at,
    })),
    lineupMembers: lineups.map((l) => ({
      participantId: l.participant_id,
      athleteId: l.athlete_id,
      recordedAt: l.recorded_at,
    })),
    guardians: guardians.map((g) => ({
      guardianPersonId: g.guardian_person_id,
      dependentPersonId: g.dependent_person_id,
      effectiveFrom: g.effective_from,
      statusChanges: statusChanges(g.history),
    })),
    personPrincipals: personPrincipals.map((p) => ({
      personId: p.person_id,
      principalId: p.principal_id,
      recordedAt: p.recorded_at,
    })),
    organizationPrincipals: organizationPrincipals.map((p) => ({
      organizationId: p.organization_id,
      principalId: p.principal_id,
      recordedAt: p.recorded_at,
    })),
    organizerOrganizationId,
    organizerAdmins: admins.map((a) => ({
      personId: a.person_id,
      statusChanges: statusChanges(a.history),
    })),
    staff: staff.map((x) => ({ personId: x.person_id, statusChanges: statusChanges(x.history) })),
  };
}
