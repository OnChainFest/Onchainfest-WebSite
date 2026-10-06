import { redirect } from 'next/navigation';
import { AuthShell } from '../../_product/auth-shell';
import { Flash } from '../../_product/flash';
import { SubmitButton } from '../../_product/submit-button';
import { signInAction } from '../../_lib/auth/actions';
import { validateContinuationRoute } from '../../_lib/auth/continuation';
import { verifiedSession } from '../../_lib/auth/session';
import { one, type SearchParams } from '../../_lib/search-params';

export const metadata = { title: 'Sign in · OnChainFest' };

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = validateContinuationRoute(one(params.next));
  const error = one(params.error);
  // Already signed in (and not bounced here because of an error): continue into the app.
  if (error === undefined && (await verifiedSession()) !== null) redirect(next ?? '/app');
  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Back in"
      outline="the game."
      kicker="Sign in"
      heading="Continue to OnChainFest"
    >
      <Flash error={error} notice={one(params.notice)} />
      {error === 'email_not_confirmed' ? (
        <p className="form-foot" style={{ marginTop: '-0.5rem', marginBottom: '1.25rem' }}>
          <a href="/signup/confirm-email">Resend the confirmation email</a>
        </p>
      ) : null}
      <form action={signInAction}>
        {next !== null ? <input type="hidden" name="next" value={next} /> : null}
        <label className="field">
          <span>Email</span>
          <input
            required
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
          />
        </label>
        <label className="field">
          <span className="row-between">
            Password
            <a className="link" href="/forgot-password" style={{ letterSpacing: 0 }}>
              Forgot?
            </a>
          </span>
          <input
            required
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
          />
        </label>
        <SubmitButton pending="Signing in">Sign in</SubmitButton>
      </form>
      <p className="form-foot">
        New to OnChainFest? <a href="/signup">Create an account</a>
      </p>
    </AuthShell>
  );
}
