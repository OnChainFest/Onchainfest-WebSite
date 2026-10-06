import { loadAccountState } from '../platform';
import { APP_HOME, resolvePostAuthDestination } from './onboarding';

/**
 * Where to go right after a session is established (sign-in, email verification). The decision is
 * made from platform rows fetched with the new access token; if the platform is unreachable the
 * user lands on /app, whose shell shows the real (fail-closed) unavailable state.
 */
export async function postAuthDestination(
  accessToken: string,
  input: { requested?: unknown; hint?: unknown; notice?: string },
): Promise<string> {
  const state = await loadAccountState(accessToken);
  const destination =
    state.kind === 'ok'
      ? resolvePostAuthDestination({
          facts: state.state.facts,
          requested: input.requested,
          hint: input.hint,
        })
      : APP_HOME;
  if (input.notice === undefined) return destination;
  return `${destination}${destination.includes('?') ? '&' : '?'}notice=${input.notice}`;
}
