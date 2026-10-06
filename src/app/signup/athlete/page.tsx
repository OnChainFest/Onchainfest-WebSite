import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { signupAction } from "@/app/auth/actions";

export default async function AthleteSignup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <AuthShell eyebrow="Athlete account" title="Your results." outline="Your identity." lede="Create one account for tournament registrations, results, rankings and the sporting history OnChainFest is building around them.">
      <div className="auth-panel">
        <span className="panel-kicker">Free athlete account</span>
        <h2 className="panel-title">Create your account</h2>
        <p className="panel-copy">Start with the essentials. Your athlete profile comes next.</p>
        {params.error ? <p className="form-error">{params.error}</p> : null}
        <form action={signupAction}>
          <input type="hidden" name="accountType" value="athlete" />
          <label className="field"><span>Full name</span><input required name="fullName" autoComplete="name" placeholder="Your name" /></label>
          <label className="field"><span>Email</span><input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></label>
          <label className="field"><span>Password</span><input required name="password" type="password" minLength={8} autoComplete="new-password" placeholder="8+ characters" /></label>
          <button className="button cyan full" type="submit">Create athlete account</button>
        </form>
        <p className="form-note">Already have an account? <Link className="inline-link" href="/signin">Sign in</Link>.</p>
      </div>
    </AuthShell>
  );
}
