import {
  CANONICAL_CATALOG,
  PADEL_DOUBLES_V1,
  TENNIS_SINGLES_V1,
  type CatalogManifest,
} from '@br/competition';
import { newId } from '@br/domain';
import { apiDb, newTestAccount, operatorDb, ownerDb } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogStore } from './catalog-store';
import { CompetitionReader } from './competition-reader';
import { IdentityStore } from './identity-store';

// ONCF-03A: the production-safe catalog provisioner. Lookup-first and idempotent: re-running
// never duplicates a row, and a diverging specification is reported, never silently versioned.

const db = apiDb();
const opDb = operatorDb();
const owner = ownerDb();
const catalog = new CatalogStore(opDb);
const reader = new CompetitionReader(db);
let op: string;

beforeAll(async () => {
  op = (await newTestAccount(new IdentityStore(db), { withPerson: false, label: 'cat-op' }))
    .accountId;
});
afterAll(async () => {
  await Promise.all([db.destroy(), opDb.destroy(), owner.destroy()]);
});

/** A manifest with unique codes, so this test owns every row it touches. */
function manifest(): CatalogManifest {
  const t = newId().replace(/-/g, '').slice(-8);
  return {
    sports: [
      {
        code: `padel${t}`,
        name: 'Padel',
        disciplines: [{ code: `padel${t}.doubles`, name: 'Padel doubles', spec: PADEL_DOUBLES_V1 }],
      },
      {
        code: `tennis${t}`,
        name: 'Tennis',
        disciplines: [
          { code: `tennis${t}.singles`, name: 'Tennis singles', spec: TENNIS_SINGLES_V1 },
        ],
      },
    ],
    formats: [
      {
        code: `single-elimination-${t}`,
        name: 'Single elimination',
        engineId: 'single-elimination',
        engineVersion: 1,
      },
    ],
  };
}

async function rowCounts(m: CatalogManifest) {
  const sports = m.sports.map((s) => s.code);
  const disciplines = m.sports.flatMap((s) => s.disciplines.map((d) => d.code));
  const formats = m.formats.map((f) => f.code);
  const { rows } = await sql<{ s: number; d: number; dv: number; f: number; fv: number }>`
    SELECT (SELECT count(*)::int FROM sports.sport WHERE code = ANY(${sports})) AS s,
           (SELECT count(*)::int FROM sports.discipline WHERE code = ANY(${disciplines})) AS d,
           (SELECT count(*)::int FROM sports.discipline_version v JOIN sports.discipline x ON x.id = v.discipline_id
             WHERE x.code = ANY(${disciplines})) AS dv,
           (SELECT count(*)::int FROM sports.format_template WHERE code = ANY(${formats})) AS f,
           (SELECT count(*)::int FROM sports.format_version v JOIN sports.format_template x ON x.id = v.template_id
             WHERE x.code = ANY(${formats})) AS fv`.execute(owner);
  return rows[0];
}

describe('CatalogStore.provision', () => {
  it('dry run reports the plan and writes nothing', async () => {
    const m = manifest();
    const report = await catalog.provision({ operatorAccountId: op, manifest: m, dryRun: true });
    expect(report.conflicts).toEqual([]);
    expect(report.steps.every((s) => s.action === 'WOULD_CREATE')).toBe(true);
    expect(report.steps).toHaveLength(2 + 2 + 2 + 1 + 1);
    expect(await rowCounts(m)).toEqual({ s: 0, d: 0, dv: 0, f: 0, fv: 0 });
  });

  it('creates and publishes once; a re-run is UNCHANGED and duplicates nothing', async () => {
    const m = manifest();
    const first = await catalog.provision({ operatorAccountId: op, manifest: m });
    expect(first.conflicts).toEqual([]);
    expect(first.steps.every((s) => s.action === 'CREATED')).toBe(true);
    const counts = { s: 2, d: 2, dv: 2, f: 1, fv: 1 };
    expect(await rowCounts(m)).toEqual(counts);

    // A different operator re-running converges on the same rows (lookup-first, not key-based).
    const other = (await newTestAccount(new IdentityStore(db), { withPerson: false })).accountId;
    const again = await catalog.provision({ operatorAccountId: other, manifest: m });
    expect(again.conflicts).toEqual([]);
    expect(again.steps.every((s) => s.action === 'UNCHANGED')).toBe(true);
    expect(again.steps.map((s) => s.id)).toEqual(first.steps.map((s) => s.id));
    expect(await rowCounts(m)).toEqual(counts);

    // The provisioned versions are pinnable: published and listed with their facts.
    const listed = await reader.catalog();
    const padel = listed.disciplineVersions.find(
      (d) => d.discipline.code === m.sports[0]?.disciplines[0]?.code,
    );
    const se = listed.formatVersions.find((f) => f.format.code === m.formats[0]?.code);
    expect(padel?.participantKinds).toEqual(['TEAM']);
    expect(padel?.compatibleFormatVersionIds).toContain(se?.formatVersionId);
  });

  it('publishes a matching DRAFT version instead of creating another', async () => {
    const m = manifest();
    const sport = m.sports[0];
    const disc = sport?.disciplines[0];
    if (sport === undefined || disc === undefined) throw new Error('manifest');
    const { sportId } = await catalog.createSport({
      operatorAccountId: op,
      code: sport.code,
      name: sport.name,
      idempotencyKey: `k-${newId()}`,
    });
    const { disciplineId } = await catalog.createDiscipline({
      operatorAccountId: op,
      sportId,
      code: disc.code,
      name: disc.name,
      idempotencyKey: `k-${newId()}`,
    });
    const { disciplineVersionId } = await catalog.createDisciplineVersion({
      operatorAccountId: op,
      disciplineId,
      spec: disc.spec,
      idempotencyKey: `k-${newId()}`,
    });
    const report = await catalog.provision({ operatorAccountId: op, manifest: m });
    expect(report.conflicts).toEqual([]);
    expect(report.steps).toContainEqual({
      kind: 'discipline-version',
      code: disc.code,
      action: 'PUBLISHED',
      id: disciplineVersionId,
    });
    expect((await rowCounts(m))?.dv).toBe(2);
  });

  it('reports a discipline whose existing versions differ, and leaves it untouched', async () => {
    const m = manifest();
    await catalog.provision({ operatorAccountId: op, manifest: m });
    const changed: CatalogManifest = {
      ...m,
      sports: m.sports.map((s, i) =>
        i === 0
          ? {
              ...s,
              disciplines: s.disciplines.map((d) => ({
                ...d,
                spec: { ...d.spec, evidenceExpectations: ['VIDEO'] },
              })),
            }
          : s,
      ),
    };
    const report = await catalog.provision({ operatorAccountId: op, manifest: changed });
    expect(report.conflicts).toEqual([
      {
        code: m.sports[0]?.disciplines[0]?.code,
        reason: 'existing discipline versions differ from the declared specification',
      },
    ]);
    expect((await rowCounts(m))?.dv).toBe(2);
  });

  it('refuses an invalid manifest before writing anything', async () => {
    const m = manifest();
    const bad: CatalogManifest = {
      ...m,
      formats: [{ code: 'nope', name: 'Nope', engineId: 'no-such-engine', engineVersion: 1 }],
    };
    await expect(catalog.provision({ operatorAccountId: op, manifest: bad })).rejects.toThrow(
      'invalid format nope',
    );
    expect((await rowCounts(m))?.s).toBe(0);
  });

  it('the canonical catalog provisions idempotently (padel and tennis, no running)', async () => {
    const first = await catalog.provision({ operatorAccountId: op, manifest: CANONICAL_CATALOG });
    expect(first.conflicts).toEqual([]);
    const second = await catalog.provision({ operatorAccountId: op, manifest: CANONICAL_CATALOG });
    expect(second.steps.every((s) => s.action === 'UNCHANGED')).toBe(true);
    expect(await rowCounts(CANONICAL_CATALOG)).toEqual({ s: 2, d: 3, dv: 3, f: 2, fv: 2 });
    const listed = await reader.catalog();
    const codes = listed.disciplineVersions.map((d) => d.discipline.code);
    expect(codes).toEqual(
      expect.arrayContaining(['padel.doubles', 'tennis.singles', 'tennis.doubles']),
    );
  });
});
