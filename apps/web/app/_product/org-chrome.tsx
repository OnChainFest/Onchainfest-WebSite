import type { ReactNode } from 'react';
import { ORG_TYPE_LABEL, ROLE_LABEL, type OrgContext } from '../_lib/org-context';

/** Brand colour as a CSS custom property; only #rrggbb from the API is ever applied. */
export function brandStyle(accent: string | null | undefined): Record<string, string> {
  return typeof accent === 'string' && /^#[0-9a-f]{6}$/.test(accent) ? { '--brand': accent } : {};
}

export function OrgMark({
  name,
  logoUrl,
  size = 64,
}: {
  name: string;
  logoUrl: string | null | undefined;
  size?: number;
}) {
  const initials =
    name
      .split(/\s+/)
      .filter((w) => w !== '')
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '·';
  return (
    <span className="org-mark" style={{ width: size, height: size }} aria-hidden="true">
      {typeof logoUrl === 'string' && logoUrl.startsWith('https://') ? (
        <img src={logoUrl} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}

const TABS = [
  { href: '', label: 'Overview' },
  { href: '/profile', label: 'Profile' },
  { href: '/members', label: 'Members' },
  { href: '/invitations', label: 'Invitations', needs: ['ORG_INVITE_MEMBER', 'ORG_VIEW_PRIVATE'] },
  { href: '/roles', label: 'Roles' },
  { href: '/settings', label: 'Settings' },
] as const;

export function OrgHeader({ ctx, children }: { ctx: OrgContext; children?: ReactNode }) {
  const { membership, profile } = ctx;
  const base = `/app/orgs/${membership.slug}`;
  const tabs = TABS.filter((t) => !('needs' in t) || t.needs.some((p) => ctx.permissions.has(p)));
  return (
    <header className="org-hero">
      <div className="org-hero-inner">
        <OrgMark name={membership.displayName} logoUrl={profile?.profile.logoUrl} />
        <div className="org-id">
          <span className="mono muted">
            {ORG_TYPE_LABEL[membership.orgType] ?? membership.orgType}
            {profile?.profile.country ? ` · ${profile.profile.country}` : ''}
          </span>
          <h1>{membership.displayName}</h1>
          <span className="role-chips">
            {ctx.roles.map((r) => (
              <span key={r} className="role-chip mono">
                {ROLE_LABEL[r] ?? r}
              </span>
            ))}
          </span>
        </div>
        <a className="btn btn-ghost org-public" href={`/organizations/${membership.slug}`}>
          Public page ↗
        </a>
      </div>
      {children}
      <nav className="tabs" aria-label="Organization">
        {tabs.map((t) => (
          <a key={t.href} href={`${base}${t.href}`}>
            {t.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
