import { readFileSync, writeFileSync } from 'node:fs';
import {
  generate,
  readJson,
  serializeDoc,
  SOURCE_FILE,
  VECTORS_FILE,
  type VectorSourceDoc,
} from './vectors';

/**
 * Regenerates packages/canonical/test-vectors/br-json-v1.vectors.json from the hand-authored
 * source. With --check, fails if the committed vectors differ from what the implementation
 * produces (used in CI).
 */
const check = process.argv.includes('--check');
const { doc, problems } = generate(readJson<VectorSourceDoc>(SOURCE_FILE));
if (problems.length > 0) {
  console.error(`Vector expectations violated:\n${problems.join('\n')}`);
  process.exit(1);
}
const text = serializeDoc(doc);
if (check) {
  if (readFileSync(VECTORS_FILE, 'utf8') !== text) {
    console.error('Committed vectors are stale. Run `pnpm vectors:generate` and review the diff.');
    process.exit(1);
  }
  console.log(`OK: ${doc.vectors.length} vectors reproduce exactly.`);
} else {
  writeFileSync(VECTORS_FILE, text);
  console.log(`Wrote ${doc.vectors.length} vectors to ${VECTORS_FILE}`);
}
