import { readFileSync, writeFileSync } from 'node:fs';
import { generateBrt07Vectors, serialize, VECTORS_FILE } from './vectors';

/**
 * Regenerates packages/verification/test-vectors/brt-07.vectors.json. With --check, fails when the
 * committed file differs from what the implementation produces (CI).
 */
const doc = generateBrt07Vectors();
const text = serialize(doc);
if (process.argv.includes('--check')) {
  if (readFileSync(VECTORS_FILE, 'utf8') !== text) {
    console.error(
      'Committed BRT-07 vectors are stale. Run `pnpm vectors:generate:brt07` and review the diff.',
    );
    process.exit(1);
  }
  console.log(`OK: ${doc.vectors.length} BRT-07 verification vectors reproduce exactly.`);
} else {
  writeFileSync(VECTORS_FILE, text);
  console.log(`Wrote ${doc.vectors.length} vectors to ${VECTORS_FILE}`);
}
