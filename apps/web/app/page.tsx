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
        <small>{health}</small>
      </p>
    </main>
  );
}
