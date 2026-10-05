import { readFileSync, writeFileSync } from 'node:fs';
import { generateBrt10Vectors, serialize, VECTORS_FILE } from './vectors';

/**
 * Regenerates packages/rankings/test-vectors/brt-10.vectors.json. With --check, fails when the
 * committed file differs from what the implementation produces (CI).
 */
const doc = generateBrt10Vectors();
const text = serialize(doc);
if (process.argv.includes('--check')) {
  if (readFileSync(VECTORS_FILE, 'utf8') !== text) {
    console.error(
      'Committed BRT-10 vectors are stale. Run `pnpm vectors:generate:brt10` and review the diff.',
    );
    process.exit(1);
  }
  console.log(
    `OK: ${doc.vectors.length} BRT-10 ranking / classification vectors reproduce exactly.`,
  );
} else {
  writeFileSync(VECTORS_FILE, text);
  console.log(`Wrote ${doc.vectors.length} vectors to ${VECTORS_FILE}`);
}
