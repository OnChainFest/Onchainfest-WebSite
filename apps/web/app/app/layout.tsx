import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import '../_product/product.css';
import { appContext } from '../_lib/app-context';
import { AppShell, BlockedState, navItems } from '../_product/app-shell';

export const metadata = { title: 'OnChainFest', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * Authenticated application shell. The proxy already gates /app/**; this re-checks on the server
 * (defence in depth) and renders nothing of the app unless the platform API accepts the session.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await appContext();
  if (ctx.kind === 'signed_out') redirect('/signin?next=%2Fapp');
  if (ctx.kind === 'rejected')
    return (
      <BlockedState
        title="Session not accepted"
        body="OnChainFest couldn’t confirm this session for your account. Sign out and sign in again."
        action="signout"
      />
    );
  if (ctx.kind === 'unavailable')
    return (
      <BlockedState
        title="Temporarily unavailable"
        body="We can’t reach the OnChainFest platform right now. Nothing was lost — try again in a moment."
        action="retry"
      />
    );
  const email = typeof ctx.session.claims.email === 'string' ? ctx.session.claims.email : undefined;
  return (
    <AppShell email={email} items={navItems(ctx.account, ctx.onboarding)}>
      {children}
    </AppShell>
  );
}
