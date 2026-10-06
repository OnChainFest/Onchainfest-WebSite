import { cache } from 'react';
import { resolveOnboardingState, type OnboardingState } from './auth/onboarding';
import { verifiedSession, type VerifiedSession } from './auth/session';
import { loadAccountState, type AccountState } from './platform';

/**
 * Per-request context for the authenticated app (ONCF-01). Fails closed: the app renders its
 * content only when Supabase verifies the session AND the platform API accepts the token.
 */
export type AppContext =
  | {
      kind: 'ok';
      session: VerifiedSession;
      account: AccountState;
      onboarding: OnboardingState;
    }
  | { kind: 'signed_out' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

export const appContext = cache(async (): Promise<AppContext> => {
  const session = await verifiedSession();
  if (session === null) return { kind: 'signed_out' };
  const result = await loadAccountState(session.accessToken);
  if (result.kind === 'unauthenticated') return { kind: 'rejected' };
  if (result.kind === 'unavailable') return { kind: 'unavailable' };
  if (!result.state.me.accountActive) return { kind: 'rejected' };
  return {
    kind: 'ok',
    session,
    account: result.state,
    onboarding: resolveOnboardingState(result.state.facts),
  };
});
