import { AuthShell } from '../../_product/auth-shell';
import { Flash } from '../../_product/flash';
import { SubmitButton } from '../../_product/submit-button';
import { signUpAction } from '../../_lib/auth/actions';
import { parseOnboardingHint } from '../../_lib/auth/onboarding';
import { one, type SearchParams } from '../../_lib/search-params';

export const metadata = { title: 'Create account · OnChainFest' };

const LANES = {
  athlete: { label: 'Athlete', line: 'Join tournaments. Keep your record.' },
  organization: { label: 'Organization', line: 'Run competitions. Own your hub.' },
} as const;

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const path = parseOnboardingHint(one(params.path));
  const error = one(params.error);

  if (path === null) {
    return (
      <AuthShell
        eyebrow="Choose your lane"
        title="Enter"
        outline="the game."
        kicker="Create account"
        heading="I’m joining as"
      >
        <Flash error={error} />
        <nav className="lanes" aria-label="Account type">
          {(['athlete', 'organization'] as const).map((lane, i) => (
            <a key={lane} className={`lane ${lane}`} href={`/signup?path=${lane}`}>
              <span className="mono">0{i + 1}</span>
              <strong>{LANES[lane].label}</strong>
              <span>{LANES[lane].line}</span>
              <span className="go mono">Continue →</span>
            </a>
          ))}
        </nav>
        <p className="form-foot">
          Already registered? <a href="/signin">Sign in</a>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow={path === 'athlete' ? 'Athlete account' : 'Organization account'}
      title={path === 'athlete' ? 'Your results.' : 'Run the event.'}
      outline={path === 'athlete' ? 'Your record.' : 'Own the hub.'}
      kicker="Create account"
      heading="Start with your login"
    >
      <div className="chip-row" role="tablist" aria-label="Account type">
        {(['athlete', 'organization'] as const).map((lane) => (
          <a
            key={lane}
            className="chip mono"
            href={`/signup?path=${lane}`}
            aria-current={lane === path ? 'true' : undefined}
          >
            {LANES[lane].label}
          </a>
        ))}
      </div>
      <Flash error={error} />
      <form action={signUpAction}>
        <input type="hidden" name="path" value={path} />
        <label className="field">
          <span>Email</span>
          <input
            required
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
          />
        </label>
        <label className="field">
          <span>Password</span>
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
        <SubmitButton pending="Creating account">Create account</SubmitButton>
      </form>
      <p className="form-foot">
        {path === 'athlete'
          ? 'Your athlete profile comes next.'
          : 'Your organization profile comes next.'}{' '}
        Already registered? <a href="/signin">Sign in</a>
      </p>
    </AuthShell>
  );
}
