// ONCHAINFEST-LEGAL-01 · HTML rendering. Static output, no client-side JavaScript.

import { DOCUMENTS } from './documents.mjs';
import { UI } from './i18n.mjs';
import {
  COMPANY,
  COPYRIGHT_YEAR,
  CORPORATE_SITE,
  DEFAULT_LOCALE,
  LOCALES,
  SITE_ORIGIN,
  reviewLabel,
} from './site.mjs';

/** Present on every page the hub builds; the deploy workflow refuses an artifact without it. */
export const SITE_MARKER = '<meta name="oncf-site" content="legal-hub" />';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** The URL path of a hub path in a locale: /terms → /es/terms, / → /es, /#products → /es#products. */
export function localePath(locale, target) {
  const [path, hash] = target.split('#');
  const localized =
    locale === DEFAULT_LOCALE ? path : path === '/' ? `/${locale}` : `/${locale}${path}`;
  return hash === undefined ? localized : `${localized}#${hash}`;
}

/** The output file that serves a URL path (Vercel cleanUrls). */
export const fileForPath = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}.html`);

export function formatDate(iso, locale) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    timeZone: 'UTC',
    dateStyle: 'long',
  });
}

function reviewCallout(key, locale) {
  return (
    `<div class="review" role="note"><p class="review-tag">${escapeHtml(UI[locale].reviewLabel)}</p>` +
    `<p>${escapeHtml(reviewLabel(key, locale))}</p></div>`
  );
}

function link(href, label, locale) {
  if (href.startsWith('~/')) return `<a href="${localePath(locale, href.slice(1))}">${label}</a>`;
  return `<a href="${href}">${label}</a>`;
}

function inline(text, locale) {
  const substituted = text
    .replaceAll('{{company}}', COMPANY.legalName)
    .replaceAll('{{contactEmail}}', COMPANY.contactEmail);
  return escapeHtml(substituted)
    .replace(
      /\{\{review:([A-Z_]+)\}\}/g,
      (_, key) =>
        `<span class="review-inline"><span class="review-tag">${escapeHtml(UI[locale].reviewLabel)}:</span> ` +
        `${escapeHtml(reviewLabel(key, locale))}</span>`,
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => link(href, label, locale));
}

function block(content, locale) {
  if (typeof content !== 'string') {
    return `<ul>${content.list.map((item) => `<li>${inline(item, locale)}</li>`).join('')}</ul>`;
  }
  const onlyMarker = content.match(/^\{\{review:([A-Z_]+)\}\}$/);
  return onlyMarker ? reviewCallout(onlyMarker[1], locale) : `<p>${inline(content, locale)}</p>`;
}

function documentMeta(doc, locale) {
  const ui = UI[locale];
  const rows = [
    [ui.version, escapeHtml(doc.version)],
    [ui.status, doc.status === 'approved' ? ui.statusApproved : ui.statusDraft],
    [ui.effectiveDate, doc.effectiveDate ? formatDate(doc.effectiveDate, locale) : ui.notInEffect],
  ];
  if (doc.status === 'draft') rows.push([ui.draftPrepared, formatDate(doc.draftPrepared, locale)]);
  return `<dl class="meta">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

const NAV = [
  { key: 'home', path: '/', label: 'navHome' },
  { key: 'terms', path: '/terms', label: 'navTerms' },
  { key: 'privacy', path: '/privacy', label: 'navPrivacy' },
  { key: 'products', path: '/#products', label: 'navProducts' },
];

function layout({ locale, path, title, description, body, current, indexable }) {
  const ui = UI[locale];
  const head = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)} · OnChainFest LLC</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    SITE_MARKER,
    `<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, nofollow'}" />`,
    '<meta name="theme-color" content="#050608" />',
    '<link rel="icon" href="/assets/favicon.ico" type="image/x-icon" />',
    '<link rel="stylesheet" href="/assets/legal.css" />',
  ];
  if (path !== null) {
    head.push(`<link rel="canonical" href="${SITE_ORIGIN}${localePath(locale, path)}" />`);
    for (const l of LOCALES) {
      head.push(
        `<link rel="alternate" hreflang="${l}" href="${SITE_ORIGIN}${localePath(l, path)}" />`,
      );
    }
    head.push(
      `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${localePath(DEFAULT_LOCALE, path)}" />`,
    );
  }

  const nav = NAV.map(({ key, path: target, label }) => {
    // A product page sits under the directory: "current section", not "current page".
    const currentAttr =
      key !== current ? '' : key === 'products' ? ' aria-current="true"' : ' aria-current="page"';
    return `<li><a href="${localePath(locale, target)}"${currentAttr}>${ui[label]}</a></li>`;
  }).join('');

  const languages = LOCALES.map((l) => {
    const name = escapeHtml(UI[l].languageName);
    if (l === locale) return `<li><span aria-current="true" lang="${l}">${name}</span></li>`;
    const href = localePath(l, path ?? '/');
    return `<li><a href="${href}" hreflang="${l}" lang="${l}">${name}</a></li>`;
  }).join('');

  return `<!doctype html>
<html lang="${locale}">
<head>
${head.join('\n')}
</head>
<body>
<a class="skip" href="#main">${ui.skip}</a>
<header class="site-header">
<div class="wrap header-row">
<a class="brand" href="${localePath(locale, '/')}"><span class="brand-mark"><img src="/assets/logo.png" width="40" height="40" alt="" /></span><span class="brand-copy"><strong>OnChainFest LLC</strong><span>${ui.brandTag}</span></span></a>
<nav class="site-nav" aria-label="${ui.navLabel}"><ul>${nav}</ul></nav>
<nav class="lang" aria-label="${ui.languageLabel}"><ul>${languages}</ul></nav>
</div>
</header>
<main id="main" tabindex="-1">
<div class="wrap">
${body}
</div>
</main>
<footer class="site-footer">
<div class="wrap footer-row">
<p>© ${COPYRIGHT_YEAR} ${COMPANY.legalName}. ${ui.footerRights}</p>
<ul>
<li><a href="${localePath(locale, '/terms')}">${ui.navTerms}</a></li>
<li><a href="${localePath(locale, '/privacy')}">${ui.navPrivacy}</a></li>
<li><a href="${CORPORATE_SITE}">onchainfest.xyz</a></li>
</ul>
</div>
</footer>
</body>
</html>
`;
}

function factRow(label, value) {
  return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
}

export function homePage({ locale, products, indexable }) {
  const ui = UI[locale];
  const docs = DOCUMENTS.map((doc) => {
    const c = doc.content[locale];
    return `<li class="card"><h3><a href="${localePath(locale, doc.path)}">${escapeHtml(c.title)}</a></h3><p>${escapeHtml(c.summary)}</p>${documentMeta(doc, locale)}</li>`;
  }).join('');
  const productCards = products
    .map(
      (p) =>
        `<li class="card"><h3><a href="${localePath(locale, `/products/${p.slug}`)}">${escapeHtml(p.name)}</a></h3><p>${escapeHtml(p.summary[locale])}</p><p class="muted">${ui.productOperator} ${escapeHtml(p.operator)}</p></li>`,
    )
    .join('');
  const facts = [
    factRow(ui.companyLegalName, escapeHtml(COMPANY.legalName)),
    factRow(
      ui.companyRegistration,
      COMPANY.registration
        ? escapeHtml(COMPANY.registration[locale])
        : reviewCallout('REGISTRATION', locale),
    ),
    factRow(
      ui.companyAddress,
      COMPANY.address ? escapeHtml(COMPANY.address) : reviewCallout('ADDRESS', locale),
    ),
    factRow(
      ui.companyContact,
      `<a href="mailto:${COMPANY.contactEmail}">${COMPANY.contactEmail}</a>`,
    ),
    factRow(ui.companyWebsite, `<a href="${CORPORATE_SITE}">www.onchainfest.xyz</a>`),
  ].join('');

  const body = `<section class="hero">
<p class="kicker">OnChainFest LLC</p>
<h1>${ui.homeTitle}</h1>
<p class="lead">${ui.homeLead}</p>
</section>
<section class="block" aria-labelledby="corporate-heading">
<h2 id="corporate-heading">${ui.corporateHeading}</h2>
<p>${ui.corporateIntro}</p>
<ul class="cards">${docs}</ul>
</section>
<section class="block" id="products" aria-labelledby="products-heading">
<h2 id="products-heading">${ui.productsHeading}</h2>
<p>${ui.productsIntro}</p>
<ul class="cards">${productCards}</ul>
</section>
<section class="block" id="company" aria-labelledby="company-heading">
<h2 id="company-heading">${ui.companyHeading}</h2>
<dl class="facts">${facts}</dl>
</section>`;

  return layout({
    locale,
    path: '/',
    title: ui.homeTitle,
    description: ui.homeDescription,
    body,
    current: 'home',
    indexable,
  });
}

export function documentPage({ doc, locale, indexable }) {
  const ui = UI[locale];
  const c = doc.content[locale];
  const banner =
    doc.status === 'draft'
      ? `<div class="draft-banner" role="note"><p><strong>${ui.draftBannerTitle}</strong></p><p>${ui.draftBanner}</p></div>`
      : '';
  const toc = c.sections
    .map((s) => `<li><a href="#${s.id}">${escapeHtml(s.heading)}</a></li>`)
    .join('');
  const sections = c.sections
    .map(
      (s, i) =>
        `<section id="${s.id}" aria-labelledby="${s.id}-heading"><h2 id="${s.id}-heading"><span class="num">${i + 1}.</span> ${escapeHtml(s.heading)}</h2>${s.body.map((b) => block(b, locale)).join('')}</section>`,
    )
    .join('\n');

  const body = `<article class="doc">
<header class="doc-header">
<p class="kicker">OnChainFest LLC</p>
<h1>${escapeHtml(c.title)}</h1>
<p class="lead">${escapeHtml(c.summary)}</p>
<dl class="meta"><div><dt>${ui.appliesTo}</dt><dd>${escapeHtml(c.appliesTo)}</dd></div></dl>
${documentMeta(doc, locale)}
</header>
${banner}
<nav class="toc" aria-label="${ui.onThisPage}"><p class="toc-title">${ui.onThisPage}</p><ol>${toc}</ol></nav>
${sections}
</article>`;

  return layout({
    locale,
    path: doc.path,
    title: c.title,
    description: c.summary,
    body,
    current: doc.id,
    indexable,
  });
}

export function productPage({ product, locale, indexable }) {
  const ui = UI[locale];
  const corporate = DOCUMENTS.map(
    (doc) =>
      `<a href="${localePath(locale, doc.path)}">${escapeHtml(doc.content[locale].title)}</a>`,
  ).join(' · ');
  const documents = product.documents
    .map(
      (d) =>
        `<li><a class="external" href="${escapeHtml(d.href)}">${escapeHtml(d.title[locale])}<span class="visually-hidden"> ${ui.externalSuffix}</span></a><span class="url">${escapeHtml(d.href.replace(/^https:\/\//, ''))}</span></li>`,
    )
    .join('');
  const facts = [
    factRow(
      ui.productWebsite,
      `<a href="${escapeHtml(product.website)}">${escapeHtml(product.website.replace(/^https:\/\//, ''))}</a>`,
    ),
    factRow(ui.productOperator, escapeHtml(product.operator)),
    factRow(
      ui.productSupport,
      `<a href="mailto:${escapeHtml(product.supportEmail)}">${escapeHtml(product.supportEmail)}</a>`,
    ),
    factRow(ui.productLanguage, escapeHtml(product.documentsLanguage[locale])),
  ].join('');

  const body = `<article class="product">
<header class="doc-header">
<p class="kicker">${ui.productsHeading}</p>
<h1>${escapeHtml(product.name)}</h1>
<p class="lead">${escapeHtml(product.summary[locale])}</p>
</header>
<dl class="facts">${facts}</dl>
<section class="block" aria-labelledby="documents-heading">
<h2 id="documents-heading">${ui.productDocuments}</h2>
<ul class="doc-links">${documents}</ul>
<p>${ui.productAuthoritative}</p>
</section>
<aside class="note"><p>${ui.productRelationship}</p><p>${corporate}</p></aside>
<p><a class="back" href="${localePath(locale, '/#products')}">← ${ui.backToHub}</a></p>
</article>`;

  return layout({
    locale,
    path: `/products/${product.slug}`,
    title: `${product.name} — ${ui.viewProduct}`,
    description: product.summary[locale],
    body,
    current: 'products',
    indexable,
  });
}

/** One bilingual 404 page (Vercel serves /404.html for unknown paths). */
export function notFoundPage() {
  const [primary, ...others] = LOCALES;
  const parts = [primary, ...others]
    .map(
      (l) =>
        `<section lang="${l}" class="block"><h${l === primary ? 1 : 2}>${UI[l].notFoundTitle}</h${l === primary ? 1 : 2}><p>${UI[l].notFoundBody}</p><p><a href="${localePath(l, '/')}">${UI[l].backToHub}</a></p></section>`,
    )
    .join('');
  return layout({
    locale: primary,
    path: null,
    title: UI[primary].notFoundTitle,
    description: UI[primary].notFoundBody,
    body: parts,
    current: null,
    indexable: false,
  });
}
