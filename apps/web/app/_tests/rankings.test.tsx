import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, getPublic } from '../_lib/api';
import RankingSnapshotPage from '../(explorer)/ranking-snapshots/[id]/page';
import RankingSystemPage from '../(explorer)/ranking-systems/[system]/page';
import SnapshotHistoryPage from '../(explorer)/ranking-systems/[system]/snapshots/page';
import RankingSystemsPage from '../(explorer)/ranking-systems/page';
import ClassificationPage from '../(explorer)/result-versions/[id]/classification/page';

/**
 * BRT-10 Step 12 web surfaces, rendered server-side exactly as Next renders them, against the PUBLIC
 * Step 11 API. The API is a stubbed `fetch` serving the Step 11 API vector DTOs verbatim (the corpus the
 * composer, the HTTP tests and the independent Python checker all agree on). Test-only: no fixture is
 * reachable from the pages. ALL DATA IS FICTIONAL.
 */
interface Vector {
  name: string;
  kind: string;
  input: Record<string, unknown>;
  canonicalText: string;
}
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/rankings/test-vectors/brt-10-api.vectors.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string): Vector => {
  const v = VECTORS.find((x) => x.name === name);
  if (v === undefined) throw new Error(`no vector ${name}`);
  return v;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON navigation in tests
const dto = (name: string): any => JSON.parse(vector(name).canonicalText);
const errorOf = (name: string) => {
  const v = vector(name);
  return { status: (v.input as { status: number }).status, body: JSON.parse(v.canonicalText) };
};

type Reply = { status: number; body: unknown } | 'network-error';
let routes: Map<string, Reply>;
let requested: string[];

/** Routes are matched on path + exact query string, so the web's API calls are asserted too. */
const serve = (pathAndQuery: string, body: unknown, status = 200) =>
  routes.set(pathAndQuery, { status, body });

beforeEach(() => {
  routes = new Map();
  requested = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    expect(url.startsWith(API_BASE)).toBe(true);
    const path = url.slice(API_BASE.length);
    requested.push(path);
    const r = routes.get(path);
    if (r === 'network-error') throw new TypeError('fetch failed');
    const { status, body } = r ?? errorOf('error/snapshot-not-found');
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const html = async (page: Promise<ReactElement>) => renderToStaticMarkup(await page);

/** Next's notFound() / permanentRedirect() throw a control-flow error carrying a digest. */
async function control(page: Promise<unknown>): Promise<string> {
  try {
    await page;
  } catch (e) {
    return String((e as { digest?: string }).digest);
  }
  throw new Error('expected notFound() or a redirect');
}
const is404 = (digest: string) => expect(digest).toMatch(/;404$/);

const props = <P, S = Record<string, never>>(params: P, search?: S) => ({
  params: Promise.resolve(params),
  searchParams: Promise.resolve((search ?? {}) as S),
});

const rowsOf = (h: string) =>
  [...h.matchAll(/data-rank="(\d+)" data-tied="(true|false)"/g)].map((m) => [
    Number(m[1]),
    m[2] === 'true',
  ]);
const valuesOf = (h: string) => [...h.matchAll(/data-value="">([^<]*)</g)].map((m) => m[1]);

const LIMIT = 'limit=50';
const PLATFORM = dto('system/platform-published');
const OFFICIAL = dto('system/official-owner-publication-unavailable');
const SNAP = dto('snapshot/current');
const SID = SNAP.snapshot.snapshotId as string;
const CLS = dto('classification/current');
const RV = CLS.classification.resultVersionId as string;

describe('ranking systems', () => {
  it('render from the public API with the recognition semantics exactly as returned', async () => {
    const list = dto('systemList/page-with-cursor');
    serve(`/v1/ranking-systems?${LIMIT}`, list);
    const h = await html(RankingSystemsPage(props({}, {})));
    expect(requested).toEqual([`/v1/ranking-systems?${LIMIT}`]);
    for (const s of list.items) {
      expect(h).toContain(`href="/ranking-systems/${s.code}"`);
      expect(h).toContain(s.displayName);
    }
    expect(h).toContain(`href="/ranking-systems?cursor=${list.nextCursor}"`);
  });

  it('PLATFORM shows the computed label; OFFICIAL never does and states owner publication is unavailable', async () => {
    serve(`/v1/ranking-systems/${PLATFORM.code}`, PLATFORM);
    serve(`/v1/ranking-systems/${OFFICIAL.code}`, OFFICIAL);
    const p = await html(RankingSystemPage(props({ system: PLATFORM.code })));
    expect(p).toContain(PLATFORM.label);
    expect(p).toContain(PLATFORM.version.specHash);
    expect(p).toContain(`href="/ranking-systems/${PLATFORM.code}/snapshots"`);
    expect(p).toContain(`href="/ranking-systems/${PLATFORM.code}/snapshots?view=as-corrected"`);
    const o = await html(RankingSystemPage(props({ system: OFFICIAL.code })));
    expect(o).not.toContain('Bragging Rights platform ranking');
    expect(o).toContain('Official ranking system');
    expect(o).toContain('Owner publication not available');
    // Read-only: no form, button or mutation control anywhere.
    for (const h of [p, o]) expect(h).not.toMatch(/<form|<button|method="post"/i);
  });

  it('empty list, uuid → canonical code redirect, unknown and malformed refs are 404', async () => {
    serve(`/v1/ranking-systems?${LIMIT}`, { schema: 'br:public-ranking-system-list@1', items: [] });
    expect(await html(RankingSystemsPage(props({}, {})))).toContain(
      'No public ranking systems yet.',
    );
    serve(`/v1/ranking-systems/${PLATFORM.systemId}`, PLATFORM);
    expect(await control(RankingSystemPage(props({ system: PLATFORM.systemId })))).toMatch(
      new RegExp(`^NEXT_REDIRECT;replace;/ranking-systems/${PLATFORM.code};308;`),
    );
    const unknown = errorOf('error/system-not-found');
    serve('/v1/ranking-systems/no-such-system', unknown.body, unknown.status);
    is404(await control(RankingSystemPage(props({ system: 'no-such-system' }))));
    requested = [];
    is404(await control(RankingSystemPage(props({ system: 'Bad_Ref!' }))));
    is404(await control(RankingSystemsPage(props({}, { cursor: 'not a cursor' }))));
    expect(requested).toEqual([]); // malformed input never reaches the API
  });
});

describe('snapshot history', () => {
  const sys = PLATFORM.code as string;
  beforeEach(() => serve(`/v1/ranking-systems/${sys}`, PLATFORM));

  it('as-published: every snapshot in chain order, corrected ones marked with what corrected them', async () => {
    const hist = dto('history/as-published-keeps-every-snapshot');
    serve(`/v1/ranking-systems/${sys}/snapshots?view=as-published&${LIMIT}`, hist);
    const h = await html(SnapshotHistoryPage(props({ system: sys }, {})));
    const ids = [
      ...h.matchAll(/data-snapshot=""><a href="\/ranking-snapshots\/([0-9a-f-]+)"/g),
    ].map((m) => m[1]);
    expect(ids).toEqual(hist.items.map((i: { snapshotId: string }) => i.snapshotId));
    for (const i of hist.items) {
      expect(h).toContain(`#${i.lineage.chainPosition} · as of ${i.asOf}`);
      if (i.lineage.correctedBy !== undefined)
        expect(h).toContain(`corrected by <a href="/ranking-snapshots/${i.lineage.correctedBy}"`);
    }
    expect(h).toContain('<strong>As published</strong>');
  });

  it('as-corrected: the final correction stands in for what it corrects; paging keeps the view', async () => {
    const hist = dto('history/as-corrected-replaces-corrected');
    serve(`/v1/ranking-systems/${sys}/snapshots?view=as-corrected&${LIMIT}`, hist);
    const h = await html(SnapshotHistoryPage(props({ system: sys }, { view: 'as-corrected' })));
    const corrector = hist.items.find((i: { corrects?: string[] }) => i.corrects !== undefined);
    expect(h).toContain('stands in for');
    for (const c of corrector.corrects) expect(h).toContain(`href="/ranking-snapshots/${c}"`);
    expect(h).toContain('<strong>As corrected</strong>');

    const paged = dto('history/page-with-cursor');
    serve(`/v1/ranking-systems/${sys}/snapshots?view=as-corrected&${LIMIT}`, paged);
    const p = await html(SnapshotHistoryPage(props({ system: sys }, { view: 'as-corrected' })));
    expect(p).toContain(
      `href="/ranking-systems/${sys}/snapshots?view=as-corrected&amp;cursor=${paged.nextCursor}"`,
    );
  });

  it('no published snapshots (production today) renders an honest empty state; bad view is 404', async () => {
    serve(`/v1/ranking-systems/${sys}/snapshots?view=as-published&${LIMIT}`, dto('history/empty'));
    expect(await html(SnapshotHistoryPage(props({ system: sys }, {})))).toContain(
      'No published snapshots yet.',
    );
    requested = [];
    is404(await control(SnapshotHistoryPage(props({ system: sys }, { view: 'latest' }))));
    expect(requested).toEqual([]);
  });
});

describe('ranking snapshot + leaderboard', () => {
  const lbPath = (q = LIMIT) => `/v1/ranking-snapshots/${SID}/leaderboard?${q}`;

  it('immutable facts, hashes, lineage, CURRENT read-time staleness and the leaderboard with shared ties', async () => {
    const lb = dto('leaderboard/shared-ties-private-and-team');
    serve(`/v1/ranking-snapshots/${SID}`, SNAP);
    serve(lbPath(), lb);
    const h = await html(RankingSnapshotPage(props({ id: SID }, {})));
    expect(requested.sort()).toEqual([`/v1/ranking-snapshots/${SID}`, lbPath()].sort());
    expect(h).toContain(SNAP.snapshot.snapshotHash);
    expect(h).toContain(SNAP.snapshot.system.specHash);
    expect(h).toContain('Current at read time');
    expect(h).toContain('not a sporting result');
    // 1, 1, 3 — shared ranks are real ranks, rendered as returned.
    expect(rowsOf(h)).toEqual([
      [1, true],
      [1, true],
      [3, false],
    ]);
    expect(valuesOf(h)).toEqual(
      lb.entries.map((e: { value: { display: string } }) => e.value.display),
    );
    expect(h).toContain('href="/athletes/fictional-runner-a"');
    expect(h).toContain('Private entrant');
    expect(h).toContain('Team <span>Fictional Relay Club</span>');
    expect(h).not.toMatch(/<form|<button|<input|method="post"/i);
  });

  it('STALE at read time: state and fixed reasons only, never the affected pins', async () => {
    const v = vector('snapshot/stale-topology-omitted');
    const s = JSON.parse(v.canonicalText);
    const id = s.snapshot.snapshotId;
    serve(`/v1/ranking-snapshots/${id}`, s);
    serve(`/v1/ranking-snapshots/${id}/leaderboard?${LIMIT}`, {
      ...dto('leaderboard/shared-ties-private-and-team'),
      snapshotId: id,
    });
    const h = await html(RankingSnapshotPage(props({ id }, {})));
    expect(h).toContain('Stale at read time');
    for (const r of s.readTime.staleness.reasons) expect(h).toContain(`<code>${r}</code>`);
    expect(hiddenIn(v).length).toBeGreaterThan(0);
    for (const hidden of hiddenIn(v)) expect(h).not.toContain(hidden);
  });

  it('correction lineage: links the corrected prior snapshot; a corrected snapshot says so', async () => {
    const s = dto('snapshot/correction-lineage');
    const id = s.snapshot.snapshotId;
    serve(`/v1/ranking-snapshots/${id}`, s);
    serve(`/v1/ranking-snapshots/${id}/leaderboard?${LIMIT}`, {
      schema: 'br:public-ranking-leaderboard@1',
      snapshotId: id,
      snapshotHash: s.snapshot.snapshotHash,
      entries: [],
    });
    const h = await html(RankingSnapshotPage(props({ id }, {})));
    expect(h).toContain(
      `href="/ranking-snapshots/${s.snapshot.lineage.priorSnapshotId}">corrects the prior snapshot`,
    );
    expect(h).toContain(s.snapshot.lineage.priorSnapshotHash);

    const corrected = {
      ...SNAP,
      snapshot: { ...SNAP.snapshot, lineage: { ...SNAP.snapshot.lineage, correctedBy: id } },
    };
    serve(`/v1/ranking-snapshots/${SID}`, corrected);
    serve(lbPath(), dto('leaderboard/shared-ties-private-and-team'));
    const c = await html(RankingSnapshotPage(props({ id: SID }, {})));
    expect(c).toContain(`This snapshot was corrected by <a href="/ranking-snapshots/${id}"`);
  });

  it('pagination: the opaque cursor is passed through verbatim; next/first links; bad cursors are 404', async () => {
    const page = dto('leaderboard/page-with-cursor');
    const id = page.snapshotId;
    serve(`/v1/ranking-snapshots/${id}`, {
      ...SNAP,
      snapshot: { ...SNAP.snapshot, snapshotId: id },
    });
    serve(`/v1/ranking-snapshots/${id}/leaderboard?${LIMIT}`, page);
    const first = await html(RankingSnapshotPage(props({ id }, {})));
    expect(first).toContain(`href="/ranking-snapshots/${id}?cursor=${page.nextCursor}"`);
    expect(first).not.toContain('First page');

    serve(`/v1/ranking-snapshots/${id}/leaderboard?cursor=${page.nextCursor}&${LIMIT}`, {
      ...page,
      nextCursor: undefined,
    });
    const second = await html(RankingSnapshotPage(props({ id }, { cursor: page.nextCursor })));
    expect(requested).toContain(
      `/v1/ranking-snapshots/${id}/leaderboard?cursor=${page.nextCursor}&${LIMIT}`,
    );
    expect(second).toContain(`href="/ranking-snapshots/${id}">First page`);
    expect(second).not.toContain('Next page');

    // Well-formed but undecodable: the API's 400 is a missing page, never the first page.
    const bad = errorOf('error/invalid-cursor');
    serve(`/v1/ranking-snapshots/${id}/leaderboard?cursor=AAAA&${LIMIT}`, bad.body, bad.status);
    is404(await control(RankingSnapshotPage(props({ id }, { cursor: 'AAAA' }))));
    requested = [];
    is404(await control(RankingSnapshotPage(props({ id }, { cursor: 'a/b' }))));
    is404(await control(RankingSnapshotPage(props({ id }, { cursor: ['a', 'b'] }))));
    is404(await control(RankingSnapshotPage(props({ id: 'not-a-uuid' }, {}))));
    expect(requested).toEqual([]);
  });

  it('no client-side re-ranking or number parsing: rows and exact decimal marks are copied in API order', async () => {
    const lb = dto('leaderboard/shared-ties-private-and-team');
    // A deliberately non-monotonic page: a re-sorting client would reorder it; the web must not.
    const odd = ['0.30000000000000004441', '9.580', '1000000000000000000001'];
    const entries = [...lb.entries]
      .reverse()
      .map((e: { value: Record<string, unknown> }, i: number) => ({
        ...e,
        value: { ...e.value, value: odd[i], unit: 's', display: `${odd[i]} s` },
      }));
    serve(`/v1/ranking-snapshots/${SID}`, SNAP);
    serve(lbPath(), { ...lb, entries });
    const h = await html(RankingSnapshotPage(props({ id: SID }, {})));
    expect(rowsOf(h)).toEqual([
      [3, false],
      [1, true],
      [1, true],
    ]);
    expect(valuesOf(h)).toEqual(odd.map((x) => `${x} s`));
  });

  it('unknown snapshot is 404; API failure or projection mismatch is "unavailable", never data', async () => {
    is404(await control(RankingSnapshotPage(props({ id: SID }, {}))));
    const mm = errorOf('error/projection-mismatch');
    serve(`/v1/ranking-snapshots/${SID}`, SNAP);
    serve(lbPath(), mm.body, mm.status);
    const h = await html(RankingSnapshotPage(props({ id: SID }, {})));
    expect(h).toContain('Temporarily unavailable');
    expect(h).not.toContain('PROJECTION_MISMATCH');
    routes.set(`/v1/ranking-snapshots/${SID}`, 'network-error');
    expect(await html(RankingSnapshotPage(props({ id: SID }, {})))).toContain(
      'Temporarily unavailable',
    );
  });
});

describe('classification (a derived ResultVersion)', () => {
  const rowsPath = (q = LIMIT) => `/v1/result-versions/${RV}/classification/entries?${q}`;

  it('public @2 card + rows: status, provenance header, shared ranks and tie-break values as derived', async () => {
    const rows = dto('classificationEntries/shared-rank');
    serve(`/v1/result-versions/${RV}/classification`, CLS);
    serve(rowsPath(), rows);
    const h = await html(ClassificationPage(props({ id: RV }, {})));
    expect(requested.sort()).toEqual(
      [`/v1/result-versions/${RV}/classification`, rowsPath()].sort(),
    );
    const k = CLS.classification;
    expect(h).toContain(k.status);
    expect(h).toContain(k.contentHash);
    expect(h).toContain(k.provenance.inputsDigest);
    expect(h).toContain(k.provenance.policy.specHash);
    expect(h).toContain('Current at read time');
    expect(rowsOf(h)).toEqual([
      [1, false],
      [2, true],
      [2, true],
    ]);
    for (const e of rows.entries)
      for (const t of e.tieBreakKeys) expect(h).toContain(`${t.value} (${t.order})`);
    expect(h).toContain('Private entrant');
    // Participant ids are row keys only; the page never prints them.
    for (const e of rows.entries) expect(h).not.toContain(e.participantId);
  });

  it('STALE under the pinned policy: reasons only — no derivedFrom pins, staleness document or digest', async () => {
    const v = vector('classification/stale-topology-omitted');
    const c = JSON.parse(v.canonicalText);
    const id = c.classification.resultVersionId;
    serve(`/v1/result-versions/${id}/classification`, c);
    serve(
      `/v1/result-versions/${id}/classification/entries?${LIMIT}`,
      dto('classificationEntries/shared-rank'),
    );
    const h = await html(ClassificationPage(props({ id }, {})));
    expect(h).toContain('Stale at read time');
    for (const r of c.readTime.staleness.reasons) expect(h).toContain(`<code>${r}</code>`);
    expect(hiddenIn(v).length).toBeGreaterThan(0);
    for (const hidden of hiddenIn(v)) expect(h).not.toContain(hidden);
  });

  it('not public (@1, SUBMITTED, REJECTED, REVOKED, unknown) is a plain 404 — no fallback card', async () => {
    const nf = errorOf('error/classification-not-found');
    serve(`/v1/result-versions/${RV}/classification`, nf.body, nf.status);
    serve(rowsPath(), nf.body, nf.status);
    is404(await control(ClassificationPage(props({ id: RV }, {}))));
    requested = [];
    is404(await control(ClassificationPage(props({ id: 'nope' }, {}))));
    expect(requested).toEqual([]);
  });

  it('entries pagination passes the cursor through and links the next page', async () => {
    serve(`/v1/result-versions/${RV}/classification`, CLS);
    serve(rowsPath('cursor=Zm9v&limit=50'), {
      ...dto('classificationEntries/shared-rank'),
      nextCursor: 'YmFy',
    });
    const h = await html(ClassificationPage(props({ id: RV }, { cursor: 'Zm9v' })));
    expect(h).toContain(`href="/result-versions/${RV}/classification?cursor=YmFy"`);
    expect(h).toContain(`href="/result-versions/${RV}/classification">First page`);
  });
});

/** Every id / hash the composer received but deliberately dropped from the public DTO. */
function hiddenIn(v: Vector): string[] {
  const tokens = JSON.stringify(v.input).match(/[0-9a-f]{8}-[0-9a-f-]{27}|sha256:[0-9a-f]{64}/g);
  return [...new Set(tokens ?? [])].filter((t) => !v.canonicalText.includes(t));
}

describe('privacy / leak scan over every rendered surface', () => {
  const FORBIDDEN = [
    /br_/,
    /\bSELECT\b/,
    /INSERT INTO/,
    /\bpg_/,
    /staleDigest/i,
    /runId|run_id|ranking-runs/i,
    /accountId|account_id/i,
    /ownerPrincipalId|owner_id|anchorId/i,
    /derivedFrom|notCurrent|verificationRunId|resultVersionIds/,
    /ranking_read|ranking\.snapshot|results\.classification/,
    /42501/,
  ];

  it('no internal topology, role, SQL, account / owner / run id or hidden pin reaches the HTML', async () => {
    // Each rendered page with the vectors it was served: hidden tokens are judged per page, because
    // the corpus reuses placeholder hashes that are dropped in one DTO and legitimately public in another.
    const pages: { html: string; vectors: string[] }[] = [];
    const LB = 'leaderboard/shared-ties-private-and-team';
    const ROWS = 'classificationEntries/shared-rank';
    serve(`/v1/ranking-systems?${LIMIT}`, dto('systemList/page-with-cursor'));
    pages.push({
      html: await html(RankingSystemsPage(props({}, {}))),
      vectors: ['systemList/page-with-cursor'],
    });
    for (const sys of [
      'system/platform-published',
      'system/official-owner-publication-unavailable',
      'system/retired-team',
    ]) {
      const s = dto(sys);
      serve(`/v1/ranking-systems/${s.code}`, s);
      pages.push({
        html: await html(RankingSystemPage(props({ system: s.code }))),
        vectors: [sys],
      });
      for (const name of [
        'history/as-published-keeps-every-snapshot',
        'history/as-corrected-replaces-corrected',
      ]) {
        const hist = dto(name);
        serve(`/v1/ranking-systems/${s.code}/snapshots?view=${hist.view}&${LIMIT}`, hist);
        pages.push({
          html: await html(SnapshotHistoryPage(props({ system: s.code }, { view: hist.view }))),
          vectors: [sys, name],
        });
      }
    }
    for (const name of [
      'snapshot/current',
      'snapshot/stale-topology-omitted',
      'snapshot/correction-lineage',
    ]) {
      const s = dto(name);
      const id = s.snapshot.snapshotId;
      serve(`/v1/ranking-snapshots/${id}`, s);
      serve(`/v1/ranking-snapshots/${id}/leaderboard?${LIMIT}`, dto(LB));
      pages.push({ html: await html(RankingSnapshotPage(props({ id }, {}))), vectors: [name, LB] });
    }
    for (const name of ['classification/current', 'classification/stale-topology-omitted']) {
      const c = dto(name);
      const id = c.classification.resultVersionId;
      serve(`/v1/result-versions/${id}/classification`, c);
      serve(`/v1/result-versions/${id}/classification/entries?${LIMIT}`, dto(ROWS));
      pages.push({
        html: await html(ClassificationPage(props({ id }, {}))),
        vectors: [name, ROWS],
      });
    }
    // The private athlete's holder id is in the leaderboard input and must never be rendered.
    expect(hiddenIn(vector(LB))).toContain('00000000-0000-4000-8000-0000000000ca');
    const staff = dto('staffRun/blocked-with-blockers');
    for (const p of pages) {
      const served = p.vectors.map((n) => vector(n).canonicalText).join('');
      const hidden = p.vectors
        .flatMap((n) => hiddenIn(vector(n)))
        .filter((t) => !served.includes(t));
      for (const f of FORBIDDEN) expect(p.html).not.toMatch(f);
      for (const t of hidden) expect(p.html).not.toContain(t);
      expect(p.html).not.toContain('br:'); // DTO schema tags are not page content
      expect(p.html).not.toContain(staff.run.runId);
    }
    // No public page ever calls a staff / internal route.
    expect(requested.some((r) => r.includes('/internal/') || r.includes('proposal'))).toBe(false);
  });
});

describe('getPublic (existing pages unchanged)', () => {
  it('a 400 is "unavailable" by default and "not_found" only when the caller opts in', async () => {
    serve('/v1/x', { error: { code: 'INVALID_INPUT' } }, 400);
    expect(await getPublic('/v1/x')).toEqual({ kind: 'unavailable' });
    expect(await getPublic('/v1/x', { badRequestIsNotFound: true })).toEqual({
      kind: 'not_found',
    });
    serve('/v1/y', { error: {} }, 500);
    expect(await getPublic('/v1/y', { badRequestIsNotFound: true })).toEqual({
      kind: 'unavailable',
    });
  });
});
