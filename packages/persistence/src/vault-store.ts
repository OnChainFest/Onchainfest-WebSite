import { DomainError, DomainErrorCode } from '@br/domain';
import type { EncryptedEnvelope, PiiCipher } from '@br/identity';
import { sql } from 'kysely';
import type { Db } from './db';
import { recordAudit } from './identity-support';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/** Private person attributes. Never leave the vault except to an authorized SELF caller. */
export interface PersonPrivateData {
  readonly legalName?: string | null;
  readonly dateOfBirth?: string | null; // YYYY-MM-DD
  readonly email?: string | null;
  readonly phone?: string | null;
}

const FIELDS = [
  ['legalName', 'legal_name_enc'],
  ['dateOfBirth', 'date_of_birth_enc'],
  ['email', 'email_enc'],
  ['phone', 'phone_enc'],
] as const;

type Column = (typeof FIELDS)[number][1];

const isPresent = (v: string | null | undefined): v is string => v !== null && v !== undefined;

function validate(data: PersonPrivateData): void {
  const bad = (what: string) =>
    new DomainError(DomainErrorCode.INVALID_INPUT, `${what} is invalid`);
  if (
    isPresent(data.legalName) &&
    (data.legalName.trim().length === 0 || data.legalName.length > 200)
  )
    throw bad('legalName');
  if (isPresent(data.dateOfBirth)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.dateOfBirth);
    const d = m === null ? undefined : new Date(`${data.dateOfBirth}T00:00:00Z`);
    if (
      d === undefined ||
      Number.isNaN(d.getTime()) ||
      d.toISOString().slice(0, 10) !== data.dateOfBirth
    )
      throw bad('dateOfBirth');
  }
  if (
    isPresent(data.email) &&
    (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(data.email) || data.email.length > 254)
  )
    throw bad('email');
  if (isPresent(data.phone) && !/^\+[1-9][0-9]{6,14}$/.test(data.phone)) throw bad('phone');
}

/**
 * PII vault repository. Uses ONLY the `br_api_vault` login, which can assume nothing but
 * `br_identity_private`; the API/public read paths can never reach `identity_private`.
 *
 * Authorization is evaluated INSIDE each vault transaction by the SECURITY DEFINER function
 * `identity_private.authorize_private_data(account, person)` (migration 0004): SELF control by an
 * ACTIVE account, under shared advisory locks that identity revocations take exclusively. There is
 * therefore no check-then-use window: an operation either completes before a revocation commits or
 * observes it. Guardians never access private data. The vault role still has no identity grants.
 *
 * Not atomic with person creation (different logins): callers create the person first, then
 * write private data; the write is an idempotent upsert, so a retry converges.
 */
export class PersonPrivateDataService {
  private readonly vaultDb: Db;
  private readonly cipher: PiiCipher;

  constructor(vaultDb: Db, cipher: PiiCipher) {
    this.vaultDb = vaultDb;
    this.cipher = cipher;
  }

  /**
   * Runs `fn` in one vault transaction after an in-transaction authorization. A denial is audited
   * (DENIED) and committed, then surfaced as FORBIDDEN with no detail.
   */
  private async guarded<T>(
    actorAccountId: string,
    personId: string,
    action: 'vault.read' | 'vault.write' | 'vault.erase',
    fn: (ctx: TxContext) => Promise<T>,
  ): Promise<T> {
    const r = await inTransaction(
      this.vaultDb,
      ModuleRole.identityPrivate,
      async (ctx): Promise<{ ok: true; value: T } | { ok: false }> => {
        const { rows } = await sql<{ allowed: boolean }>`
          SELECT identity_private.authorize_private_data(${actorAccountId}::uuid, ${personId}::uuid) AS allowed`.execute(
          ctx.trx,
        );
        if (rows[0]?.allowed !== true) {
          await recordAudit(ctx, {
            actorAccountId,
            action,
            targetType: 'PERSON',
            targetId: personId,
            outcome: 'DENIED',
          });
          return { ok: false };
        }
        return { ok: true, value: await fn(ctx) };
      },
    );
    if (!r.ok) throw new DomainError(DomainErrorCode.FORBIDDEN, 'not permitted');
    return r.value;
  }

  /** Upsert (fields left undefined are unchanged; null clears). */
  async write(input: {
    actorAccountId: string;
    personId: string;
    data: PersonPrivateData;
  }): Promise<{ fields: string[] }> {
    validate(input.data);
    const changed = FIELDS.filter(([k]) => input.data[k] !== undefined);
    return this.guarded(input.actorAccountId, input.personId, 'vault.write', async (ctx) => {
      const enc = (field: string, v: string | null | undefined) =>
        !isPresent(v) ? null : JSON.stringify(this.cipher.encrypt(field, v.trim()));
      const values: Record<Column, string | null> = {
        legal_name_enc: enc('legalName', input.data.legalName),
        date_of_birth_enc: enc('dateOfBirth', input.data.dateOfBirth),
        email_enc: enc('email', input.data.email?.toLowerCase()),
        phone_enc: enc('phone', input.data.phone),
      };
      const keep = (col: Column, key: keyof PersonPrivateData) =>
        input.data[key] === undefined
          ? sql.ref(`person_private.${col}`)
          : sql`${values[col]}::jsonb`;
      await sql`INSERT INTO identity_private.person_private AS person_private
          (person_id, legal_name_enc, date_of_birth_enc, email_enc, phone_enc, cipher_key_id, erased_at, updated_at)
        VALUES (${input.personId}, ${values.legal_name_enc}::jsonb, ${values.date_of_birth_enc}::jsonb, ${values.email_enc}::jsonb,
                ${values.phone_enc}::jsonb, ${this.cipher.keyId}, NULL, ${ctx.txTime})
        ON CONFLICT (person_id) DO UPDATE SET
          legal_name_enc = ${keep('legal_name_enc', 'legalName')},
          date_of_birth_enc = ${keep('date_of_birth_enc', 'dateOfBirth')},
          email_enc = ${keep('email_enc', 'email')},
          phone_enc = ${keep('phone_enc', 'phone')},
          cipher_key_id = EXCLUDED.cipher_key_id, erased_at = NULL, updated_at = EXCLUDED.updated_at`.execute(
        ctx.trx,
      );
      const fields = changed.map(([k]) => k);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'vault.write',
        targetType: 'PERSON',
        targetId: input.personId,
        details: { fields },
      });
      return { fields };
    });
  }

  async read(input: {
    actorAccountId: string;
    personId: string;
  }): Promise<PersonPrivateData & { erased: boolean }> {
    return this.guarded(input.actorAccountId, input.personId, 'vault.read', async (ctx) => {
      const { rows } = await sql<
        Record<Column, EncryptedEnvelope | null> & { erased_at: Date | null }
      >`
        SELECT legal_name_enc, date_of_birth_enc, email_enc, phone_enc, erased_at
        FROM identity_private.person_private WHERE person_id = ${input.personId}`.execute(ctx.trx);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'vault.read',
        targetType: 'PERSON',
        targetId: input.personId,
      });
      const row = rows[0];
      if (row === undefined) return { erased: false };
      const dec = (field: string, env: EncryptedEnvelope | null) => {
        if (env === null) return null;
        try {
          return this.cipher.decrypt(field, env);
        } catch {
          throw new DomainError(
            DomainErrorCode.PRIVATE_DATA_UNAVAILABLE,
            'private data cannot be decrypted with the configured key',
          );
        }
      };
      return {
        legalName: dec('legalName', row.legal_name_enc),
        dateOfBirth: dec('dateOfBirth', row.date_of_birth_enc),
        email: dec('email', row.email_enc),
        phone: dec('phone', row.phone_enc),
        erased: row.erased_at !== null,
      };
    });
  }

  /** Erasure: removes every private attribute (the person's public sporting history is untouched). */
  async erase(input: { actorAccountId: string; personId: string }): Promise<void> {
    await this.guarded(input.actorAccountId, input.personId, 'vault.erase', async (ctx) => {
      await sql`INSERT INTO identity_private.person_private (person_id, cipher_key_id, erased_at, updated_at)
        VALUES (${input.personId}, ${this.cipher.keyId}, ${ctx.txTime}, ${ctx.txTime})
        ON CONFLICT (person_id) DO UPDATE SET legal_name_enc = NULL, date_of_birth_enc = NULL, email_enc = NULL, phone_enc = NULL,
          erased_at = EXCLUDED.erased_at, updated_at = EXCLUDED.updated_at`.execute(ctx.trx);
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'vault.erase',
        targetType: 'PERSON',
        targetId: input.personId,
      });
    });
  }
}
