import { appContext } from '../../_lib/app-context';

export const metadata = { title: 'Account · OnChainFest' };

const METHOD_LABEL: Record<string, string> = {
  password: 'Email and password',
  otp: 'Email link',
  magiclink: 'Email link',
  oauth: 'Single sign-on',
  recovery: 'Password recovery link',
};

export default async function AccountPage() {
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  const { claims } = ctx.session;
  const amr = Array.isArray(claims.amr) ? (claims.amr as { method?: unknown }[]) : [];
  const method = typeof amr[0]?.method === 'string' ? amr[0].method : undefined;
  return (
    <>
      <div className="page-head">
        <span className="mono muted">Account</span>
        <h1 className="page-title">
          Your <span className="outline">login.</span>
        </h1>
      </div>
      <dl>
        <dt className="mono">Email</dt>
        <dd>{typeof claims.email === 'string' ? claims.email : '—'}</dd>
        <dt className="mono">Signed in with</dt>
        <dd>{method !== undefined ? (METHOD_LABEL[method] ?? method) : '—'}</dd>
        <dt className="mono">Platform account</dt>
        <dd>
          <code>{ctx.account.me.accountId}</code>
        </dd>
        <dt className="mono">Person record</dt>
        <dd>{ctx.account.me.selfPersonId === null ? 'Not created yet' : 'Created'}</dd>
      </dl>
      <p style={{ marginTop: '2.5rem' }}>
        <a className="btn btn-ghost" href="/forgot-password">
          Change password
        </a>
      </p>
    </>
  );
}
