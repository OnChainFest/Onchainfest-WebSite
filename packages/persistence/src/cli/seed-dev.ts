import { databaseUrls } from '../config';
import { createDb } from '../db';
import { AuthorityStore } from '../authority-store';

/**
 * Development seed: the PLATFORM principal and its PLATFORM-level bootstrap anchor — explicitly
 * recognized, never NATIONAL/WORLD. Development only: each run registers a new principal.
 */
const db = createDb(databaseUrls().api);
try {
  const store = new AuthorityStore(db);
  const platform = await store.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'Bragging Rights platform (development)',
  });
  const anchor = await store.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'development bootstrap',
    governanceDecisionRef: 'dev-seed (not a governance decision)',
  });
  console.log(
    JSON.stringify(
      { platformPrincipalId: platform.id, platformAnchorId: anchor.anchorId },
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
}
