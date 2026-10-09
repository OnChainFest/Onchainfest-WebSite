import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { orgContext } from '../../../_lib/org-context';
import { brandStyle, OrgHeader } from '../../../_product/org-chrome';

/**
 * Organization area. Only ACTIVE members get in (anyone else sees a plain 404, so the area reveals
 * nothing about organizations the caller doesn't belong to). Capabilities come from the API.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const result = await orgContext(slug);
  if (result.kind === 'not_member') notFound();
  if (result.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <h1 className="page-title" style={{ fontSize: 'clamp(2rem,4vw,3rem)' }}>
          Temporarily unavailable
        </h1>
        <p className="muted">We can’t load this organization right now. Try again in a moment.</p>
      </div>
    );
  return (
    <div className="org-area" style={brandStyle(result.ctx.profile?.profile.accentColor)}>
      <OrgHeader ctx={result.ctx} />
      <div className="org-body">{children}</div>
    </div>
  );
}
