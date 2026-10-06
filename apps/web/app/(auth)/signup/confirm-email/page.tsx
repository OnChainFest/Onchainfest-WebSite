import { AuthShell } from '../../../_product/auth-shell';
import { Flash } from '../../../_product/flash';
import { SubmitButton } from '../../../_product/submit-button';
import { resendConfirmationAction } from '../../../_lib/auth/actions';
import { parseOnboardingHint } from '../../../_lib/auth/onboarding';
import { one, type SearchParams } from '../../../_lib/search-params';

export const metadata = { title: 'Confirm your email · OnChainFest' };

export default async function ConfirmEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const path = parseOnboardingHint(one(params.path));
  return (
    <AuthShell
      eyebrow="Verify email"
      title="One more"
      outline="step."
      kicker="Check your inbox"
      heading="Confirm your email"
    >
      <Flash error={one(params.error)} notice={one(params.notice)} />
      <p className="lede" style={{ margin: '0 0 1.75rem', color: 'var(--muted)' }}>
        Open the link we sent to finish creating your account. It works once and expires.
      </p>
      <form action={resendConfirmationAction} className="stack">
        {path !== null ? <input type="hidden" name="path" value={path} /> : null}
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Didn’t get it? Resend to</span>
          <input
            required
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
          />
        </label>
        <SubmitButton pending="Sending" className="btn btn-ghost btn-full">
          Resend link
        </SubmitButton>
      </form>
      <p className="form-foot">
        Already confirmed? <a href="/signin">Sign in</a>
      </p>
    </AuthShell>
  );
}
