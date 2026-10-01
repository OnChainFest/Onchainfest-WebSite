export const dynamic = 'force-dynamic';

async function apiHealth(): Promise<string> {
  const base = process.env.BR_API_URL ?? 'http://127.0.0.1:4000';
  try {
    const res = await fetch(`${base}/health`, { cache: 'no-store' });
    return res.ok ? 'API: ok' : `API: HTTP ${res.status}`;
  } catch {
    return 'API: unreachable';
  }
}

export default async function Home() {
  const health = await apiHealth();
  return (
    <main>
      <h1>Bragging Rights</h1>
      <p>Foundation build active.</p>
      <p>
        Public pages: <code>/athletes/&lt;slug&gt;</code> (Athlete Passport) and{' '}
        <code>/organizations/&lt;slug&gt;</code>. With the development seed loaded:{' '}
        <a href="/athletes/ana-ficticia">ana-ficticia</a> ·{' '}
        <a href="/organizations/club-ficticio-padel">club-ficticio-padel</a> (fictional data).{' '}
        <a href="/hall-of-fame">Record Hall of Fame</a>.
      </p>
      <p>
        <small>{health}</small>
      </p>
    </main>
  );
}
