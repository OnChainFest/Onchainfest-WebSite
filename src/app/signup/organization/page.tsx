import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { signupAction } from "@/app/auth/actions";

export default async function OrganizationSignup({ searchParams }: { searchParams: Promise<{ error?: string; plan?: string }> }) {
  const params = await searchParams;
  return (
    <AuthShell eyebrow="Organization account" title="Run the event." outline="Own the hub." lede="Create the organization account first. Then build the club or tournament landing page where athletes can register in one place.">
      <div className="auth-panel">
        <span className="panel-kicker">Organization · monthly subscription</span>
        <h2 className="panel-title">Create organization account</h2>
        <p className="panel-copy">Billing is a separate step, so your account and organization identity stay reusable even if plans change.</p>
        {params.error ? <p className="form-error">{params.error}</p> : null}
        <form action={signupAction}>
          <input type="hidden" name="accountType" value="organization" />
          <input type="hidden" name="plan" value={params.plan ?? "organizer"} />
          <label className="field"><span>Your full name</span><input required name="fullName" autoComplete="name" placeholder="Account owner" /></label>
          <label className="field"><span>Organization name</span><input required name="organizationName" placeholder="Club, academy or tournament series" /></label>
          <label className="field"><span>Email</span><input required name="email" type="email" autoComplete="email" placeholder="you@organization.com" /></label>
          <label className="field"><span>Password</span><input required name="password" type="password" minLength={8} autoComplete="new-password" placeholder="8+ characters" /></label>
          <button className="button full" type="submit">Create organization account</button>
        </form>
        <p className="form-note"><Link className="inline-link" href="/pricing">Review monthly plan</Link> · Already registered? <Link className="inline-link" href="/signin">Sign in</Link>.</p>
      </div>
    </AuthShell>
  );
}
