// ONCHAINFEST-LEGAL-01/06 · Legal hub checks (node:test, no dependencies): output set, links,
// localization, accessibility basics, document relationships, the draft/approval model and
// isolation from the www.onchainfest.xyz deployment.
//
//   node --test legal/test/*.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSite, renderSite } from '../src/build.mjs';
import { DOCUMENTS } from '../src/documents.mjs';
import { UI } from '../src/i18n.mjs';
import { PRODUCTS } from '../src/products.mjs';
import { CORPORATE_SITE, COMPANY, LOCALES, REVIEW, SITE_ORIGIN } from '../src/site.mjs';
import { publishBlockers, validateDocuments } from '../src/validate.mjs';

const LEGAL_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = join(LEGAL_DIR, '..');
const { files, blockers } = renderSite();
const VERCEL_CONFIG = JSON.parse(readFileSync(join(LEGAL_DIR, 'vercel.json'), 'utf8'));
const pages = [...files].filter(([file]) => file.endsWith('.html'));

const attrs = (html, tag, attr) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1]);
const hrefs = (html) => attrs(html, 'a', 'href');
const ids = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const canonical = (html) => html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
const mainText = (html) =>
  html
    .match(/<main[\s\S]*<\/main>/)[0]
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * The output file a hub URL path is served from, or null for an unknown path. As on Vercel with
 * cleanUrls: `<name>.html` is served at `/<name>` only, so index.html is at /index, never at /,
 * unless a vercel.json rewrite maps / to it (LEGAL-05 deployed / as a 404). The deploy side checks
 * the same thing on the real build output (.github/legal-hub/artifact.py check-output).
 */
function resolve(path) {
  if (path.startsWith('/assets/')) {
    return existsSync(join(LEGAL_DIR, 'assets', path.slice('/assets/'.length))) ? path : null;
  }
  const target = VERCEL_CONFIG.rewrites?.find((r) => r.source === path)?.destination ?? path;
  const file = `${target.slice(1)}.html`;
  return files.has(file) ? file : null;
}

const EXTERNAL_ALLOWED = new Set([
  CORPORATE_SITE,
  `mailto:${COMPANY.contactEmail}`,
  ...PRODUCTS.flatMap((p) => [
    p.website,
    `mailto:${p.supportEmail}`,
    ...p.documents.map((d) => d.href),
  ]),
]);

describe('output', () => {
  it('builds exactly the four routes in every locale, plus 404 and robots.txt', () => {
    assert.deepEqual([...files.keys()].sort(), [
      '404.html',
      'es.html',
      'es/privacy.html',
      'es/products/listalaboda.html',
      'es/terms.html',
      'index.html',
      'privacy.html',
      'products/listalaboda.html',
      'robots.txt',
      'terms.html',
    ]);
  });

  it('marks every page as the legal hub and never ships a script or unresolved syntax', () => {
    for (const [file, html] of pages) {
      assert.match(html, /<meta name="oncf-site" content="legal-hub" \/>/, file);
      assert.doesNotMatch(html, /<script/i, file);
      assert.doesNotMatch(html, /\{\{|\*\*|\]\(/, file);
    }
  });

  it('writes the files and the assets to disk', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'legal-hub-'));
    try {
      await buildSite({ outDir });
      for (const file of [
        ...files.keys(),
        'assets/legal.css',
        'assets/logo.png',
        'assets/favicon.ico',
      ]) {
        assert.ok(existsSync(join(outDir, file)), file);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('links', () => {
  it('resolves every internal link, asset and fragment', () => {
    for (const [file, html] of pages) {
      const targets = [
        ...hrefs(html),
        ...attrs(html, 'link', 'href'),
        ...attrs(html, 'img', 'src'),
      ];
      for (const href of targets.filter((h) => h.startsWith('/') || h.startsWith('#'))) {
        const [path, fragment] = href.split('#');
        const target = path === '' ? file : resolve(path);
        assert.ok(target, `${file}: ${href} does not resolve`);
        if (fragment) {
          assert.ok(ids(files.get(target)).has(fragment), `${file}: ${href} has no #${fragment}`);
        }
      }
    }
  });

  it('links outside the hub only to the corporate site, verified contacts and product documents', () => {
    for (const [file, html] of pages) {
      for (const href of hrefs(html).filter((h) => !h.startsWith('/') && !h.startsWith('#'))) {
        assert.ok(EXTERNAL_ALLOWED.has(href), `${file}: unexpected external link ${href}`);
      }
    }
  });

  it('declares reciprocal canonical and hreflang URLs on the hub origin', () => {
    for (const [file, html] of pages.filter(([f]) => f !== '404.html')) {
      assert.ok(canonical(html)?.startsWith(SITE_ORIGIN), file);
      const alternates = [...html.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)];
      assert.deepEqual(
        alternates.map((m) => m[1]),
        [...LOCALES, 'x-default'],
        file,
      );
      for (const [, , url] of alternates) {
        const target = resolve(url.slice(SITE_ORIGIN.length) || '/');
        assert.ok(target, `${file}: alternate ${url} does not resolve`);
        assert.equal(canonical(files.get(target)), url, `${file}: ${url} is not reciprocal`);
      }
    }
  });
});

describe('localization', () => {
  it('defines every interface string in every locale', () => {
    const keys = Object.keys(UI[LOCALES[0]]).sort();
    for (const locale of LOCALES) assert.deepEqual(Object.keys(UI[locale]).sort(), keys, locale);
  });

  it('labels every review marker in every locale', () => {
    for (const [key, labels] of Object.entries(REVIEW)) {
      for (const locale of LOCALES) assert.ok(labels[locale], `${key}.${locale}`);
    }
  });

  it('sets the page language and links the language switcher to the same page', () => {
    for (const [file, html] of pages.filter(([f]) => f !== '404.html')) {
      const lang = html.match(/<html lang="([^"]+)">/)[1];
      assert.equal(lang, file.startsWith('es') ? 'es' : 'en', file);
      const switcher = html.match(/<nav class="lang"[\s\S]*?<\/nav>/)[0];
      const other = LOCALES.find((l) => l !== lang);
      const href = switcher.match(/<a href="([^"]+)" hreflang="([^"]+)"/);
      assert.equal(href[2], other, file);
      const alternate = html.match(new RegExp(`hreflang="${other}" href="([^"]+)"`))[1];
      assert.equal(SITE_ORIGIN + href[1], alternate, file);
    }
  });
});

describe('accessibility basics', () => {
  for (const [file, html] of pages) {
    it(file, () => {
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
      assert.match(html, /<title>[^<]+<\/title>/);
      assert.match(html, /<a class="skip" href="#main">/);
      assert.match(html, /<main id="main"/);
      assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, 'exactly one h1');
      for (const nav of html.match(/<nav\b[^>]*>/g)) assert.match(nav, /aria-label="[^"]+"/);
      for (const img of html.match(/<img\b[^>]*>/g) ?? []) assert.match(img, /\salt="/);
      const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
      levels.slice(1).forEach((level, i) => assert.ok(level <= levels[i] + 1, 'heading skip'));
    });
  }

  it('gives every page a unique title', () => {
    const titles = pages.map(([, html]) => html.match(/<title>([^<]+)<\/title>/)[1]);
    assert.equal(new Set(titles).size, titles.length);
  });
});

describe('document relationships', () => {
  for (const locale of LOCALES) {
    const prefix = locale === 'en' ? '' : `${locale}/`;
    const home = files.get(locale === 'en' ? 'index.html' : `${locale}.html`);
    const homePath = locale === 'en' ? '' : `/${locale}`;

    it(`${locale}: the overview lists both corporate policies and every product`, () => {
      for (const doc of DOCUMENTS)
        assert.ok(hrefs(home).includes(`${homePath}${doc.path}`), doc.id);
      for (const p of PRODUCTS) {
        assert.ok(hrefs(home).includes(`${homePath}/products/${p.slug}`), p.slug);
      }
    });

    it(`${locale}: corporate policies point to the product directory`, () => {
      for (const doc of DOCUMENTS) {
        const html = files.get(`${prefix}${doc.path.slice(1)}.html`);
        assert.ok(hrefs(html).includes(`${homePath || '/'}#products`.replace('//', '/')), doc.id);
      }
    });

    it(`${locale}: each product page links its canonical documents and the corporate ones`, () => {
      for (const p of PRODUCTS) {
        const html = files.get(`${prefix}products/${p.slug}.html`);
        for (const d of p.documents) assert.ok(hrefs(html).includes(d.href), d.href);
        for (const doc of DOCUMENTS) assert.ok(hrefs(html).includes(`${homePath}${doc.path}`));
        assert.match(html, new RegExp(`<dd>${p.operator}</dd>`));
        // A directory entry, not a copy of the product's documents.
        assert.ok(mainText(html).length < 250, `${p.slug} reproduces content`);
      }
    });
  }

  it('links ListaLaBoda to its canonical Terms and privacy policy', () => {
    const listalaboda = PRODUCTS.find((p) => p.slug === 'listalaboda');
    const documentHrefs = listalaboda.documents.map((d) => d.href);
    assert.ok(documentHrefs.includes('https://listalaboda.com/terminos'));
    assert.ok(documentHrefs.includes('https://listalaboda.com/privacidad'));
  });
});


describe('verified corporate formation facts', () => {
  it('records formation facts without claiming a current notice address or agent', () => {
    assert.equal(COMPANY.formation.jurisdiction, 'Wyoming, United States');
    assert.equal(COMPANY.formation.date, '2025-07-18');
    assert.equal(COMPANY.formation.filingId, '2025-001725151');
    assert.equal(COMPANY.formation.originalRegisteredAgent, 'Registered Agents Inc');
    assert.equal(COMPANY.formation.originalAddress, '30 N Gould St, Ste R, Sheridan, WY 82801');
    assert.equal(COMPANY.address, null);
    for (const locale of LOCALES) {
      const prefix = locale === 'en' ? '' : 'es/';
      for (const doc of DOCUMENTS) {
        const html = files.get(`${prefix}${doc.path.slice(1)}.html`);
        assert.match(html, /2025-001725151/);
        assert.match(html, /Registered Agents Inc/);
        assert.match(html, /30 N Gould St/);
        assert.match(html, /class="review"/);
      }
    }
  });

  it('does not claim that every product already has its own legal documents', () => {
    for (const doc of DOCUMENTS) {
      for (const locale of LOCALES) {
        const paragraphs = doc.content[locale].sections
          .flatMap((section) => section.body)
          .filter((x) => typeof x === 'string');
        const text = [doc.content[locale].summary, ...paragraphs].join(' ');
        assert.doesNotMatch(text, /Each product has its own|Cada producto tiene su propi[oa]/i);
      }
    }
  });
});

describe('draft and approval model', () => {
  const approved = (overrides = {}) => ({
    ...DOCUMENTS[0],
    status: 'approved',
    version: '1.0.0',
    effectiveDate: '2027-01-01',
    content: {
      en: { ...DOCUMENTS[0].content.en, sections: [{ id: 'a', heading: 'A', body: ['Final.'] }] },
      es: { ...DOCUMENTS[0].content.es, sections: [{ id: 'a', heading: 'A', body: ['Final.'] }] },
    },
    ...overrides,
  });

  it('accepts the current drafts', () => {
    assert.deepEqual(validateDocuments(DOCUMENTS), []);
  });

  it('accepts an approved document with a date, semver and no open markers', () => {
    assert.deepEqual(validateDocuments([approved()]), []);
  });

  it('refuses to approve a document that still has review markers', () => {
    const doc = approved({ content: DOCUMENTS[0].content });
    assert.match(validateDocuments([doc]).join(), /open review markers/);
  });

  it('refuses an approved document without an effective date or with a draft version', () => {
    assert.match(validateDocuments([approved({ effectiveDate: null })]).join(), /effective date/);
    assert.match(validateDocuments([approved({ version: '1.0.0-draft' })]).join(), /semver/);
  });

  it('refuses an effective date on a draft', () => {
    const doc = { ...DOCUMENTS[0], effectiveDate: '2027-01-01' };
    assert.match(validateDocuments([doc]).join(), /a draft has no effective date/);
  });

  it('refuses locales with different sections', () => {
    const doc = approved();
    doc.content.es = { ...doc.content.es, sections: [{ id: 'b', heading: 'B', body: ['x'] }] };
    assert.match(validateDocuments([doc]).join(), /differ/);
  });

  it('shows every draft as not in effect, with its version and a draft banner', () => {
    for (const locale of LOCALES) {
      const prefix = locale === 'en' ? '' : `${locale}/`;
      for (const doc of DOCUMENTS.filter((d) => d.status === 'draft')) {
        const html = files.get(`${prefix}${doc.path.slice(1)}.html`);
        assert.ok(html.includes(UI[locale].draftBannerTitle), `${locale} ${doc.id}`);
        assert.ok(html.includes(UI[locale].notInEffect), `${locale} ${doc.id}`);
        assert.ok(html.includes(doc.version), `${locale} ${doc.id}`);
      }
    }
  });

  it('renders every open review marker visibly', () => {
    for (const [file, html] of pages.filter(
      ([f]) => f.includes('terms') || f.includes('privacy'),
    )) {
      assert.ok(html.includes('class="review"'), file);
    }
  });

  it('keeps the hub unindexed and refuses a production build while anything is open', async () => {
    assert.ok(blockers.length > 0);
    assert.deepEqual(blockers, publishBlockers(DOCUMENTS, ['ADDRESS']));
    assert.equal(files.get('robots.txt'), 'User-agent: *\nDisallow: /\n');
    for (const [file, html] of pages) assert.match(html, /content="noindex, nofollow"/, file);
    const config = JSON.parse(readFileSync(join(LEGAL_DIR, 'vercel.json'), 'utf8'));
    const robotsHeader = config.headers[0].headers.find((h) => h.key === 'X-Robots-Tag');
    assert.equal(robotsHeader?.value, 'noindex, nofollow');
    await assert.rejects(
      buildSite({ outDir: join(tmpdir(), 'legal-hub-never-written'), requirePublishable: true }),
      /not publishable as final/,
    );
  });
});

describe('deployment isolation', () => {
  const vercelIgnored = (path) => {
    try {
      const out = execFileSync(
        'git',
        [
          '-c',
          `core.excludesFile=${join(REPO_DIR, '.vercelignore')}`,
          'check-ignore',
          '--no-index',
          '-v',
          path,
        ],
        { cwd: REPO_DIR, encoding: 'utf8' },
      );
      // "<source>:<line>:<pattern>\t<path>": ignored unless the last matching pattern negates.
      const [match] = out.split('\t');
      return match.includes('.vercelignore:') && !match.split(':').at(-1).startsWith('!');
    } catch {
      return false;
    }
  };

  it('keeps the legal hub and its workflow out of the www.onchainfest.xyz upload', () => {
    for (const path of [
      'legal/vercel.json',
      'legal/src/render.mjs',
      'legal/assets/legal.css',
      'legal/dist/index.html',
      '.github/workflows/legal-hub.yml',
    ]) {
      assert.ok(vercelIgnored(path), `${path} would be uploaded with the website`);
    }
    assert.ok(!vercelIgnored('index.html'), 'sanity: the website itself is still uploaded');
  });

  it('serves the home page at / through the only rewrite (cleanUrls has no / route)', () => {
    assert.deepEqual(VERCEL_CONFIG.rewrites, [{ source: '/', destination: '/index' }]);
    assert.equal(VERCEL_CONFIG.trailingSlash, false);
    const routes = {
      '/': 'index.html',
      '/terms': 'terms.html',
      '/privacy': 'privacy.html',
      '/products/listalaboda': 'products/listalaboda.html',
      '/es': 'es.html',
      '/es/terms': 'es/terms.html',
      '/es/privacy': 'es/privacy.html',
      '/es/products/listalaboda': 'es/products/listalaboda.html',
      '/nope': null,
      '/es/nope': null,
      '/products/unknown': null,
      '/terms.html': null,
    };
    for (const [path, file] of Object.entries(routes)) assert.equal(resolve(path), file, path);
    // The rewrite targets /index, which cleanUrls redirects only when requested directly, and
    // the home page links to / (not /index), so nothing loops.
    for (const [, html] of pages) assert.doesNotMatch(html, /href="\/index(\.html)?"/);
  });

  it('builds a static site with its own config', () => {
    const config = JSON.parse(readFileSync(join(LEGAL_DIR, 'vercel.json'), 'utf8'));
    assert.equal(config.framework, null);
    assert.equal(config.buildCommand, 'node scripts/build.mjs');
    assert.equal(config.outputDirectory, 'dist');
    assert.equal(config.cleanUrls, true);
    const csp = config.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src|unsafe-inline/);
  });
});
