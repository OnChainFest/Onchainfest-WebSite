import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CanonicalError,
  createCanonicalizer,
  type BrRootSchema,
  type CanonicalValue,
} from '../src/index';

export const VECTOR_DIR = fileURLToPath(new URL('../test-vectors/', import.meta.url));
export const SOURCE_FILE = `${VECTOR_DIR}br-json-v1.source.json`;
export const VECTORS_FILE = `${VECTOR_DIR}br-json-v1.vectors.json`;

interface SchemaRefJson {
  id: string;
  version: number;
}

interface VectorBase {
  id: string;
  description: string;
  schema: SchemaRefJson;
  domainTag: string;
  input: string;
}

export type SourceVector =
  | (VectorBase & { expect: 'accept'; normalized: CanonicalValue })
  | (VectorBase & { expect: 'reject'; error: string });

export type GeneratedVector =
  | (VectorBase & {
      expect: 'accept';
      normalized: CanonicalValue;
      canonical: string;
      sha256: string;
    })
  | (VectorBase & { expect: 'reject'; error: string });

export interface VectorSourceDoc {
  profile: string;
  description: string;
  hashConstruction: string;
  equalHashGroups: string[][];
  distinctHashGroups: string[][];
  schemas: BrRootSchema[];
  vectors: SourceVector[];
}

export interface VectorDoc extends Omit<VectorSourceDoc, 'vectors'> {
  vectors: GeneratedVector[];
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Runs every source vector through the main implementation and checks it against the
 * hand-authored expectation. Returns the fully generated document (canonical text + hash)
 * and a list of expectation mismatches.
 */
export function generate(source: VectorSourceDoc): { doc: VectorDoc; problems: string[] } {
  const canonicalizer = createCanonicalizer(source.schemas);
  const problems: string[] = [];
  const vectors: GeneratedVector[] = source.vectors.map((v): GeneratedVector => {
    let outcome:
      { canonical: string; normalized: CanonicalValue; sha256: string } | { error: string };
    try {
      const r = canonicalizer.hashCanonicalJson(
        v.domainTag,
        v.schema.id,
        v.schema.version,
        v.input,
      );
      outcome = { canonical: r.canonicalText, normalized: r.normalized, sha256: r.contentHash };
    } catch (err) {
      if (!(err instanceof CanonicalError)) throw err;
      outcome = { error: err.code };
    }
    if (v.expect === 'reject') {
      if (!('error' in outcome) || outcome.error !== v.error) {
        problems.push(`${v.id}: expected ${v.error}, got ${JSON.stringify(outcome)}`);
      }
      return v;
    }
    if ('error' in outcome) {
      problems.push(`${v.id}: expected accept, got ${outcome.error}`);
      return { ...v, canonical: '', sha256: '' };
    }
    const expected = canonicalizer.canonicalize(
      v.schema.id,
      v.schema.version,
      v.normalized,
    ).canonicalText;
    if (expected !== outcome.canonical) {
      problems.push(
        `${v.id}: normalized mismatch\n  expected ${expected}\n  actual   ${outcome.canonical}`,
      );
    }
    return { ...v, canonical: outcome.canonical, sha256: outcome.sha256 };
  });

  const hashOf = new Map(
    vectors.flatMap((v) => (v.expect === 'accept' ? [[v.id, v.sha256] as const] : [])),
  );
  for (const group of source.equalHashGroups) {
    const hashes = new Set(group.map((id) => hashOf.get(id)));
    if (hashes.size !== 1) problems.push(`equal-hash group violated: ${group.join(', ')}`);
  }
  for (const group of source.distinctHashGroups) {
    const hashes = new Set(group.map((id) => hashOf.get(id)));
    if (hashes.size !== group.length)
      problems.push(`distinct-hash group violated: ${group.join(', ')}`);
  }
  return { doc: { ...source, vectors }, problems };
}

export function serializeDoc(doc: VectorDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
