import { AuthShell } from '../../_product/auth-shell';
import { Flash } from '../../_product/flash';
import { SubmitButton } from '../../_product/submit-button';
import { forgotPasswordAction } from '../../_lib/auth/actions';
import { one, type SearchParams } from '../../_lib/search-params';

export const metadata = { title: 'Reset password · OnChainFest' };

export default async function ForgotPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const sent = one(params.notice) === 'reset_sent';
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Reset"
      outline="your access."
      kicker="Forgot password"
      heading={sent ? 'Check your inbox' : 'Get a reset link'}
    >
      <Flash error={one(params.error)} notice={one(params.notice)} />
      {sent ? null : (
        <form action={forgotPasswordAction}>
          <label className="field">
            <span>Account email</span>
            <input
              required
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
            />
          </label>
          <SubmitButton pending="Sending">Send reset link</SubmitButton>
        </form>
      )}
      <p className="form-foot">
        Remembered it? <a href="/signin">Sign in</a>
      </p>
    </AuthShell>
  );
}
