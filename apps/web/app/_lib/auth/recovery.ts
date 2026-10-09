/**
 * A password reset is allowed only inside a verified recovery session (ONCF-01): the session's
 * JWT claims (verified with getClaims) must carry an `amr` entry `recovery` that is recent.
 * An ordinary signed-in session can never change the password through the reset screen.
 */
export const RECOVERY_WINDOW_SECONDS = 60 * 60;

export function isRecoverySession(claims: unknown, nowSeconds: number): boolean {
  if (typeof claims !== 'object' || claims === null) return false;
  const c = claims as { role?: unknown; is_anonymous?: unknown; amr?: unknown };
  if (c.role !== 'authenticated' || c.is_anonymous === true || !Array.isArray(c.amr)) return false;
  return (c.amr as unknown[]).some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    return (
      method === 'recovery' &&
      typeof timestamp === 'number' &&
      timestamp <= nowSeconds + 60 &&
      nowSeconds - timestamp <= RECOVERY_WINDOW_SECONDS
    );
  });
}
