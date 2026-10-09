import { AuthShell } from '../../_product/auth-shell';
import { Flash } from '../../_product/flash';
import { SubmitButton } from '../../_product/submit-button';
import { resetPasswordAction } from '../../_lib/auth/actions';
import { isRecoverySession } from '../../_lib/auth/recovery';
import { verifiedSession } from '../../_lib/auth/session';
import { one, type SearchParams } from '../../_lib/search-params';

export const metadata = { title: 'New password · OnChainFest' };

export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const session = await verifiedSession();
  const valid = session !== null && isRecoverySession(session.claims, Date.now() / 1000);

  if (!valid) {
    return (
      <AuthShell
        eyebrow="Account recovery"
        title="Link"
        outline="expired."
        kicker="Reset password"
        heading="Request a fresh link"
      >
        <p className="lede" style={{ margin: '0 0 1.75rem', color: 'var(--muted)' }}>
          Reset links work once and expire after an hour.
        </p>
        <a className="btn btn-cyan btn-full" href="/forgot-password">
          Request a new link
        </a>
        <p className="form-foot">
          Know your password? <a href="/signin">Sign in</a>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="New"
      outline="password."
      kicker="Reset password"
      heading="Choose a new password"
    >
      <Flash error={one(params.error)} />
      <form action={resetPasswordAction}>
        <label className="field">
          <span>New password</span>
          <input
            required
            name="password"
            type="password"
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            placeholder="8+ characters, letters and numbers"
          />
        </label>
        <label className="field">
          <span>Repeat password</span>
          <input
            required
            name="confirm"
            type="password"
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <SubmitButton pending="Saving">Save password</SubmitButton>
      </form>
      <p className="form-foot">Every other session will be signed out.</p>
    </AuthShell>
  );
}
