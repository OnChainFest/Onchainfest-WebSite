import { DomainError } from '@br/domain';
import { apiDatabaseUrl } from '../config';
import { createDb } from '../db';
import { ResultAuthorityGovernance } from '../result-authority';

/**
 * LAUNCH-02 · ADR-0077 operator command for competition result authority. It is an OPERATOR act
 * under a recorded governance decision. There is no HTTP equivalent, and the
 * check-no-manual-authority guard keeps it that way.
 *
 *   pnpm authority:results bootstrap-anchor --governance-ref <ref> --basis-ref <ref>
 *   pnpm authority:results grant  --platform-principal <uuid> --competition <uuid> --account <uuid>
 *                                 --governance-ref <ref> [--effective-to <ISO instant>]
 *   pnpm authority:results revoke --platform-principal <uuid> --competition <uuid> --account <uuid>
 *                                 --governance-ref <ref> --reason <text>
 *   pnpm authority:results list   --competition <uuid>
 *
 * `--platform-principal` may come from BR_PLATFORM_PRINCIPAL_ID. The command uses the API login
 * (BR_API_DATABASE_URL in production) and gains no privilege the API process lacks. References are
 * governance identifiers, never personal data. Output is JSON, ids only.
 * Exit codes: 0 ok, 1 usage or configuration, 3 refused (the error code and reason are printed).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USAGE =
  'usage: authority:results <bootstrap-anchor|grant|revoke|list> [--governance-ref r] [--basis-ref r] ' +
  '[--platform-principal uuid] [--competition uuid] [--account uuid] [--effective-to iso] [--reason text]';

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i];
  const value = rest[i + 1];
  if (key === undefined || !key.startsWith('--') || value === undefined) {
    console.error(USAGE);
    process.exit(1);
  }
  flags.set(key.slice(2), value);
}
function need(name: string, pattern?: RegExp, fallback?: string): string {
  const value = flags.get(name) ?? fallback;
  if (value === undefined || value === '' || (pattern !== undefined && !pattern.test(value))) {
    console.error(`missing or invalid --${name}\n${USAGE}`);
    process.exit(1);
  }
  return value;
}

const db = createDb(apiDatabaseUrl(), { max: 2 });
const governance = new ResultAuthorityGovernance(db);
try {
  let out: unknown;
  switch (command) {
    case 'bootstrap-anchor':
      out = await governance.bootstrapPlatformAnchor({
        governanceDecisionRef: need('governance-ref'),
        basisRef: need('basis-ref'),
      });
      break;
    case 'grant': {
      const effectiveTo = flags.get('effective-to');
      const until = effectiveTo === undefined ? undefined : new Date(effectiveTo);
      if (until !== undefined && Number.isNaN(until.getTime())) {
        console.error(`invalid --effective-to\n${USAGE}`);
        process.exit(1);
      }
      out = await governance.grantCompetitionResultAuthority({
        platformPrincipalId: need('platform-principal', UUID, process.env.BR_PLATFORM_PRINCIPAL_ID),
        competitionId: need('competition', UUID),
        granteeAccountId: need('account', UUID),
        governanceDecisionRef: need('governance-ref'),
        ...(until === undefined ? {} : { effectiveTo: until }),
      });
      break;
    }
    case 'revoke':
      out = await governance.revokeCompetitionResultAuthority({
        platformPrincipalId: need('platform-principal', UUID, process.env.BR_PLATFORM_PRINCIPAL_ID),
        competitionId: need('competition', UUID),
        granteeAccountId: need('account', UUID),
        governanceDecisionRef: need('governance-ref'),
        reason: need('reason'),
      });
      break;
    case 'list':
      out = await governance.listCompetitionResultAuthority(need('competition', UUID));
      break;
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
  if (out !== undefined) console.log(JSON.stringify(out, null, 2));
} catch (err) {
  if (!(err instanceof DomainError)) throw err;
  console.error(
    JSON.stringify({ refused: err.code, reason: err.details.reason, message: err.message }),
  );
  process.exitCode = 3;
} finally {
  await db.destroy();
}
