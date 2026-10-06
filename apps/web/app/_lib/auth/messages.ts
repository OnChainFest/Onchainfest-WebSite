/**
 * Fixed auth vocabulary (ONCF-01). Screens receive only these codes in `?error=` / `?notice=`;
 * raw provider messages are never reflected to the page (no account enumeration, no injection).
 */
export const ERROR_MESSAGES = {
  invalid_credentials: 'That email and password don’t match an account.',
  email_not_confirmed: 'Confirm your email first. We can send the link again.',
  email_taken: 'An account already exists for this email. Sign in or reset your password.',
  weak_password: 'Use at least 8 characters, mixing letters and numbers.',
  password_mismatch: 'The two passwords don’t match.',
  same_password: 'Choose a password you haven’t used for this account.',
  missing_fields: 'Fill in every required field.',
  invalid_email: 'Enter a valid email address.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  link_expired: 'That link has expired. Request a new one.',
  link_invalid: 'That link isn’t valid anymore. Request a new one.',
  link_other_browser: 'Open the link in the browser where you started, or sign in to continue.',
  reset_session_invalid: 'This reset session isn’t valid. Request a new reset link.',
  session_expired: 'Your session ended. Sign in again.',
  network: 'We couldn’t reach the sign-in service. Check your connection and retry.',
  not_configured: 'Sign-in isn’t available right now. Try again shortly.',
  profile_address_taken: 'That profile address is taken. Try another.',
  profile_address_invalid: 'Use 3–50 lowercase letters, numbers and single hyphens.',
  profile_invalid: 'Check the highlighted details and try again.',
  platform_unavailable: 'OnChainFest is temporarily unavailable. Your progress is safe — retry.',
  not_permitted: 'Your account can’t do that yet.',
  unknown: 'Something went wrong. Try again.',
} as const;

export const NOTICE_MESSAGES = {
  signed_out: 'You’re signed out.',
  password_updated: 'Password updated. Sign in with your new password.',
  reset_sent: 'If an account exists for that email, a reset link is on its way.',
  confirmation_sent: 'Confirmation email sent. Check your inbox.',
  email_verified: 'Email verified. Let’s set up your profile.',
  athlete_created: 'Your athlete profile is live.',
  organization_created: 'Your organization is set up. You’re its owner.',
} as const;

export type AuthErrorCode = keyof typeof ERROR_MESSAGES;
export type AuthNoticeCode = keyof typeof NOTICE_MESSAGES;

export function errorMessage(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code as AuthErrorCode]
    : null;
}

export function noticeMessage(code: unknown): string | null {
  return typeof code === 'string' && Object.hasOwn(NOTICE_MESSAGES, code)
    ? NOTICE_MESSAGES[code as AuthNoticeCode]
    : null;
}

/** Maps a Supabase AuthError (or any thrown value) to the fixed vocabulary. */
export function authErrorCode(err: unknown): AuthErrorCode {
  if (typeof err !== 'object' || err === null) return 'unknown';
  const e = err as { code?: unknown; name?: unknown; status?: unknown };
  if (e.name === 'AuthRetryableFetchError' || e.name === 'TypeError') return 'network';
  switch (e.code) {
    case 'invalid_credentials':
      return 'invalid_credentials';
    case 'email_not_confirmed':
      return 'email_not_confirmed';
    case 'user_already_exists':
    case 'email_exists':
      return 'email_taken';
    case 'weak_password':
      return 'weak_password';
    case 'same_password':
      return 'same_password';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'invalid_email';
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'rate_limited';
    case 'otp_expired':
    case 'flow_state_expired':
      return 'link_expired';
    case 'bad_code_verifier':
    case 'flow_state_not_found':
      return 'link_other_browser';
    case 'session_not_found':
    case 'session_expired':
    case 'refresh_token_not_found':
      return 'session_expired';
    default:
      return e.status === 429 ? 'rate_limited' : 'unknown';
  }
}
