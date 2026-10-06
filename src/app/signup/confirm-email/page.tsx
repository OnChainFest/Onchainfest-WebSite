import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

export default async function ConfirmEmail({ searchParams }: { searchParams: Promise<{ email?: string; type?: string }> }) {
  const params = await searchParams;
  return (
    <AuthShell eyebrow="Verify email" title="One more" outline="step." lede="Supabase email verification stays in the flow so we do not create brittle account states.">
      <div className="auth-panel">
        <span className="panel-kicker">Check your inbox</span>
        <h2 className="panel-title">Confirm your email</h2>
        <p className="panel-copy">We sent a verification link{params.email ? <> to <strong>{params.email}</strong></> : null}. Open it to continue onboarding.</p>
        <Link className="button secondary full" href="/signin">Back to sign in</Link>
      </div>
    </AuthShell>
  );
}
