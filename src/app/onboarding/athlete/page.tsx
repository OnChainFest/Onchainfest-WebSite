import { AuthShell } from "@/components/auth-shell";

export default function AthleteOnboarding() {
  return (
    <AuthShell eyebrow="Athlete onboarding · 01" title="Build your" outline="sporting profile." lede="This is the next screen in the flow. We will wire persistence after the auth foundation is connected to the OnChainFest Supabase project.">
      <div className="auth-panel">
        <div className="step-strip"><span className="active"/><span/><span/></div>
        <span className="panel-kicker">Profile foundation</span>
        <h2 className="panel-title">Tell OnChainFest who you compete as</h2>
        <label className="field"><span>Primary sport</span><input placeholder="Tennis, padel, football..." /></label>
        <label className="field"><span>Country / region</span><input placeholder="Costa Rica" /></label>
        <label className="field"><span>Club or academy · optional</span><input placeholder="Your club" /></label>
        <button className="button secondary full" type="button">Continue · wiring next</button>
      </div>
    </AuthShell>
  );
}
