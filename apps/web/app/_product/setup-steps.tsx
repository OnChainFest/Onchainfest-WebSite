import type { OnboardingState } from '../_lib/auth/onboarding';

/** The real onboarding progress, derived from platform rows. */
export function SetupSteps({ state }: { state: OnboardingState }) {
  const steps = [
    { label: 'Account', detail: 'Signed in', state: 'done' },
    {
      label: 'Lane',
      detail: 'Athlete or organization',
      state: state === 'active' ? 'done' : 'current',
    },
    {
      label: 'Profile',
      detail: 'Public page created',
      state: state === 'active' ? 'done' : 'todo',
    },
  ] as const;
  return (
    <ol className="steps" aria-label="Setup progress">
      {steps.map((s, i) => (
        <li key={s.label} data-state={s.state}>
          <span className="mono">
            0{i + 1} · {s.state === 'done' ? 'Done' : s.state === 'current' ? 'Now' : 'Next'}
          </span>
          <strong>{s.label}</strong>
          <span className="muted">{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}
