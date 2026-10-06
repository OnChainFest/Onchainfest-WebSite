import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

export default function PricingPage() {
  const configuredPrice = process.env.NEXT_PUBLIC_ORGANIZATION_MONTHLY_PRICE_LABEL;
  return (
    <AuthShell eyebrow="For organizations" title="One monthly plan." outline="Run the competition." lede="The billing layer is deliberately separate from account creation, borrowing the proven subscription architecture already used in PMFreak.">
      <div className="auth-panel">
        <span className="panel-kicker">Organizer plan</span>
        <h2 className="panel-title">Organization</h2>
        <div className="price-card">
          <div><strong>{configuredPrice ?? "Monthly"}</strong><br/><span>subscription</span></div>
          <span>Per organization</span>
        </div>
        <ul className="feature-list">
          <li>Club or tournament landing page</li>
          <li>Athlete registration in one place</li>
          <li>Competition, results and rankings workflow</li>
          <li>Organization dashboard foundation</li>
        </ul>
        <Link className="button full" href="/signup/organization?plan=organizer">Start organization setup</Link>
        {!configuredPrice ? <p className="form-note">The exact monthly amount is configuration-driven and has not been locked yet; we can set it without changing this flow.</p> : null}
      </div>
    </AuthShell>
  );
}
