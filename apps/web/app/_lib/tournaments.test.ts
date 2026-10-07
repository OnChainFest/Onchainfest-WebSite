import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE } from './api';
import { managedCompetition, managedCompetitions, tournamentCatalog } from './tournaments';

const ORG = '11111111-1111-4111-8111-111111111111';
const COMP = '22222222-2222-4222-8222-222222222222';

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('ONCF-03A tournament client', () => {
  it('lists an organization’s managed competitions with the caller’s token', async () => {
    const fetchMock = stubFetch(200, { items: [{ id: COMP, status: 'DRAFT' }] });
    const r = await managedCompetitions('tok', ORG);
    expect(r).toMatchObject({ kind: 'ok', data: { items: [{ id: COMP, status: 'DRAFT' }] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/v1/organizations/${ORG}/competitions/manage`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('surfaces the API’s refusal instead of deciding access itself', async () => {
    stubFetch(403, { error: { code: 'FORBIDDEN' } });
    expect(await managedCompetition('tok', COMP)).toEqual({
      kind: 'error',
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('reads the public catalog without credentials', async () => {
    const fetchMock = stubFetch(200, { disciplineVersions: [], formatVersions: [] });
    expect(await tournamentCatalog()).toEqual({
      kind: 'ok',
      data: { disciplineVersions: [], formatVersions: [] },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toBe(`${API_BASE}/v1/catalog`);
    expect(JSON.stringify(init ?? {})).not.toContain('authorization');
  });
});
