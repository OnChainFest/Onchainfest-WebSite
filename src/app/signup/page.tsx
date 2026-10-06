import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  return (
    <AuthShell
      eyebrow="Choose your lane"
      title="How do you"
      outline="enter the game?"
      lede="One OnChainFest account can grow with you. Start as an athlete or create the organization that runs the competition."
    >
      {params.error ? <p className="form-error">{params.error}</p> : null}
      <div className="role-grid">
        <Link className="role-card athlete" href="/signup/athlete">
          <span className="role-num">01 / ATHLETE</span>
          <div><h2>Athlete</h2><p>Build your sporting identity, join tournaments and keep a record of what you accomplish.</p></div>
          <span className="go">Create athlete account →</span>
        </Link>
        <Link className="role-card organization" href="/pricing">
          <span className="role-num">02 / ORGANIZATION</span>
          <div><h2>Organization</h2><p>Run competitions, manage registrations and publish your club or tournament landing page.</p></div>
          <span className="go">See monthly plan →</span>
        </Link>
      </div>
    </AuthShell>
  );
}
