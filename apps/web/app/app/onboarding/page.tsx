import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { appContext } from '../../_lib/app-context';
import { parseOnboardingHint } from '../../_lib/auth/onboarding';
import { ORGANIZATION_TYPES } from '../../_lib/onboarding-input';
import { one, type SearchParams } from '../../_lib/search-params';
import { Flash } from '../../_product/flash';
import { SetupSteps } from '../../_product/setup-steps';
import { SubmitButton } from '../../_product/submit-button';
import { createAthleteProfileAction, createOrganizationAction } from './actions';

export const metadata = { title: 'Set up · OnChainFest' };

export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  const adding = one(params.add) === '1';
  const hasAthlete = ctx.account.me.athletes.length > 0;
  if (ctx.onboarding === 'active' && !adding) redirect('/app');
  let path = parseOnboardingHint(one(params.path));
  if (path === 'athlete' && hasAthlete) path = null;
  // Keys are fixed per rendered form, so a retried submission never creates duplicates.
  const personKey = `oc-person-${randomUUID()}`;
  const profileKey = `oc-profile-${randomUUID()}`;

  return (
    <>
      <div className="page-head">
        <span className="mono muted">Set up</span>
        <h1 className="page-title">
          {path === 'organization' ? 'Your' : path === 'athlete' ? 'Your' : 'Choose'}{' '}
          <span className="outline">
            {path === 'organization'
              ? 'organization.'
              : path === 'athlete'
                ? 'athlete profile.'
                : 'your lane.'}
          </span>
        </h1>
      </div>
      <Flash error={one(params.error)} notice={one(params.notice)} />
      {ctx.onboarding !== 'active' ? <SetupSteps state={ctx.onboarding} /> : null}
      <div className="split">
        <nav className="lanes" aria-label="Profile type">
          {!hasAthlete ? (
            <a
              className="lane athlete"
              href="/app/onboarding?path=athlete"
              aria-current={path === 'athlete' ? 'true' : undefined}
            >
              <span className="mono">01</span>
              <strong>Athlete</strong>
              <span>Register for tournaments and build your record.</span>
            </a>
          ) : null}
          <a
            className="lane organization"
            href={`/app/onboarding?path=organization${adding ? '&add=1' : ''}`}
            aria-current={path === 'organization' ? 'true' : undefined}
          >
            <span className="mono">{hasAthlete ? '01' : '02'}</span>
            <strong>Organization</strong>
            <span>Run competitions as a club, academy, league or organizer.</span>
          </a>
        </nav>

        {path === 'athlete' ? (
          <form action={createAthleteProfileAction} className="form-col">
            <input type="hidden" name="personKey" value={personKey} />
            <input type="hidden" name="profileKey" value={profileKey} />
            <label className="field">
              <span>Name on your profile</span>
              <input required name="displayName" maxLength={80} autoComplete="name" />
            </label>
            <label className="field">
              <span>Primary sport · optional</span>
              <input name="sport" maxLength={40} placeholder="Padel, tennis, running…" />
            </label>
            <label className="field">
              <span>Country · optional</span>
              <input
                name="country"
                maxLength={2}
                pattern="[A-Za-z]{2}"
                placeholder="CR"
                autoComplete="country"
              />
              <small>Two-letter code.</small>
            </label>
            <label className="field">
              <span>Profile address · optional</span>
              <input name="slug" maxLength={50} pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]" />
              <small>/athletes/your-address — leave blank to generate one.</small>
            </label>
            <SubmitButton pending="Creating profile">Create athlete profile</SubmitButton>
          </form>
        ) : null}

        {path === 'organization' ? (
          <form action={createOrganizationAction} className="form-col">
            <input type="hidden" name="personKey" value={personKey} />
            <input type="hidden" name="profileKey" value={profileKey} />
            <label className="field">
              <span>Organization name</span>
              <input required name="displayName" maxLength={120} autoComplete="organization" />
            </label>
            <label className="field">
              <span>Type</span>
              <select required name="orgType" defaultValue="CLUB">
                {ORGANIZATION_TYPES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Country · optional</span>
              <input name="country" maxLength={2} pattern="[A-Za-z]{2}" placeholder="CR" />
            </label>
            <label className="field">
              <span>Page address · optional</span>
              <input name="slug" maxLength={50} pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]" />
              <small>/organizations/your-address — leave blank to generate one.</small>
            </label>
            <SubmitButton pending="Creating organization">Create organization</SubmitButton>
          </form>
        ) : null}
      </div>
    </>
  );
}
