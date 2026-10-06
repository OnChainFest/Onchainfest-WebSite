import { appContext } from '../_lib/app-context';
import { one, type SearchParams } from '../_lib/search-params';
import { Flash } from '../_product/flash';
import { SetupSteps } from '../_product/setup-steps';

export const metadata = { title: 'Home · OnChainFest' };

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  STAFF: 'Staff',
  COACH: 'Coach',
  OFFICIAL: 'Official',
  ATHLETE: 'Athlete',
  MEMBER: 'Member',
};

export default async function AppHome({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null; // the layout renders the blocked state
  const { account, onboarding } = ctx;

  if (onboarding !== 'active') {
    return (
      <>
        <div className="page-head">
          <span className="mono muted">Your OnChainFest</span>
          <h1 className="page-title">
            Let’s get you <span className="outline">on the field.</span>
          </h1>
        </div>
        <Flash notice={one(params.notice)} />
        <SetupSteps state={onboarding} />
        <a className="btn btn-cyan" href="/app/onboarding">
          Continue setup →
        </a>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <span className="mono muted">Your OnChainFest</span>
        <h1 className="page-title">
          Ready <span className="outline">to compete.</span>
        </h1>
      </div>
      <Flash notice={one(params.notice)} />
      <div className="split">
        <section aria-labelledby="athletes-h">
          <h2 id="athletes-h" className="mono muted">
            Athlete profiles
          </h2>
          {account.me.athletes.length === 0 ? (
            <p className="muted">
              No athlete profile on this account.{' '}
              <a className="link" href="/app/onboarding?path=athlete&add=1">
                Add one
              </a>
            </p>
          ) : (
            <ul className="list">
              {account.me.athletes.map((a) => (
                <li key={a.athleteId}>
                  <strong>{a.slug}</strong>
                  <a className="link mono" href={`/athletes/${a.slug}`}>
                    Public profile →
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="orgs-h">
          <h2 id="orgs-h" className="mono muted">
            Organizations
          </h2>
          {account.organizations.length === 0 ? (
            <p className="muted">
              You’re not a member of an organization.{' '}
              <a className="link" href="/app/onboarding?path=organization&add=1">
                Create one
              </a>
            </p>
          ) : (
            <ul className="list">
              {account.organizations.map((o) => (
                <li key={o.membershipId}>
                  <span>
                    <strong>{o.displayName}</strong>{' '}
                    <span className="tag mono">{ROLE_LABEL[o.role] ?? o.role}</span>
                  </span>
                  <a className="link mono" href={`/organizations/${o.slug}`}>
                    Public page →
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
