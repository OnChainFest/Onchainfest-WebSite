import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { signinAction } from "@/app/auth/actions";

export default async function SigninPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const params = await searchParams;
  return (
    <AuthShell eyebrow="Existing account" title="Welcome" outline="back." lede="One sign-in for athletes and organizations. OnChainFest uses your account type to send you to the right workspace.">
      <div className="auth-panel">
        <span className="panel-kicker">Sign in</span>
        <h2 className="panel-title">Continue to OnChainFest</h2>
        <p className="panel-copy">Use the email and password attached to your account.</p>
        {params.error ? <p className="form-error">{params.error}</p> : null}
        <form action={signinAction}>
          {params.next ? <input type="hidden" name="next" value={params.next} /> : null}
          <label className="field"><span>Email</span><input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label>
          <label className="field"><span>Password</span><input required name="password" type="password" autoComplete="current-password" placeholder="Your password" /></label>
          <button className="button cyan full" type="submit">Sign in</button>
        </form>
        <p className="form-note">New here? <Link className="inline-link" href="/signup">Choose your account type</Link>.</p>
      </div>
    </AuthShell>
  );
}
