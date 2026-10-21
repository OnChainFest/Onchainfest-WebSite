// ONCHAINFEST-LEGAL-01 · Consistency and publishability rules for the hub content.

import { LOCALES, REVIEW } from './site.mjs';

const REVIEW_TOKEN = /\{\{review:([A-Z_]+)\}\}/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DRAFT_VERSION = /^\d+\.\d+\.\d+-draft$/;
const FINAL_VERSION = /^\d+\.\d+\.\d+$/;

/** Every review marker key used anywhere in a document, across all locales. */
export function reviewKeys(document) {
  const keys = new Set();
  for (const locale of LOCALES) {
    for (const text of paragraphs(document.content[locale])) {
      for (const [, key] of text.matchAll(REVIEW_TOKEN)) keys.add(key);
    }
  }
  return keys;
}

function paragraphs(content) {
  return content.sections.flatMap((section) =>
    section.body.flatMap((block) => (typeof block === 'string' ? [block] : block.list)),
  );
}

/** Structural errors that make the content unbuildable in any environment. */
export function validateDocuments(documents) {
  const errors = [];
  const ids = new Set();
  for (const doc of documents) {
    const where = `document "${doc.id}"`;
    if (ids.has(doc.id)) errors.push(`${where}: duplicate id`);
    ids.add(doc.id);

    if (doc.status === 'draft') {
      if (doc.effectiveDate !== null) errors.push(`${where}: a draft has no effective date`);
      if (!DRAFT_VERSION.test(doc.version)) errors.push(`${where}: a draft version ends in -draft`);
    } else if (doc.status === 'approved') {
      if (!ISO_DATE.test(doc.effectiveDate ?? ''))
        errors.push(`${where}: an approved document needs its effective date (YYYY-MM-DD)`);
      if (!FINAL_VERSION.test(doc.version))
        errors.push(`${where}: an approved version is plain semver`);
      const open = [...reviewKeys(doc)];
      if (open.length > 0)
        errors.push(`${where}: approved with open review markers: ${open.join(', ')}`);
    } else {
      errors.push(`${where}: unknown status "${doc.status}"`);
    }

    const [first, ...others] = LOCALES;
    const shape = (locale) => doc.content[locale]?.sections.map((s) => s.id).join(',');
    for (const locale of LOCALES) {
      if (!doc.content[locale]) errors.push(`${where}: missing locale "${locale}"`);
    }
    for (const locale of others) {
      if (doc.content[locale] && shape(locale) !== shape(first))
        errors.push(`${where}: sections of "${locale}" differ from "${first}"`);
    }
    for (const key of reviewKeys(doc)) {
      if (!REVIEW[key]) errors.push(`${where}: unknown review marker "${key}"`);
    }
  }
  return errors;
}

/**
 * Reasons the hub must not be published as final: any draft document, or any open review
 * marker on any page (the company block on the overview uses REGISTRATION and ADDRESS until
 * they are filled in).
 */
export function publishBlockers(documents, companyOpenMarkers) {
  const blockers = [];
  for (const doc of documents) {
    if (doc.status !== 'approved') blockers.push(`document "${doc.id}" is ${doc.status}`);
  }
  for (const key of companyOpenMarkers) blockers.push(`company information: ${key} is open`);
  return blockers;
}
