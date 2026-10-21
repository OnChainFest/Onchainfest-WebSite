// ONCHAINFEST-LEGAL-01 · Renders the whole hub into a map of output files.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DOCUMENTS } from './documents.mjs';
import { PRODUCTS } from './products.mjs';
import {
  documentPage,
  fileForPath,
  homePage,
  localePath,
  notFoundPage,
  productPage,
} from './render.mjs';
import { LOCALES, companyOpenMarkers } from './site.mjs';
import { publishBlockers, validateDocuments } from './validate.mjs';

export const ASSETS_DIR = new URL('../assets/', import.meta.url);

/** { files: Map<relative path, contents>, blockers: string[] } — throws on invalid content. */
export function renderSite() {
  const errors = validateDocuments(DOCUMENTS);
  if (errors.length > 0) throw new Error(`Invalid legal content:\n- ${errors.join('\n- ')}`);

  const blockers = publishBlockers(DOCUMENTS, companyOpenMarkers());
  const indexable = blockers.length === 0;
  const files = new Map();
  const page = (locale, path, html) => files.set(fileForPath(localePath(locale, path)), html);

  for (const locale of LOCALES) {
    page(locale, '/', homePage({ locale, products: PRODUCTS, indexable }));
    for (const doc of DOCUMENTS) page(locale, doc.path, documentPage({ doc, locale, indexable }));
    for (const product of PRODUCTS) {
      page(locale, `/products/${product.slug}`, productPage({ product, locale, indexable }));
    }
  }
  files.set('404.html', notFoundPage());
  // Crawlers stay out until every document is approved and no review marker is left.
  files.set('robots.txt', indexable ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');
  return { files, blockers };
}

/**
 * Writes the hub to `outDir` (emptied first). With `requirePublishable`, refuses to build while
 * anything is still a draft or pending review — the production gate.
 */
export async function buildSite({ outDir, requirePublishable = false }) {
  const { files, blockers } = renderSite();
  if (requirePublishable && blockers.length > 0) {
    throw new Error(
      `The legal hub is not publishable as final yet:\n- ${blockers.join('\n- ')}\n` +
        'Approve the documents (status, version, effective date) and resolve every review marker first.',
    );
  }
  await rm(outDir, { recursive: true, force: true });
  for (const [file, contents] of files) {
    const target = join(outDir, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await cp(ASSETS_DIR, join(outDir, 'assets'), { recursive: true });
  return { files: [...files.keys()], blockers };
}
