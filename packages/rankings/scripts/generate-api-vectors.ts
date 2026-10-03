import { readFileSync, writeFileSync } from 'node:fs';
import { API_VECTORS_FILE, generateBrt10ApiVectors, serialize } from './api-vectors';

/**
 * Regenerates packages/rankings/test-vectors/brt-10-api.vectors.json. With --check, fails when the
 * committed file differs from what the implementation produces (CI).
 */
const doc = generateBrt10ApiVectors();
const text = serialize(doc);
if (process.argv.includes('--check')) {
  if (readFileSync(API_VECTORS_FILE, 'utf8') !== text) {
    console.error(
      'Committed BRT-10 API vectors are stale. Run `pnpm vectors:generate:brt10-api` and review the diff.',
    );
    process.exit(1);
  }
  console.log(`OK: ${doc.vectors.length} BRT-10 API DTO vectors reproduce exactly.`);
} else {
  writeFileSync(API_VECTORS_FILE, text);
  console.log(`Wrote ${doc.vectors.length} vectors to ${API_VECTORS_FILE}`);
}
