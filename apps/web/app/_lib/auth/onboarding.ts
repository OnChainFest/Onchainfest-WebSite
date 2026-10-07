/**
 * Data-derived onboarding (PMFreak pattern, ADR-0052). The state is computed from platform rows —
 * the caller's own person, athletes and organization memberships — never from a "completed" flag
 * and never from Supabase user metadata. A sign-up choice ("athlete" / "organization") is carried
 * only as a UI hint that pre-selects the onboarding path; it grants nothing.
 */
import { validateContinuationRoute } from './continuation';

export interface OnboardingFacts {
  /** `GET /v1/me` → selfPersonId */
  readonly selfPersonId: string | null;
  /** `GET /v1/me` → athletes.length (own and dependent athletes) */
  readonly athleteCount: number;
  /** Active organization memberships of the account (source: platform API). */
  readonly membershipCount: number;
}

export type OnboardingState = 'needs_person' | 'needs_role' | 'active';
export type OnboardingHint = 'athlete' | 'organization';

export const APP_HOME = '/app';
export const ONBOARDING_PATH = '/app/onboarding';

export function resolveOnboardingState(facts: OnboardingFacts): OnboardingState {
  if (facts.selfPersonId === null) return 'needs_person';
  if (facts.athleteCount === 0 && facts.membershipCount === 0) return 'needs_role';
  return 'active';
}

export function parseOnboardingHint(value: unknown): OnboardingHint | null {
  return value === 'athlete' || value === 'organization' ? value : null;
}

/**
 * The onboarding URL, optionally pre-selecting a path and carrying a validated continuation that
 * onboarding resumes once the profile exists (ONCF-04: back to the registration that was started).
 */
export function onboardingPath(hint: OnboardingHint | null, next: string | null): string {
  const q = new URLSearchParams();
  if (hint !== null) q.set('path', hint);
  if (next !== null) q.set('next', next);
  const s = q.toString();
  return s === '' ? ONBOARDING_PATH : `${ONBOARDING_PATH}?${s}`;
}

/**
 * Where to send a user after authentication. Unfinished onboarding always wins over a requested
 * continuation (which onboarding then carries along); a continuation is honoured only if it passes
 * validateContinuationRoute.
 */
export function resolvePostAuthDestination(input: {
  readonly facts: OnboardingFacts;
  readonly requested?: unknown;
  readonly hint?: unknown;
}): string {
  const next = validateContinuationRoute(input.requested);
  if (resolveOnboardingState(input.facts) !== 'active')
    return onboardingPath(parseOnboardingHint(input.hint), next);
  return next ?? APP_HOME;
}
