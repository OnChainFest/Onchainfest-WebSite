import { notFound } from 'next/navigation';
import { API_BASE } from '../../../../_lib/api';
import { orgContext, ROLE_LABEL } from '../../../../_lib/org-context';

export const metadata = { title: 'Roles · OnChainFest' };

/**
 * Plain-language descriptions for the canonical permission names (GET /v1/organization-roles).
 * Names are shown exactly as the platform defines them; nothing here grants anything.
 */
const PERMISSION_LABEL: Record<string, string> = {
  ORG_VIEW_PRIVATE: 'See the full roster and pending invitations',
  ORG_EDIT_PROFILE: 'Edit the profile, branding and page address',
  ORG_INVITE_MEMBER: 'Invite members',
  ORG_REMOVE_MEMBER: 'Suspend, remove members and revoke invitations',
  ORG_MANAGE_ROLES: 'Change members’ roles',
  ORG_CONFIRM_EXTERNAL_ID: 'Confirm athletes’ external identities',
  ORG_MANAGE_COMPETITIONS: 'Create and run competitions',
};

async function canonicalRoles() {
  try {
    const res = await fetch(`${API_BASE}/v1/organization-roles`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      roles: { role: string; permissions: string[] }[];
      permissions: string[];
    };
  } catch {
    return null;
  }
}

export default async function RolesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [result, model] = await Promise.all([orgContext(slug), canonicalRoles()]);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (model === null) return <p className="muted">Roles are unavailable right now.</p>;

  return (
    <>
      <div className="section-head">
        <h2 className="mono muted">What each role can do</h2>
        <span className="muted small">Only an owner can make someone an owner.</span>
      </div>
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {model.roles.map((r) => (
                <th
                  key={r.role}
                  scope="col"
                  className={ctx.roles.includes(r.role) ? 'mine' : undefined}
                >
                  {ROLE_LABEL[r.role] ?? r.role}
                  {ctx.roles.includes(r.role) ? <span className="mono"> you</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.permissions.map((p) => (
              <tr key={p}>
                <th scope="row">
                  {PERMISSION_LABEL[p] ?? p}
                  <code className="mono muted">{p}</code>
                </th>
                {model.roles.map((r) => (
                  <td key={r.role} className={ctx.roles.includes(r.role) ? 'mine' : undefined}>
                    {r.permissions.includes(p) ? (
                      <span className="yes" aria-label="Allowed">
                        ●
                      </span>
                    ) : (
                      <span className="no" aria-label="Not allowed">
                        ·
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: '1.25rem' }}>
        Every member can see the public roster and leave the organization.
      </p>
    </>
  );
}
