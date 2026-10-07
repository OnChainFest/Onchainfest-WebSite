import { randomBytes } from 'node:crypto';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import {
  buildChallengeMessage,
  hasControlCharacters,
  normalizeWalletTarget,
  schemeSupportsNetwork,
  normalizeSlug,
  type AttributeVisibility,
  type GuardianConfirmationBasis,
  type GuardianRelationshipKind,
  type PersonOperation,
  type ProfileVisibility,
  type ProviderAssertion,
  type WalletChallenge,
  type WalletProofStatus,
  type WalletProofScheme,
  type WalletProofVerifier,
} from '@br/identity';
import { sql } from 'kysely';
import type { Db } from './db';
import {
  assertPersonOperation,
  hasOrgPermission,
  identityIdempotency,
  loadControlFacts,
  lockKeys,
  pgConstraint,
  recordAudit,
} from './identity-support';
import { emitEvent } from './outbox';
import { refreshAthletePassport } from './passport-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

const WALLET_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface AthleteProfileInput {
  readonly displayName: string;
  readonly shortBio?: string | null;
  readonly homeCountry?: string | null;
  readonly preferredSports?: readonly string[];
  readonly profileVisibility?: ProfileVisibility;
}

export interface IdentityStoreOptions {
  /** Wallet proof verifiers, in preference order. Test verifiers produce TEST_VERIFIED links only. */
  readonly walletVerifiers?: readonly WalletProofVerifier[];
  /** Audience (domain) bound into wallet challenges. */
  readonly audience?: string;
  /** Wallet challenge lifetime (default 10 minutes). */
  readonly walletChallengeTtlMs?: number;
}

function assertText(value: string, max: number, what: string): string {
  const v = value.normalize('NFC').trim();
  if (v.length === 0 || v.length > max)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} must be 1–${max} characters`);
  if (hasControlCharacters(v, { allowNewline: true }))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, `${what} contains control characters`);
  return v;
}

function slugOrThrow(input: string): string {
  const r = normalizeSlug(input);
  if (!r.ok)
    throw new DomainError(
      DomainErrorCode.SLUG_INVALID,
      r.reason === 'RESERVED' ? 'slug is reserved' : 'slug is invalid',
    );
  return r.slug;
}

async function currentStatus(
  ctx: TxContext,
  view: string,
  idColumn: string,
  id: string,
): Promise<string | undefined> {
  const { rows } = await sql<{
    status: string;
  }>`SELECT status FROM ${sql.raw(view)} WHERE ${sql.ref(idColumn)} = ${id}`.execute(ctx.trx);
  return rows[0]?.status;
}

/**
 * Identity context (br_identity). Every command runs in one transaction with its ledger facts,
 * passport refresh, outbox events, audit entries and idempotency record.
 */
export class IdentityStore {
  private readonly db: Db;
  private readonly verifiers: readonly WalletProofVerifier[];
  private readonly audience: string;
  private readonly challengeTtlMs: number;

  constructor(db: Db, options: IdentityStoreOptions = {}) {
    this.db = db;
    const verifiers = options.walletVerifiers ?? [];
    if (process.env.NODE_ENV === 'production' && verifiers.some((v) => v.kind !== 'PRODUCTION')) {
      throw new Error('test wallet verifiers cannot be configured in production');
    }
    for (const scheme of new Set(verifiers.map((v) => v.scheme))) {
      if (verifiers.filter((v) => v.scheme === scheme).length > 1)
        throw new Error(`more than one wallet verifier configured for scheme ${scheme}`);
    }
    this.verifiers = verifiers;
    this.audience = options.audience ?? 'bragging-rights.local';
    this.challengeTtlMs = options.walletChallengeTtlMs ?? WALLET_CHALLENGE_TTL_MS;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.identity, fn);
  }

  // ───────────────────────────── accounts ─────────────────────────────

  /**
   * Authentication callback: (provider, providerSubject) is the stable identity. First sign-in
   * creates an Account (not a person) + AuthIdentity; later sign-ins return the same account.
   */
  signIn(
    assertion: ProviderAssertion,
  ): Promise<{ accountId: string; authIdentityId: string; created: boolean }> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `auth:${assertion.provider}:${assertion.providerSubject}`);
      const { rows } = await sql<{ id: string; account_id: string }>`
        SELECT id, account_id FROM identity.auth_identity WHERE provider = ${assertion.provider} AND provider_subject = ${assertion.providerSubject}`.execute(
        ctx.trx,
      );
      const existing = rows[0];
      if (existing !== undefined) {
        await sql`INSERT INTO identity.auth_identity_activity (auth_identity_id, last_authenticated_at) VALUES (${existing.id}, ${ctx.txTime})
          ON CONFLICT (auth_identity_id) DO UPDATE SET last_authenticated_at = EXCLUDED.last_authenticated_at`.execute(
          ctx.trx,
        );
        return { accountId: existing.account_id, authIdentityId: existing.id, created: false };
      }
      const accountId = newId();
      const authIdentityId = newId();
      await sql`INSERT INTO identity.account (id, recorded_at) VALUES (${accountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.account_status_change (id, account_id, status, recorded_at) VALUES (${newId()}, ${accountId}, 'ACTIVE', ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.auth_identity (id, account_id, provider, provider_subject, email_verified, recorded_at)
        VALUES (${authIdentityId}, ${accountId}, ${assertion.provider}, ${assertion.providerSubject}, ${assertion.emailVerified ?? null}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.auth_identity_activity (auth_identity_id, last_authenticated_at) VALUES (${authIdentityId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'AccountCreated',
        aggregateType: 'ACCOUNT',
        aggregateId: accountId as Uuid,
        payload: { provider: assertion.provider },
      });
      await recordAudit(ctx, {
        actorAccountId: accountId,
        action: 'account.created',
        targetType: 'ACCOUNT',
        targetId: accountId,
      });
      return { accountId, authIdentityId, created: true };
    });
  }

  /** INTERNAL: disabling an account never erases sporting history. */
  disableAccount(input: {
    operatorAccountId: string;
    accountId: string;
    reason: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      // 'account:<id>' is the key the vault authorization takes SHARED: disabling waits for
      // in-flight private-data operations and later ones see DISABLED.
      await lockKeys(ctx, `account:${input.accountId}`);
      if (
        (await currentStatus(ctx, 'identity.v_account_current', 'account_id', input.accountId)) ===
        undefined
      ) {
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'account not found');
      }
      await sql`INSERT INTO identity.account_status_change (id, account_id, status, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${input.accountId}, 'DISABLED', ${input.reason}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'AccountDisabled',
        aggregateType: 'ACCOUNT',
        aggregateId: input.accountId as Uuid,
        payload: {},
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'account.disabled',
        targetType: 'ACCOUNT',
        targetId: input.accountId,
      });
    });
  }

  me(accountId: string) {
    return this.tx(async (ctx) => {
      const facts = await loadControlFacts(ctx, accountId);
      const persons = [
        ...(facts.selfPersonId === undefined ? [] : [facts.selfPersonId]),
        ...facts.activeDependentPersonIds,
      ];
      const { rows: athletes } =
        persons.length === 0
          ? { rows: [] as { id: string; person_id: string; slug: string }[] }
          : await sql<{ id: string; person_id: string; slug: string }>`
              SELECT a.id, a.person_id, s.slug FROM identity.athlete a JOIN identity.v_athlete_slug_current s ON s.athlete_id = a.id
              WHERE a.person_id IN (${sql.join(persons)})`.execute(ctx.trx);
      const { rows: pending } =
        facts.selfPersonId === undefined
          ? { rows: [] as { id: string; dependent_person_id: string; status: string }[] }
          : await sql<{ id: string; dependent_person_id: string; status: string }>`
              SELECT g.id, g.dependent_person_id, c.status FROM identity.guardian_relationship g
              JOIN identity.v_guardian_relationship_current c ON c.guardian_relationship_id = g.id
              WHERE g.guardian_person_id = ${facts.selfPersonId}`.execute(ctx.trx);
      return {
        accountId,
        accountActive: facts.accountActive,
        selfPersonId: facts.selfPersonId ?? null,
        guardianRelationships: pending.map((g) => ({
          id: g.id,
          dependentPersonId: g.dependent_person_id,
          status: g.status,
        })),
        athletes: athletes.map((a) => ({ athleteId: a.id, personId: a.person_id, slug: a.slug })),
      };
    });
  }

  /**
   * ONCF-02: public athlete identity for persons on an organization roster. Only ACTIVE athletes
   * whose profile is PUBLIC or AUTHENTICATED are returned (PRIVATE profiles stay anonymous);
   * slug and display name only — never PII.
   */
  visibleAthletesForPersons(
    personIds: readonly string[],
  ): Promise<Map<string, { slug: string; displayName: string }>> {
    if (personIds.length === 0) return Promise.resolve(new Map());
    return this.tx(async (ctx) => {
      const { rows } = await sql<{ person_id: string; slug: string; display_name: string }>`
        SELECT a.person_id, s.slug, p.display_name
        FROM identity.athlete a
        JOIN identity.v_athlete_current c ON c.athlete_id = a.id AND c.status = 'ACTIVE'
        JOIN identity.v_athlete_slug_current s ON s.athlete_id = a.id
        JOIN identity.athlete_profile p ON p.athlete_id = a.id
          AND p.profile_visibility IN ('PUBLIC', 'AUTHENTICATED')
        WHERE a.person_id IN (${sql.join([...personIds])})`.execute(ctx.trx);
      return new Map(rows.map((r) => [r.person_id, { slug: r.slug, displayName: r.display_name }]));
    });
  }

  /**
   * ONCF-04: the same rule keyed by athlete, to name registrations for competition staff. Only
   * ACTIVE athletes whose profile is PUBLIC or AUTHENTICATED are returned; slug and display name only.
   */
  visibleAthletes(
    athleteIds: readonly string[],
  ): Promise<Map<string, { slug: string; displayName: string }>> {
    if (athleteIds.length === 0) return Promise.resolve(new Map());
    return this.tx(async (ctx) => {
      const { rows } = await sql<{ athlete_id: string; slug: string; display_name: string }>`
        SELECT a.id AS athlete_id, s.slug, p.display_name
        FROM identity.athlete a
        JOIN identity.v_athlete_current c ON c.athlete_id = a.id AND c.status = 'ACTIVE'
        JOIN identity.v_athlete_slug_current s ON s.athlete_id = a.id
        JOIN identity.athlete_profile p ON p.athlete_id = a.id
          AND p.profile_visibility IN ('PUBLIC', 'AUTHENTICATED')
        WHERE a.id IN (${sql.join([...athleteIds])})`.execute(ctx.trx);
      return new Map(
        rows.map((r) => [r.athlete_id, { slug: r.slug, displayName: r.display_name }]),
      );
    });
  }

  /**
   * ONCF-02: the person behind an athlete profile address, for organization invitations. Only
   * ACTIVE athletes with a PUBLIC or AUTHENTICATED profile resolve; anything else is undefined
   * (indistinguishable from an unknown address).
   */
  invitablePersonByAthleteSlug(slug: string): Promise<string | undefined> {
    const n = normalizeSlug(slug);
    if (!n.ok) return Promise.resolve(undefined);
    return this.tx(async (ctx) => {
      const { rows } = await sql<{ person_id: string }>`
        SELECT a.person_id
        FROM identity.athlete_slug sl
        JOIN identity.athlete a ON a.id = sl.athlete_id
        JOIN identity.v_athlete_current c ON c.athlete_id = a.id AND c.status = 'ACTIVE'
        JOIN identity.athlete_profile p ON p.athlete_id = a.id
          AND p.profile_visibility IN ('PUBLIC', 'AUTHENTICATED')
        WHERE sl.slug = ${n.slug}`.execute(ctx.trx);
      return rows[0]?.person_id;
    });
  }

  /** Whether the account may perform `op` on a person (used to gate the PII vault). */
  canOperateOnPerson(accountId: string, personId: string, op: PersonOperation): Promise<boolean> {
    return this.tx(async (ctx) => {
      try {
        await assertPersonOperation(ctx, accountId, personId, op);
        return true;
      } catch (err) {
        if (err instanceof DomainError && err.code === DomainErrorCode.FORBIDDEN) return false;
        throw err;
      }
    });
  }

  // ───────────────────────────── persons & guardians ─────────────────────────────

  /**
   * SELF: the account's own person (at most one per account and per person).
   * DEPENDENT: a person managed by the caller's SELF person, created with a PENDING (asserted)
   * guardian relationship — it grants nothing until confirmed.
   * `privateFingerprint` is a keyed HMAC of any private data sent alongside (never raw PII).
   */
  createPerson(input: {
    actorAccountId: string;
    relation: 'SELF' | 'DEPENDENT';
    relationshipKind?: GuardianRelationshipKind;
    idempotencyKey: string;
    privateFingerprint?: string;
  }): Promise<{ personId: string; guardianRelationshipId: string | null; created: boolean }> {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        personId: string;
        guardianRelationshipId: string | null;
      }>(ctx, {
        command: 'CreatePerson',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          relation: input.relation,
          relationshipKind: input.relationshipKind,
          privateFingerprint: input.privateFingerprint,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `account-person:${input.actorAccountId}`);
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (!facts.accountActive) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      const personId = newId();
      let guardianRelationshipId: string | null = null;
      if (input.relation === 'SELF') {
        if (facts.selfPersonId !== undefined)
          throw new DomainError(
            DomainErrorCode.ALREADY_EXISTS,
            'this account already controls its own person',
          );
        await sql`INSERT INTO identity.person (id, created_by_account_id, recorded_at) VALUES (${personId}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        await sql`INSERT INTO identity.account_person_control (id, account_id, person_id, control_kind, recorded_at)
          VALUES (${newId()}, ${input.actorAccountId}, ${personId}, 'SELF', ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } else {
        if (facts.selfPersonId === undefined)
          throw new DomainError(
            DomainErrorCode.FORBIDDEN,
            'a guardian must first have their own person',
          );
        await sql`INSERT INTO identity.person (id, created_by_account_id, recorded_at) VALUES (${personId}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        guardianRelationshipId = await this.insertGuardianRelationship(
          ctx,
          facts.selfPersonId,
          personId,
          input.relationshipKind ?? 'PARENT',
          input.actorAccountId,
        );
      }
      await emitEvent(ctx, {
        eventType: 'PersonCreated',
        aggregateType: 'PERSON',
        aggregateId: personId as Uuid,
        payload: { relation: input.relation },
      });
      const response = { personId, guardianRelationshipId };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  private async insertGuardianRelationship(
    ctx: TxContext,
    guardianPersonId: string,
    dependentPersonId: string,
    kind: GuardianRelationshipKind,
    actorAccountId: string,
  ): Promise<string> {
    const id = newId();
    await sql`INSERT INTO identity.guardian_relationship (id, guardian_person_id, dependent_person_id, relationship_kind, asserted_by_account_id, effective_from, recorded_at)
      VALUES (${id}, ${guardianPersonId}, ${dependentPersonId}, ${kind}, ${actorAccountId}, ${ctx.txTime}, ${ctx.txTime})`.execute(
      ctx.trx,
    );
    await sql`INSERT INTO identity.guardian_relationship_status_change (id, guardian_relationship_id, status, actor_account_id, recorded_at)
      VALUES (${newId()}, ${id}, 'PENDING', ${actorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
    await emitEvent(ctx, {
      eventType: 'GuardianRelationshipAsserted',
      aggregateType: 'GUARDIAN_RELATIONSHIP',
      aggregateId: id as Uuid,
      payload: { status: 'PENDING' },
    });
    await recordAudit(ctx, {
      actorAccountId,
      action: 'guardian.asserted',
      targetType: 'GUARDIAN_RELATIONSHIP',
      targetId: id,
    });
    await this.refreshPersonPassports(ctx, dependentPersonId);
    return id;
  }

  /** Assert guardianship over an existing person (PENDING until confirmed). */
  assertGuardianRelationship(input: {
    actorAccountId: string;
    dependentPersonId: string;
    relationshipKind: GuardianRelationshipKind;
    idempotencyKey: string;
  }) {
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ guardianRelationshipId: string }>(ctx, {
        command: 'AssertGuardianRelationship',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          dependentPersonId: input.dependentPersonId,
          relationshipKind: input.relationshipKind,
        },
      });
      if (idem.lookup.replay) return idem.lookup.response;
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      if (
        !facts.accountActive ||
        facts.selfPersonId === undefined ||
        facts.selfPersonId === input.dependentPersonId
      ) {
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      await lockKeys(ctx, `guardian:${facts.selfPersonId}:${input.dependentPersonId}`);
      const { rows } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM identity.person WHERE id = ${input.dependentPersonId}`.execute(
        ctx.trx,
      );
      if ((rows[0]?.n ?? 0) === 0)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'person not found');
      const { rows: open } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM identity.guardian_relationship g JOIN identity.v_guardian_relationship_current c ON c.guardian_relationship_id = g.id
        WHERE g.guardian_person_id = ${facts.selfPersonId} AND g.dependent_person_id = ${input.dependentPersonId} AND c.status IN ('PENDING', 'ACTIVE')`.execute(
        ctx.trx,
      );
      if ((open[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'a guardian relationship is already pending or active',
        );
      const guardianRelationshipId = await this.insertGuardianRelationship(
        ctx,
        facts.selfPersonId,
        input.dependentPersonId,
        input.relationshipKind,
        input.actorAccountId,
      );
      await idem.record({ guardianRelationshipId });
      return { guardianRelationshipId };
    });
  }

  /** INTERNAL (platform review) or organization confirmation: PENDING → ACTIVE. */
  confirmGuardianRelationship(input: {
    operatorAccountId: string;
    guardianRelationshipId: string;
    basis: GuardianConfirmationBasis;
  }): Promise<void> {
    return this.setGuardianStatus(
      input.guardianRelationshipId,
      'ACTIVE',
      input.operatorAccountId,
      input.basis,
      undefined,
      ['PENDING'],
    );
  }

  /** The guardian (or an operator) revokes/ends the relationship. */
  async revokeGuardianRelationship(input: {
    actorAccountId: string;
    guardianRelationshipId: string;
    reason: string;
    operator?: boolean;
  }): Promise<void> {
    if (input.operator !== true) {
      await this.tx(async (ctx) => {
        const facts = await loadControlFacts(ctx, input.actorAccountId);
        const { rows } = await sql<{
          guardian_person_id: string;
        }>`SELECT guardian_person_id FROM identity.guardian_relationship WHERE id = ${input.guardianRelationshipId}`.execute(
          ctx.trx,
        );
        if (
          rows[0] === undefined ||
          rows[0].guardian_person_id !== facts.selfPersonId ||
          !facts.accountActive
        ) {
          throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
        }
      });
    }
    return this.setGuardianStatus(
      input.guardianRelationshipId,
      'REVOKED',
      input.actorAccountId,
      undefined,
      input.reason,
      ['PENDING', 'ACTIVE'],
    );
  }

  private setGuardianStatus(
    id: string,
    status: 'ACTIVE' | 'REVOKED',
    actorAccountId: string,
    basis: GuardianConfirmationBasis | undefined,
    reason: string | undefined,
    from: string[],
  ): Promise<void> {
    return this.tx(async (ctx) => {
      // The relationship row is immutable, so reading the dependent before locking is safe.
      // 'person-control:<dependent>' is the key the vault authorization takes SHARED.
      const { rows: rel } = await sql<{ dependent_person_id: string }>`
        SELECT dependent_person_id FROM identity.guardian_relationship WHERE id = ${id}`.execute(
        ctx.trx,
      );
      await lockKeys(
        ctx,
        `guardian-rel:${id}`,
        ...(rel[0] === undefined ? [] : [`person-control:${rel[0].dependent_person_id}`]),
      );
      const current = await currentStatus(
        ctx,
        'identity.v_guardian_relationship_current',
        'guardian_relationship_id',
        id,
      );
      if (current === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'guardian relationship not found');
      if (!from.includes(current))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot move a ${current} relationship to ${status}`,
        );
      await sql`INSERT INTO identity.guardian_relationship_status_change (id, guardian_relationship_id, status, confirmation_basis, reason, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, ${status}, ${basis ?? null}, ${reason ?? null}, ${actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType:
          status === 'ACTIVE' ? 'GuardianRelationshipActivated' : 'GuardianRelationshipRevoked',
        aggregateType: 'GUARDIAN_RELATIONSHIP',
        aggregateId: id as Uuid,
        payload: { status, ...(basis === undefined ? {} : { basis }) },
      });
      await recordAudit(ctx, {
        actorAccountId,
        action: status === 'ACTIVE' ? 'guardian.confirmed' : 'guardian.revoked',
        targetType: 'GUARDIAN_RELATIONSHIP',
        targetId: id,
      });
      const { rows } = await sql<{
        dependent_person_id: string;
      }>`SELECT dependent_person_id FROM identity.guardian_relationship WHERE id = ${id}`.execute(
        ctx.trx,
      );
      if (rows[0] !== undefined)
        await this.refreshPersonPassports(ctx, rows[0].dependent_person_id);
    });
  }

  private async refreshPersonPassports(ctx: TxContext, personId: string): Promise<void> {
    const { rows } = await sql<{
      id: string;
    }>`SELECT id FROM identity.athlete WHERE person_id = ${personId}`.execute(ctx.trx);
    for (const r of rows) await refreshAthletePassport(ctx, r.id);
  }

  // ───────────────────────────── athletes ─────────────────────────────

  async createAthlete(input: {
    actorAccountId: string;
    personId: string;
    slug: string;
    profile: AthleteProfileInput;
    idempotencyKey: string;
  }): Promise<{ athleteId: string; slug: string; created: boolean }> {
    const slug = slugOrThrow(input.slug);
    const profile = this.validateProfile(input.profile, true);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ athleteId: string; slug: string }>(ctx, {
        command: 'CreateAthlete',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { personId: input.personId, slug, profile },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const facts = await assertPersonOperation(
        ctx,
        input.actorAccountId,
        input.personId,
        'CREATE_ATHLETE',
      );
      await lockKeys(ctx, `athlete-person:${input.personId}`, `athlete-slug:${slug}`);
      const { rows: existing } = await sql<{
        id: string;
      }>`SELECT id FROM identity.athlete WHERE person_id = ${input.personId}`.execute(ctx.trx);
      if (existing[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this person already has an athlete identity',
        );
      await this.assertSlugFree(ctx, slug);
      const athleteId = newId();
      // Dependents default to PRIVATE (and are restricted in the passport regardless).
      const visibility: ProfileVisibility =
        profile.profileVisibility ?? (facts.selfPersonId === input.personId ? 'PUBLIC' : 'PRIVATE');
      await sql`INSERT INTO identity.athlete (id, person_id, recorded_at) VALUES (${athleteId}, ${input.personId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.athlete_status_change (id, athlete_id, status, actor_account_id, recorded_at) VALUES (${newId()}, ${athleteId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.athlete_slug (slug, athlete_id, recorded_at) VALUES (${slug}, ${athleteId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.athlete_profile (athlete_id, display_name, short_bio, home_country, preferred_sports, profile_visibility, updated_at, updated_by_account_id)
        VALUES (${athleteId}, ${profile.displayName ?? ''}, ${profile.shortBio ?? null}, ${profile.homeCountry ?? null}, ${profile.preferredSports ?? []}, ${visibility}, ${ctx.txTime}, ${input.actorAccountId})`.execute(
        ctx.trx,
      );
      await refreshAthletePassport(ctx, athleteId);
      await emitEvent(ctx, {
        eventType: 'AthleteCreated',
        aggregateType: 'ATHLETE',
        aggregateId: athleteId as Uuid,
        payload: { slug },
      });
      const response = { athleteId, slug };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  private async assertSlugFree(ctx: TxContext, slug: string): Promise<void> {
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM identity.athlete_slug WHERE slug = ${slug}`.execute(ctx.trx);
    if ((rows[0]?.n ?? 0) > 0)
      throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');
  }

  private validateProfile(
    p: Partial<AthleteProfileInput>,
    requireName: boolean,
  ): Partial<AthleteProfileInput> {
    const out: { -readonly [K in keyof AthleteProfileInput]?: AthleteProfileInput[K] } = {};
    if (p.displayName !== undefined) out.displayName = assertText(p.displayName, 80, 'displayName');
    else if (requireName)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'displayName is required');
    if (p.shortBio !== undefined)
      out.shortBio = p.shortBio === null ? null : assertText(p.shortBio, 500, 'shortBio');
    if (p.homeCountry !== undefined) {
      if (p.homeCountry !== null && !/^[A-Z]{2}$/.test(p.homeCountry))
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'homeCountry must be ISO 3166-1 alpha-2',
        );
      out.homeCountry = p.homeCountry;
    }
    if (p.preferredSports !== undefined) {
      if (
        p.preferredSports.length > 10 ||
        !p.preferredSports.every((s) => /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(s))
      ) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'preferredSports must be up to 10 sport ids',
        );
      }
      out.preferredSports = [...new Set(p.preferredSports)];
    }
    if (p.profileVisibility !== undefined) {
      if (!['PUBLIC', 'AUTHENTICATED', 'PRIVATE'].includes(p.profileVisibility))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid visibility');
      out.profileVisibility = p.profileVisibility;
    }
    return out;
  }

  private async athletePerson(ctx: TxContext, athleteId: string): Promise<string> {
    const { rows } = await sql<{
      person_id: string;
    }>`SELECT person_id FROM identity.athlete WHERE id = ${athleteId}`.execute(ctx.trx);
    if (rows[0] === undefined) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
    return rows[0].person_id;
  }

  /** Self-described profile edits. Never creates verified facts, whatever the bio says. */
  async updateAthleteProfile(input: {
    actorAccountId: string;
    athleteId: string;
    patch: Partial<AthleteProfileInput>;
  }): Promise<void> {
    const patch = this.validateProfile(input.patch, false);
    return this.tx(async (ctx) => {
      const personId = await this.athletePerson(ctx, input.athleteId);
      await assertPersonOperation(
        ctx,
        input.actorAccountId,
        personId,
        patch.profileVisibility === undefined ? 'EDIT_ATHLETE_PROFILE' : 'SET_VISIBILITY',
      );
      await sql`UPDATE identity.athlete_profile SET
          display_name = COALESCE(${patch.displayName ?? null}, display_name),
          short_bio = CASE WHEN ${patch.shortBio !== undefined} THEN ${patch.shortBio ?? null} ELSE short_bio END,
          home_country = CASE WHEN ${patch.homeCountry !== undefined} THEN ${patch.homeCountry ?? null} ELSE home_country END,
          preferred_sports = COALESCE(${patch.preferredSports === undefined ? null : [...patch.preferredSports]}, preferred_sports),
          profile_visibility = COALESCE(${patch.profileVisibility ?? null}, profile_visibility),
          updated_at = ${ctx.txTime}, updated_by_account_id = ${input.actorAccountId}
        WHERE athlete_id = ${input.athleteId}`.execute(ctx.trx);
      await refreshAthletePassport(ctx, input.athleteId);
      await emitEvent(ctx, {
        eventType: 'AthleteProfileUpdated',
        aggregateType: 'ATHLETE',
        aggregateId: input.athleteId as Uuid,
        payload: { fields: Object.keys(patch) },
      });
    });
  }

  /** New slug claim; old slugs stay reserved to this athlete and redirect. */
  async changeAthleteSlug(input: {
    actorAccountId: string;
    athleteId: string;
    slug: string;
  }): Promise<{ slug: string }> {
    const slug = slugOrThrow(input.slug);
    return this.tx(async (ctx) => {
      const personId = await this.athletePerson(ctx, input.athleteId);
      await assertPersonOperation(ctx, input.actorAccountId, personId, 'EDIT_ATHLETE_PROFILE');
      await lockKeys(ctx, `athlete-slug:${slug}`);
      const { rows } = await sql<{
        athlete_id: string;
      }>`SELECT athlete_id FROM identity.athlete_slug WHERE slug = ${slug}`.execute(ctx.trx);
      if (rows[0] !== undefined && rows[0].athlete_id !== input.athleteId)
        throw new DomainError(DomainErrorCode.SLUG_TAKEN, 'slug is not available');
      // A slug is claimed once, forever (PK): a former slug keeps redirecting and cannot be re-claimed.
      if (rows[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.SLUG_TAKEN,
          'slug was already used by this athlete; choose a new slug',
        );
      await sql`INSERT INTO identity.athlete_slug (slug, athlete_id, recorded_at) VALUES (${slug}, ${input.athleteId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAthletePassport(ctx, input.athleteId);
      await emitEvent(ctx, {
        eventType: 'AthleteSlugChanged',
        aggregateType: 'ATHLETE',
        aggregateId: input.athleteId as Uuid,
        payload: { slug },
      });
      return { slug };
    });
  }

  /** INTERNAL foundation: record that an athlete id is a duplicate of a canonical athlete. */
  recordIdentityResolution(input: {
    operatorAccountId: string;
    athleteId: string;
    canonicalAthleteId: string;
    reason: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `athlete-resolution:${input.athleteId}`);
      const { rows } = await sql<{ canonical_athlete_id: string }>`
        SELECT canonical_athlete_id FROM identity.athlete_identity_resolution WHERE athlete_id = ${input.canonicalAthleteId}`.execute(
        ctx.trx,
      );
      if (rows[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'the canonical athlete is itself resolved to another athlete',
        );
      try {
        await sql`INSERT INTO identity.athlete_identity_resolution (id, athlete_id, canonical_athlete_id, reason, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.athleteId}, ${input.canonicalAthleteId}, ${input.reason}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'athlete already resolved');
        throw err;
      }
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'athlete.identity-resolved',
        targetType: 'ATHLETE',
        targetId: input.athleteId,
      });
      await refreshAthletePassport(ctx, input.athleteId);
    });
  }

  /** Follows resolution links to the canonical athlete id (historical references stay intact). */
  canonicalAthleteId(athleteId: string): Promise<string> {
    return this.tx(async (ctx) => {
      let current = athleteId;
      for (let i = 0; i < 16; i++) {
        const { rows } = await sql<{ canonical_athlete_id: string }>`
          SELECT canonical_athlete_id FROM identity.athlete_identity_resolution WHERE athlete_id = ${current}`.execute(
          ctx.trx,
        );
        if (rows[0] === undefined) return current;
        current = rows[0].canonical_athlete_id;
      }
      return current;
    });
  }

  // ───────────────────────────── external identities ─────────────────────────────

  /** A user-entered external identifier is CLAIMED — never confirmed by being entered. */
  async claimExternalIdentity(input: {
    actorAccountId: string;
    athleteId: string;
    namespace: string;
    issuerOrganizationId?: string;
    externalValue: string;
    visibility: AttributeVisibility;
    idempotencyKey: string;
  }): Promise<{ externalIdentityId: string; status: 'CLAIMED' }> {
    if (!/^[a-z0-9][a-z0-9:._-]{1,99}$/.test(input.namespace))
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid namespace');
    const value = assertText(input.externalValue, 200, 'externalValue');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ externalIdentityId: string; status: 'CLAIMED' }>(
        ctx,
        {
          command: 'ClaimExternalIdentity',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: {
            athleteId: input.athleteId,
            namespace: input.namespace,
            issuer: input.issuerOrganizationId,
            value,
            visibility: input.visibility,
          },
        },
      );
      if (idem.lookup.replay) return idem.lookup.response;
      const personId = await this.athletePerson(ctx, input.athleteId);
      await assertPersonOperation(ctx, input.actorAccountId, personId, 'CLAIM_EXTERNAL_IDENTITY');
      const id = newId();
      await sql`INSERT INTO identity.external_identity (id, athlete_id, issuer_organization_id, namespace, external_value, visibility, claimed_by_account_id, effective_from, recorded_at)
        VALUES (${id}, ${input.athleteId}, ${input.issuerOrganizationId ?? null}, ${input.namespace}, ${value}, ${input.visibility}, ${input.actorAccountId}, ${ctx.txTime}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO identity.external_identity_status_change (id, external_identity_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, 'CLAIMED', ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAthletePassport(ctx, input.athleteId);
      await emitEvent(ctx, {
        eventType: 'ExternalIdentityLinked',
        aggregateType: 'EXTERNAL_IDENTITY',
        aggregateId: id as Uuid,
        payload: { status: 'CLAIMED', namespace: input.namespace },
      });
      const response = { externalIdentityId: id, status: 'CLAIMED' as const };
      await idem.record(response);
      return response;
    });
  }

  /** Only the issuer organization (application permission ORG_CONFIRM_EXTERNAL_ID) may confirm. */
  confirmExternalIdentity(input: {
    actorAccountId: string;
    externalIdentityId: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `external-identity:${input.externalIdentityId}`);
      const { rows } = await sql<{
        athlete_id: string;
        issuer_organization_id: string | null;
        namespace: string;
        external_value: string;
      }>`
        SELECT athlete_id, issuer_organization_id, namespace, external_value FROM identity.external_identity WHERE id = ${input.externalIdentityId}`.execute(
        ctx.trx,
      );
      const e = rows[0];
      if (
        e === undefined ||
        e.issuer_organization_id === null ||
        !(await hasOrgPermission(
          ctx,
          input.actorAccountId,
          e.issuer_organization_id,
          'ORG_CONFIRM_EXTERNAL_ID',
        ))
      ) {
        throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      }
      await lockKeys(
        ctx,
        `external-identity-key:${e.namespace}:${e.issuer_organization_id}:${e.external_value}`,
      );
      const status = await currentStatus(
        ctx,
        'identity.v_external_identity_current',
        'external_identity_id',
        input.externalIdentityId,
      );
      if (status !== 'CLAIMED')
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          `cannot confirm a ${status ?? 'missing'} identity`,
        );
      const { rows: clash } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM identity.external_identity x JOIN identity.v_external_identity_current c ON c.external_identity_id = x.id
        WHERE x.namespace = ${e.namespace} AND x.issuer_organization_id = ${e.issuer_organization_id} AND x.external_value = ${e.external_value}
          AND c.status = 'CONFIRMED'`.execute(ctx.trx);
      if ((clash[0]?.n ?? 0) > 0)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this identifier is already confirmed for another athlete',
        );
      await sql`INSERT INTO identity.external_identity_status_change (id, external_identity_id, status, confirmed_by_organization_id, actor_account_id, recorded_at)
        VALUES (${newId()}, ${input.externalIdentityId}, 'CONFIRMED', ${e.issuer_organization_id}, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAthletePassport(ctx, e.athlete_id);
      await emitEvent(ctx, {
        eventType: 'ExternalIdentityConfirmed',
        aggregateType: 'EXTERNAL_IDENTITY',
        aggregateId: input.externalIdentityId as Uuid,
        payload: { status: 'CONFIRMED' },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'external-identity.confirmed',
        targetType: 'EXTERNAL_IDENTITY',
        targetId: input.externalIdentityId,
      });
    });
  }

  revokeExternalIdentity(input: {
    actorAccountId: string;
    externalIdentityId: string;
    reason: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `external-identity:${input.externalIdentityId}`);
      const { rows } = await sql<{ athlete_id: string; issuer_organization_id: string | null }>`
        SELECT athlete_id, issuer_organization_id FROM identity.external_identity WHERE id = ${input.externalIdentityId}`.execute(
        ctx.trx,
      );
      const e = rows[0];
      if (e === undefined) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      const personId = await this.athletePerson(ctx, e.athlete_id);
      const facts = await loadControlFacts(ctx, input.actorAccountId);
      const owner =
        facts.accountActive &&
        (facts.selfPersonId === personId || facts.activeDependentPersonIds.includes(personId));
      const issuer =
        e.issuer_organization_id !== null &&
        (await hasOrgPermission(
          ctx,
          input.actorAccountId,
          e.issuer_organization_id,
          'ORG_CONFIRM_EXTERNAL_ID',
        ));
      if (!owner && !issuer) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      if (
        (await currentStatus(
          ctx,
          'identity.v_external_identity_current',
          'external_identity_id',
          input.externalIdentityId,
        )) === 'REVOKED'
      )
        return;
      await sql`INSERT INTO identity.external_identity_status_change (id, external_identity_id, status, actor_account_id, reason, recorded_at)
        VALUES (${newId()}, ${input.externalIdentityId}, 'REVOKED', ${input.actorAccountId}, ${input.reason}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshAthletePassport(ctx, e.athlete_id);
      await emitEvent(ctx, {
        eventType: 'ExternalIdentityRevoked',
        aggregateType: 'EXTERNAL_IDENTITY',
        aggregateId: input.externalIdentityId as Uuid,
        payload: { status: 'REVOKED' },
      });
    });
  }

  // ───────────────────────────── wallets (proof of control) ─────────────────────────────

  /** Step 1: a single-use, expiring challenge bound to person, account, address, network, nonce, purpose and audience. */
  async prepareWalletLink(input: {
    actorAccountId: string;
    personId: string;
    network: string;
    address: string;
    visibility: AttributeVisibility;
    /** Defaults to the production EVM scheme. */
    proofScheme?: WalletProofScheme;
    idempotencyKey: string;
  }): Promise<WalletChallenge> {
    const proofScheme = input.proofScheme ?? 'eip191-personal-sign';
    const target = normalizeWalletTarget(proofScheme, input.network, input.address);
    if (!target.ok) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        target.reason === 'UNSUPPORTED_NETWORK'
          ? 'network is not supported by this proof scheme (BRT-04: eip155:<chainId> only)'
          : 'invalid EVM address',
      );
    }
    if (this.verifierFor(proofScheme, target.network) === undefined) {
      throw new DomainError(DomainErrorCode.INVALID_INPUT, 'proof scheme is not available');
    }
    const address = target.address;
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ challengeId: string }>(ctx, {
        command: 'PrepareWalletLink',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          personId: input.personId,
          network: input.network,
          address,
          visibility: input.visibility,
          proofScheme,
        },
      });
      if (idem.lookup.replay) return this.loadChallenge(ctx, idem.lookup.response.challengeId);
      await assertPersonOperation(ctx, input.actorAccountId, input.personId, 'LINK_WALLET');
      const challengeId = newId();
      const base = {
        challengeId,
        network: input.network,
        address,
        proofScheme,
        nonce: randomBytes(16).toString('hex'),
        purpose: 'wallet-link' as const,
        audience: this.audience,
        issuedAt: ctx.txTime,
        expiresAt: new Date(ctx.txTime.getTime() + this.challengeTtlMs),
      };
      const message = buildChallengeMessage(base);
      await sql`INSERT INTO identity.wallet_link_challenge (id, person_id, account_id, network, address, visibility, nonce, purpose, proof_scheme, audience, message, expires_at, recorded_at)
        VALUES (${challengeId}, ${input.personId}, ${input.actorAccountId}, ${input.network}, ${address}, ${input.visibility}, ${base.nonce},
                'wallet-link', ${proofScheme}, ${this.audience}, ${message}, ${base.expiresAt}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await idem.record({ challengeId });
      return { ...base, message };
    });
  }

  /** Dispatch by (network family, proof scheme) — never by address shape alone. */
  private verifierFor(scheme: WalletProofScheme, network: string): WalletProofVerifier | undefined {
    if (!schemeSupportsNetwork(scheme, network)) return undefined;
    return this.verifiers.find((v) => v.scheme === scheme && v.supports(network));
  }

  private async loadChallenge(
    ctx: TxContext,
    challengeId: string,
  ): Promise<
    WalletChallenge & { personId: string; accountId: string; visibility: AttributeVisibility }
  > {
    const { rows } = await sql<{
      id: string;
      person_id: string;
      account_id: string;
      network: string;
      address: string;
      visibility: AttributeVisibility;
      nonce: string;
      proof_scheme: WalletProofScheme;
      audience: string;
      message: string;
      expires_at: Date;
      recorded_at: Date;
    }>`
      SELECT id, person_id, account_id, network, address, visibility, nonce, proof_scheme, audience, message, expires_at, recorded_at
      FROM identity.wallet_link_challenge WHERE id = ${challengeId}`.execute(ctx.trx);
    const c = rows[0];
    if (c === undefined)
      throw new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge not found');
    return {
      challengeId: c.id,
      personId: c.person_id,
      accountId: c.account_id,
      visibility: c.visibility,
      network: c.network,
      address: c.address,
      nonce: c.nonce,
      proofScheme: c.proof_scheme,
      purpose: 'wallet-link',
      audience: c.audience,
      issuedAt: c.recorded_at,
      expiresAt: c.expires_at,
      message: c.message,
    };
  }

  /**
   * Step 2: verify the signature through a configured verifier. The challenge is consumed on the
   * first attempt (success or failure) — replays fail. Only then is a WalletLink created.
   */
  verifyWalletLink(input: {
    actorAccountId: string;
    challengeId: string;
    signature: string;
    idempotencyKey: string;
  }): Promise<{ walletLinkId: string; proofStatus: WalletProofStatus }> {
    return this.tx(
      async (
        ctx,
      ): Promise<{ walletLinkId: string; proofStatus: WalletProofStatus } | { rejected: true }> => {
        const idem = await identityIdempotency<{
          walletLinkId: string;
          proofStatus: WalletProofStatus;
        }>(ctx, {
          command: 'VerifyWalletLink',
          actorAccountId: input.actorAccountId,
          idempotencyKey: input.idempotencyKey,
          params: { challengeId: input.challengeId, signature: input.signature },
        });
        if (idem.lookup.replay) return idem.lookup.response;
        await lockKeys(ctx, `wallet-challenge:${input.challengeId}`);
        const challenge = await this.loadChallenge(ctx, input.challengeId);
        if (challenge.accountId !== input.actorAccountId)
          throw new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge not found');
        const { rows: consumed } = await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM identity.wallet_link_challenge_consumption WHERE challenge_id = ${input.challengeId}`.execute(
          ctx.trx,
        );
        if ((consumed[0]?.n ?? 0) > 0)
          throw new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge already used');
        if (ctx.txTime.getTime() >= challenge.expiresAt.getTime())
          throw new DomainError(DomainErrorCode.CHALLENGE_INVALID, 'challenge expired');
        // Exactly one verifier: the one for the challenge's persisted (network family, scheme).
        const verifier = this.verifierFor(challenge.proofScheme, challenge.network);
        if (verifier === undefined)
          throw new DomainError(DomainErrorCode.PROOF_INVALID, 'no verifier for this proof scheme');
        if (process.env.NODE_ENV === 'production' && verifier.kind !== 'PRODUCTION')
          throw new DomainError(
            DomainErrorCode.PROOF_INVALID,
            'test proofs are refused in production',
          );
        const ok = verifier.verify(challenge, input.signature);
        await sql`INSERT INTO identity.wallet_link_challenge_consumption (challenge_id, outcome, verifier_id, recorded_at)
        VALUES (${input.challengeId}, ${ok ? 'VERIFIED' : 'REJECTED'}, ${verifier.id}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        if (!ok) {
          await recordAudit(ctx, {
            actorAccountId: input.actorAccountId,
            action: 'wallet.proof-rejected',
            targetType: 'WALLET_CHALLENGE',
            targetId: input.challengeId,
            outcome: 'DENIED',
          });
          // The rejection (and consumption) must commit, so it is returned and thrown after commit.
          return { rejected: true as const };
        }
        const walletLinkId = newId();
        // VERIFIED only from a PRODUCTION verifier of a production scheme; the DB also enforces
        // (proof_scheme = 'test-signature') ⇔ (proof_status = 'TEST_VERIFIED').
        const proofStatus: WalletProofStatus =
          verifier.kind === 'PRODUCTION' && challenge.proofScheme !== 'test-signature'
            ? 'VERIFIED'
            : 'TEST_VERIFIED';
        await sql`INSERT INTO identity.wallet_link (id, person_id, network, address, challenge_id, verifier_id, proof_status, proof_scheme, proof_signature, visibility, recorded_at)
        VALUES (${walletLinkId}, ${challenge.personId}, ${challenge.network}, ${challenge.address}, ${challenge.challengeId}, ${verifier.id}, ${proofStatus}, ${challenge.proofScheme}, ${input.signature}, ${challenge.visibility}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        await sql`INSERT INTO identity.wallet_link_status_change (id, wallet_link_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${walletLinkId}, 'ACTIVE', ${input.actorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
        await this.refreshPersonPassports(ctx, challenge.personId);
        await emitEvent(ctx, {
          eventType: 'WalletLinkActivated',
          aggregateType: 'WALLET_LINK',
          aggregateId: walletLinkId as Uuid,
          payload: { proofStatus, network: challenge.network },
        });
        await recordAudit(ctx, {
          actorAccountId: input.actorAccountId,
          action: 'wallet.linked',
          targetType: 'WALLET_LINK',
          targetId: walletLinkId,
          details: { proofStatus },
        });
        const response = { walletLinkId, proofStatus };
        await idem.record(response);
        return response;
      },
    ).then((r) => {
      if ('rejected' in r)
        throw new DomainError(
          DomainErrorCode.PROOF_INVALID,
          'signature does not prove control of the address',
        );
      return r;
    });
  }

  revokeWalletLink(input: {
    actorAccountId: string;
    walletLinkId: string;
    reason: string;
  }): Promise<void> {
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `wallet-link:${input.walletLinkId}`);
      const { rows } = await sql<{
        person_id: string;
      }>`SELECT person_id FROM identity.wallet_link WHERE id = ${input.walletLinkId}`.execute(
        ctx.trx,
      );
      if (rows[0] === undefined) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
      await assertPersonOperation(ctx, input.actorAccountId, rows[0].person_id, 'LINK_WALLET');
      if (
        (await currentStatus(
          ctx,
          'identity.v_wallet_link_current',
          'wallet_link_id',
          input.walletLinkId,
        )) === 'REVOKED'
      )
        return;
      await sql`INSERT INTO identity.wallet_link_status_change (id, wallet_link_id, status, actor_account_id, reason, recorded_at)
        VALUES (${newId()}, ${input.walletLinkId}, 'REVOKED', ${input.actorAccountId}, ${input.reason}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await this.refreshPersonPassports(ctx, rows[0].person_id);
      await emitEvent(ctx, {
        eventType: 'WalletLinkRevoked',
        aggregateType: 'WALLET_LINK',
        aggregateId: input.walletLinkId as Uuid,
        payload: { status: 'REVOKED' },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'wallet.revoked',
        targetType: 'WALLET_LINK',
        targetId: input.walletLinkId,
      });
    });
  }

  /** Wallet status as seen by its controller (address alone never counts as proof). */
  walletLinkStatus(input: { actorAccountId: string; walletLinkId: string }) {
    return this.tx(async (ctx) => {
      const { rows } = await sql<{
        person_id: string;
        proof_status: WalletProofStatus;
        network: string;
        address: string;
      }>`
        SELECT person_id, proof_status, network, address FROM identity.wallet_link WHERE id = ${input.walletLinkId}`.execute(
        ctx.trx,
      );
      if (rows[0] === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'not found');
      await assertPersonOperation(ctx, input.actorAccountId, rows[0].person_id, 'LINK_WALLET');
      const status = await currentStatus(
        ctx,
        'identity.v_wallet_link_current',
        'wallet_link_id',
        input.walletLinkId,
      );
      return { ...rows[0], status };
    });
  }
}
