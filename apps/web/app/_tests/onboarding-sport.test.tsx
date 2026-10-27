import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D-P2 (ONCF-LOCAL-PILOT-01): the athlete's primary sport is chosen from the published catalog —
// the option value is the sport id the API stores — instead of a free-text field whose placeholder
// invited display names the API refuses.

vi.mock('../_lib/app-context', () => ({
  appContext: () =>
    Promise.resolve({
      kind: 'ok',
      session: {},
      account: { me: { athletes: [] } },
      onboarding: 'needs_role',
    }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${url};307;`,
    });
  },
}));
vi.mock('../_product/submit-button', () => ({
  SubmitButton: ({ children }: { children: ReactNode }) => (
    <button type="submit">{children}</button>
  ),
}));

const Onboarding = (await import('../app/onboarding/page')).default;
const html = (el: ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const page = async (q: Record<string, string>) =>
  html(await Onboarding({ searchParams: Promise.resolve(q) }));

let catalog: () => Response;
beforeEach(() => {
  catalog = () =>
    new Response(
      JSON.stringify({
        disciplineVersions: [
          { sport: { code: 'tennis', name: 'Tennis' } },
          { sport: { code: 'padel', name: 'Padel' } },
          { sport: { code: 'tennis', name: 'Tennis' } },
        ],
        formatVersions: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve(
      new URL(url).pathname === '/v1/catalog' ? catalog() : new Response('{}', { status: 404 }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('D-P2 · athlete primary sport', () => {
  it('is a selection of catalog sports (id as value, name as label), optional, no free text', async () => {
    const out = await page({ path: 'athlete' });
    expect(out).toContain('<select name="sport">');
    expect(out).toContain('<option value="" selected="">No primary sport</option>');
    expect(out).toContain(
      '<option value="padel">Padel</option><option value="tennis">Tennis</option>',
    );
    expect(out).not.toMatch(/<input[^>]*name="sport"/);
    expect(out).not.toContain('Padel, tennis, running');
  });

  it('a refused sport shows its own message', async () => {
    const out = await page({ path: 'athlete', error: 'sport_invalid' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Choose your primary sport from the list, or leave it empty.');
  });

  it('without the catalog the profile can still be created without a sport', async () => {
    catalog = () => new Response('{}', { status: 503 });
    const out = await page({ path: 'athlete' });
    expect(out).toContain('<option value="" selected="">No primary sport</option>');
    expect(out).not.toContain('value="tennis"');
    expect(out).toContain('Create athlete profile');
  });
});
