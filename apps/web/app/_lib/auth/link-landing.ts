import { NextResponse } from 'next/server';
import { validateContinuationRoute } from './continuation';
import { authErrorCode, type AuthErrorCode } from './messages';
import { parseOnboardingHint } from './onboarding';
import { postAuthDestination } from './post-auth';

/**
 * Shared landing logic for email links (/auth/callback with a PKCE code, /auth/confirm with a
 * token hash). Recovery links go only to /reset-password; every other link goes to the
 * data-derived post-auth destination. Errors become fixed codes on the right screen.
 */
export type LinkFlow = 'recovery' | 'signup' | 'other';

export function linkFlow(value: string | null): LinkFlow {
  return value === 'recovery' || value === 'signup' ? value : 'other';
}

export function failureRedirect(request: Request, flow: LinkFlow, code: AuthErrorCode) {
  const path = flow === 'recovery' ? '/forgot-password' : '/signin';
  return NextResponse.redirect(new URL(`${path}?error=${code}`, request.url), 303);
}

/** Supabase reports link failures as query parameters on the redirect target. */
export function providerFailure(url: URL): AuthErrorCode | null {
  const errorCode = url.searchParams.get('error_code');
  const error = url.searchParams.get('error');
  if (errorCode === null && error === null) return null;
  const mapped = authErrorCode({ code: errorCode });
  return mapped === 'link_expired' || mapped === 'link_other_browser' ? mapped : 'link_invalid';
}

export async function successRedirect(
  request: Request,
  url: URL,
  flow: LinkFlow,
  accessToken: string,
) {
  if (flow === 'recovery') {
    return NextResponse.redirect(new URL('/reset-password', request.url), 303);
  }
  const destination = await postAuthDestination(accessToken, {
    requested: validateContinuationRoute(url.searchParams.get('next')),
    hint: parseOnboardingHint(url.searchParams.get('path')),
    ...(flow === 'signup' ? { notice: 'email_verified' } : {}),
  });
  return NextResponse.redirect(new URL(destination, request.url), 303);
}

export function linkErrorCode(err: unknown): AuthErrorCode {
  const code = authErrorCode(err);
  return code === 'unknown' ? 'link_invalid' : code;
}
