'use server';

import { redirect } from 'next/navigation';
import { validateContinuationRoute } from './continuation';
import { authErrorCode, type AuthErrorCode } from './messages';
import { parseOnboardingHint } from './onboarding';
import { postAuthDestination } from './post-auth';
import { authRateLimiter, RATE_RULES } from './rate-limit';
import { isRecoverySession } from './recovery';
import { clientIp, emailKey, siteUrl } from './request-meta';
import { createSupabaseServerClient } from './supabase-server';

/**
 * Auth server actions (ONCF-01, ADR-0052). Supabase proves identity; nothing here writes account
 * type, role or organization data to Supabase metadata. Platform rows are created later through the
 * platform API (onboarding). Errors are mapped to a fixed vocabulary before reaching the URL.
 */

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 8;

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

function query(path: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) q.set(k, v);
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

function passwordProblem(password: string): AuthErrorCode | null {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) return 'weak_password';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'weak_password';
  return null;
}

export async function signInAction(form: FormData): Promise<never> {
  const email = field(form, 'email').trim();
  const password = field(form, 'password');
  const next = validateContinuationRoute(field(form, 'next'));
  const back = (error: AuthErrorCode) => redirect(query('/signin', { error, next }));

  if (email === '' || password === '') back('missing_fields');
  const ip = await clientIp();
  if (
    !authRateLimiter.attempt(`signin:ip:${ip}`, RATE_RULES.signinIp) ||
    !authRateLimiter.attempt(`signin:${ip}:${emailKey(email)}`, RATE_RULES.signin)
  )
    back('rate_limited');

  const supabase = await createSupabaseServerClient();
  if (supabase === null) back('not_configured');
  let token: string;
  try {
    const { data, error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error !== null) back(authErrorCode(error));
    if (data.session === null) back('unknown');
    token = data.session!.access_token;
  } catch (err) {
    if (isRedirect(err)) throw err;
    back(authErrorCode(err));
  }
  authRateLimiter.reset(`signin:${ip}:${emailKey(email)}`);
  redirect(await postAuthDestination(token!, { requested: next }));
}

export async function signUpAction(form: FormData): Promise<never> {
  const email = field(form, 'email').trim();
  const password = field(form, 'password');
  const hint = parseOnboardingHint(field(form, 'path'));
  const back = (error: AuthErrorCode) => redirect(query('/signup', { path: hint, error }));

  if (email === '' || password === '') back('missing_fields');
  if (!EMAIL_RE.test(email)) back('invalid_email');
  const weak = passwordProblem(password);
  if (weak !== null) back(weak);
  if (!authRateLimiter.attempt(`signup:${await clientIp()}`, RATE_RULES.signup))
    back('rate_limited');

  const base = siteUrl();
  const supabase = await createSupabaseServerClient();
  if (supabase === null || base === null) back('not_configured');
  // The lane choice travels only as a UI hint in the confirmation link — never as metadata.
  const emailRedirectTo = `${base}${query('/auth/callback', { flow: 'signup', path: hint })}`;
  let token: string | null = null;
  try {
    const { data, error } = await supabase!.auth.signUp({
      email,
      password,
      options: { emailRedirectTo },
    });
    if (error !== null) back(authErrorCode(error));
    token = data.session?.access_token ?? null;
  } catch (err) {
    if (isRedirect(err)) throw err;
    back(authErrorCode(err));
  }
  // Email confirmation on (the production setting) ⇒ no session yet. Supabase also answers this way
  // for an already-registered address, so the screen never reveals whether an account exists.
  if (token === null) redirect(query('/signup/confirm-email', { path: hint }));
  redirect(await postAuthDestination(token, { hint }));
}

export async function resendConfirmationAction(form: FormData): Promise<never> {
  const email = field(form, 'email').trim();
  const hint = parseOnboardingHint(field(form, 'path'));
  const back = (params: Record<string, string>) =>
    redirect(query('/signup/confirm-email', { path: hint, ...params }));
  if (!EMAIL_RE.test(email)) back({ error: 'invalid_email' });
  if (
    !authRateLimiter.attempt(`email:${emailKey(email)}`, RATE_RULES.email) ||
    !authRateLimiter.attempt(`email-ip:${await clientIp()}`, RATE_RULES.signup)
  )
    back({ error: 'rate_limited' });
  const base = siteUrl();
  const supabase = await createSupabaseServerClient();
  if (supabase === null || base === null) back({ error: 'not_configured' });
  try {
    const { error } = await supabase!.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${base}${query('/auth/callback', { flow: 'signup', path: hint })}`,
      },
    });
    if (error !== null && authErrorCode(error) !== 'unknown') back({ error: authErrorCode(error) });
  } catch (err) {
    if (isRedirect(err)) throw err;
    back({ error: authErrorCode(err) });
  }
  back({ notice: 'confirmation_sent' });
  throw new Error('unreachable');
}

export async function forgotPasswordAction(form: FormData): Promise<never> {
  const email = field(form, 'email').trim();
  const back = (params: Record<string, string>) => redirect(query('/forgot-password', params));
  if (!EMAIL_RE.test(email)) back({ error: 'invalid_email' });
  if (
    !authRateLimiter.attempt(`email:${emailKey(email)}`, RATE_RULES.email) ||
    !authRateLimiter.attempt(`email-ip:${await clientIp()}`, RATE_RULES.signup)
  )
    back({ error: 'rate_limited' });
  const base = siteUrl();
  const supabase = await createSupabaseServerClient();
  if (supabase === null || base === null) back({ error: 'not_configured' });
  try {
    const { error } = await supabase!.auth.resetPasswordForEmail(email, {
      redirectTo: `${base}/auth/callback?flow=recovery`,
    });
    // Only transport/rate failures are surfaced; "no such user" is never revealed.
    const code = error === null ? null : authErrorCode(error);
    if (code === 'network' || code === 'rate_limited') back({ error: code });
  } catch (err) {
    if (isRedirect(err)) throw err;
    back({ error: authErrorCode(err) });
  }
  back({ notice: 'reset_sent' });
  throw new Error('unreachable');
}

export async function resetPasswordAction(form: FormData): Promise<never> {
  const password = field(form, 'password');
  const confirm = field(form, 'confirm');
  const back = (error: AuthErrorCode) => redirect(query('/reset-password', { error }));
  const supabase = await createSupabaseServerClient();
  if (supabase === null) back('not_configured');
  // Re-verify the recovery session on submit; the page check alone is not trusted.
  let claims: unknown;
  try {
    const { data, error } = await supabase!.auth.getClaims();
    claims = error === null ? (data?.claims ?? null) : null;
  } catch {
    claims = null;
  }
  if (!isRecoverySession(claims, Date.now() / 1000)) back('reset_session_invalid');
  const sub = (claims as { sub?: unknown }).sub;
  if (!authRateLimiter.attempt(`reset:${String(sub)}`, RATE_RULES.reset)) back('rate_limited');
  if (password !== confirm) back('password_mismatch');
  const weak = passwordProblem(password);
  if (weak !== null) back(weak);
  try {
    const { error } = await supabase!.auth.updateUser({ password });
    if (error !== null) back(authErrorCode(error));
    // End every session, including the recovery one: the new password is the only way back in.
    await supabase!.auth.signOut({ scope: 'global' });
  } catch (err) {
    if (isRedirect(err)) throw err;
    back(authErrorCode(err));
  }
  redirect('/signin?notice=password_updated');
}

/** next/navigation's redirect() throws a control-flow error that must propagate. */
function isRedirect(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
