/**
 * Development only: prints a dev bearer token for a test-provider subject.
 *   BR_DEV_AUTH=1 BR_DEV_AUTH_SECRET=<same secret as the API> pnpm --filter @br/api dev-token <subject> [--operator]
 * Refuses production, and refuses to run unless development auth is explicitly configured.
 */
import { mintDevToken } from './auth';

const [subject, ...flags] = process.argv.slice(2);
if (subject === undefined) {
  console.error('usage: dev-token <subject> [--operator]');
  process.exit(2);
}
if (process.env.BR_DEV_AUTH !== '1') {
  console.error(
    'dev-token: development auth is not enabled (set BR_DEV_AUTH=1 and BR_DEV_AUTH_SECRET)',
  );
  process.exit(2);
}
try {
  console.log(mintDevToken(subject, { operator: flags.includes('--operator') }));
} catch (err) {
  console.error(`dev-token: ${(err as Error).message}`);
  process.exit(2);
}
