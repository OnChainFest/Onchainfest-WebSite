import {
  buildPreimage,
  hashEvidenceBytes,
  normalizeText,
  serializeJcs,
  sha256,
  toContentHash,
  type ContentHash,
} from '@br/canonical';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

type Ref = { readonly id: string; readonly version: number };

/** Hash of a fact row's canonical document (ledger payload hash). */
export function factHash(schema: Ref, doc: unknown): ContentHash {
  return platformCanonicalizer().hashCanonical(DomainTag.ledgerFact, schema.id, schema.version, doc)
    .contentHash;
}

export function canonicalHash(domainTag: string, schema: Ref, doc: unknown) {
  return platformCanonicalizer().hashCanonical(domainTag, schema.id, schema.version, doc);
}

/**
 * Key verification material is a flat map of ASCII keys to strings (e.g. a public JWK).
 * It is hashed with JCS under its own domain tag; private members are refused before hashing.
 */
export const FORBIDDEN_KEY_MATERIAL_MEMBERS = [
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'k',
  'privateKey',
  'private_key',
  'secret',
  'seed',
  'mnemonic',
];

export function keyMaterialHash(material: Readonly<Record<string, string>>): ContentHash {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(material)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k))
      throw new TypeError(`invalid verification material member ${k}`);
    if (typeof v !== 'string')
      throw new TypeError(`verification material member ${k} must be a string`);
    normalized[k] = normalizeText(v, `/${k}`, false);
  }
  return toContentHash(
    sha256(
      buildPreimage(
        DomainTag.keyMaterial,
        'br:key-material',
        1,
        new TextEncoder().encode(serializeJcs(normalized)),
      ),
    ),
  );
}

export { hashEvidenceBytes, SchemaRef };
