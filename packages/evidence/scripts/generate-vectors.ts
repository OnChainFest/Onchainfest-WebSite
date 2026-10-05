import { readFileSync, writeFileSync } from 'node:fs';
import { generateBrt06Vectors, serialize, VECTORS_FILE } from './vectors';

/**
 * Regenerates packages/evidence/test-vectors/brt-06.vectors.json. With --check, fails when the
 * committed file differs from what the implementation produces (CI).
 */
const doc = generateBrt06Vectors();
const text = serialize(doc);
if (process.argv.includes('--check')) {
  if (readFileSync(VECTORS_FILE, 'utf8') !== text) {
    console.error(
      'Committed BRT-06 vectors are stale. Run `pnpm vectors:generate:brt06` and review the diff.',
    );
    process.exit(1);
  }
  console.log(
    `OK: ${doc.canonical.length} canonical + ${doc.signing.length} signing + ${doc.keys.length} key BRT-06 vectors reproduce exactly.`,
  );
} else {
  writeFileSync(VECTORS_FILE, text);
  console.log(
    `Wrote ${doc.canonical.length + doc.signing.length + doc.keys.length} vectors to ${VECTORS_FILE}`,
  );
}
