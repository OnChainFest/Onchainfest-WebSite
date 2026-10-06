import type { ReactNode } from 'react';
import type { OnboardingState } from '../_lib/auth/onboarding';
import type { AccountState } from '../_lib/platform';
import { Brand } from './brand';

interface NavItem {
  readonly href: string;
  readonly label: string;
}

/** Navigation derived from platform rows only: athlete profiles and organization memberships. */
export function navItems(account: AccountState, onboarding: OnboardingState): NavItem[] {
  const items: NavItem[] = [{ href: '/app', label: 'Home' }];
  if (onboarding !== 'active') items.push({ href: '/app/onboarding', label: 'Finish setup' });
  for (const a of account.me.athletes.slice(0, 1))
    items.push({ href: `/athletes/${a.slug}`, label: 'Athlete profile' });
  const orgs = [...new Map(account.organizations.map((o) => [o.slug, o])).values()];
  for (const o of orgs.slice(0, 3))
    items.push({ href: `/app/orgs/${o.slug}`, label: o.displayName });
  return items;
}

function SignOutForm({ className }: { className: string }) {
  return (
    <form action="/auth/signout" method="post">
      <button className={className} type="submit">
        Sign out
      </button>
    </form>
  );
}

export function AppShell({
  email,
  items,
  children,
}: {
  email: string | undefined;
  items: NavItem[];
  children: ReactNode;
}) {
  const initial = (email ?? '?').slice(0, 1);
  return (
    <div className="oc oc-app">
      <header className="topbar">
        <div className="bar">
          <Brand href="/app" />
          <nav className="nav" aria-label="Application">
            {items.map((i) => (
              <a key={i.href} href={i.href}>
                {i.label}
              </a>
            ))}
          </nav>
          <div className="account">
            <a className="avatar" href="/app/account" aria-label="Account" title={email}>
              {initial}
            </a>
            <SignOutForm className="signout mono" />
          </div>
          <details className="menu">
            <summary className="mono" aria-label="Menu">
              Menu
            </summary>
            <div className="sheet">
              {items.map((i) => (
                <a key={i.href} href={i.href}>
                  {i.label}
                </a>
              ))}
              <a href="/app/account">Account</a>
              <SignOutForm className="mono" />
            </div>
          </details>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

/** Fail-closed full-page state when the session or the platform cannot be confirmed. */
export function BlockedState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: 'retry' | 'signout';
}) {
  return (
    <div className="oc oc-app">
      <header className="topbar">
        <div className="bar">
          <Brand />
        </div>
      </header>
      <main>
        <div className="state-block bad">
          <h1 className="page-title" style={{ fontSize: 'clamp(2rem,4vw,3rem)' }}>
            {title}
          </h1>
          <p className="muted">{body}</p>
          {action === 'retry' ? (
            <a className="btn btn-ghost" href="/app">
              Retry
            </a>
          ) : (
            <SignOutForm className="btn btn-ghost" />
          )}
        </div>
      </main>
    </div>
  );
}
