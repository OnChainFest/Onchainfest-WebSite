// ONCHAINFEST-LEGAL-01 · Build the legal hub into legal/dist (no dependencies).
//
//   node scripts/build.mjs                        preview / local build (drafts allowed, noindex)
//   node scripts/build.mjs --require-publishable  production gate: fails while drafts or review markers remain
//
// A Vercel production build (VERCEL_ENV=production) always applies the production gate.

import { fileURLToPath } from 'node:url';
import { buildSite } from '../src/build.mjs';

const outDir = fileURLToPath(new URL('../dist/', import.meta.url));
const requirePublishable =
  process.argv.includes('--require-publishable') || process.env.VERCEL_ENV === 'production';

try {
  const { files, blockers } = await buildSite({ outDir, requirePublishable });
  console.log(`legal hub: ${files.length} files + assets → ${outDir}`);
  if (blockers.length > 0) {
    console.log(
      `legal hub: DRAFT build (noindex). Not publishable as final:\n- ${blockers.join('\n- ')}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
