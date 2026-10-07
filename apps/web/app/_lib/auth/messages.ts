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
  not_permitted: 'Your role in this organization doesn’t allow that.',
  athlete_not_found: 'No public athlete profile has that address.',
  already_member: 'That person already has this role or a pending invitation.',
  last_owner: 'An organization must keep at least one active owner.',
  invalid_change: 'That change isn’t possible from the member’s current status.',
  invitation_invalid:
    'This invitation isn’t valid — it may be used, revoked, expired or meant for someone else.',
  tournament_address_taken: 'That tournament address is already in use. Try another.',
  tournament_transition: 'That step isn’t available in the current state. The page shows what is.',
  tournament_invalid:
    'Check the details: dates must be in order, and category dates must fall within the tournament’s.',
  tournament_not_found: 'That tournament or category no longer exists.',
  catalog_combination:
    'That sport, format and entrant combination can’t run. Pick from the options shown.',
  reason_required: 'Give a short reason. Participants and staff will see it.',
  registration_duplicate:
    'This athlete is already entered in this category. Your existing entry is below.',
  registration_closed:
    'Registration isn’t open for this category right now — it may not have opened yet or has closed.',
  registration_full: 'This category is full. No place is available right now.',
  registration_invalid:
    'This entry can’t be made: confirm eligibility, and check the entrant fits this category (an athlete for individual categories, a team with enough active members for team categories).',
  registration_not_permitted: 'You can only register athletes you manage.',
  registration_not_found: 'That registration doesn’t exist or isn’t yours to see.',
  registration_transition:
    'That entry has already changed. The page now shows its current status and options.',
  eligibility_required: 'Confirm that the athlete meets this category’s requirements.',
  field_incomplete:
    'The field can’t be locked yet: a team is outside the allowed roster size, or an entry is missing a required value. Resolve those entries first.',
  seeding_invalid:
    'Check the seeding: seed numbers run 1, 2, 3… without gaps, and every override names an entrant, a position and a reason.',
  plan_invalid:
    'The structure can’t be generated for this field with the category’s format settings. Check the format settings and the number of entrants.',
  structure_done:
    'That step is already done — the field, seeding and structure are set once and kept.',
  team_invalid: 'Give the team a name and choose pair or squad.',
  team_member_invalid:
    'That athlete can’t be added to this team — they may already be on it or their profile isn’t active.',
  attribute_invalid: 'Check the values: use the format shown for each field.',
  attributes_frozen: 'Entry values are frozen once the organizer locks the field.',
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
  profile_saved: 'Profile saved. Your public page is updated.',
  address_changed: 'Page address changed. The old address keeps redirecting.',
  role_changed: 'Role updated.',
  member_suspended: 'Member suspended.',
  member_reactivated: 'Member reactivated.',
  member_removed: 'Member removed.',
  invitation_revoked: 'Invitation revoked.',
  joined: 'You’ve joined the organization.',
  invitation_declined: 'Invitation declined.',
  left_organization: 'You’ve left the organization.',
  tournament_created: 'Tournament created as a draft. Add its categories next.',
  tournament_updated: 'Tournament details saved.',
  published: 'Tournament published. It now appears on your public page.',
  tournament_started: 'Tournament is live.',
  tournament_completed: 'Tournament marked completed.',
  tournament_cancelled: 'Tournament cancelled.',
  category_added: 'Category added.',
  category_updated: 'Category saved.',
  registration_opened: 'Registration is open.',
  registration_closed: 'Registration is closed.',
  category_cancelled: 'Category cancelled.',
  registration_received: 'Entry received. Here’s where it stands.',
  registration_withdrawn: 'Entry withdrawn.',
  registration_confirmed: 'Registration confirmed.',
  registration_waitlisted: 'Registration moved to the waitlist.',
  registration_declined: 'Registration declined.',
  registration_cancelled: 'Registration cancelled.',
  field_locked: 'Field locked. The entrants, rosters and declared values are now fixed.',
  field_seeded: 'Field seeded. Preview the structure, then generate it.',
  plan_generated: 'Structure generated. It’s now on the public category page.',
  team_created: 'Team created. Invite its members next.',
  member_invited: 'Invitation sent. The athlete accepts it from their Teams page.',
  membership_accepted: 'You’ve joined the team.',
  membership_declined: 'Invitation declined.',
  attributes_saved: 'Entry details saved.',
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
