import { AuthShell } from "@/components/auth-shell";

export default function OrganizationOnboarding() {
  return (
    <AuthShell eyebrow="Organization onboarding · 01" title="Set up your" outline="competition hub." lede="This makes the promise on the landing page concrete: your own club or tournament page where players can understand the event and sign up in one place.">
      <div className="auth-panel">
        <div className="step-strip"><span className="active"/><span/><span/></div>
        <span className="panel-kicker">Landing page setup</span>
        <h2 className="panel-title">Create your public page</h2>
        <label className="field"><span>Public name</span><input placeholder="Escazú Open 2026" /></label>
        <label className="field"><span>Page address</span><input placeholder="onchainfest.xyz/your-event" /></label>
        <label className="field"><span>Location</span><input placeholder="City, country" /></label>
        <button className="button secondary full" type="button">Continue · wiring next</button>
      </div>
    </AuthShell>
  );
}
