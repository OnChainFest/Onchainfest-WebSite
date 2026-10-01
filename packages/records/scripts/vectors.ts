import { fileURLToPath } from 'node:url';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { universeOf } from '../src/category';
import { evaluateRecord, markIdentityOf } from '../src/engine';
import {
  authorityWorld,
  categorySpec,
  fixtureCategory,
  recordSnapshot,
  rfxHash,
  rfxId,
  standingMark,
  RFX,
} from '../src/fixtures';
import { replayRecordHistory, type ReplayMark } from '../src/replay';
import type { RecordEvaluationSnapshot } from '../src/snapshot';

/**
 * BRT-09 record vectors: canonical text + domain-separated hash of category versions, universes,
 * evaluation snapshots, outcomes, mark candidates, mark identities and replay inputs, all built from
 * REFERENCE ENGINE FIXTURES (never persisted sporting truth). The independent Python checker
 * re-derives JCS and every hash, checks equal / distinct groups and the outcome → snapshot /
 * candidate / identity bindings, and the RC / value-integrity invariants of the committed documents.
 */
export const VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-09.vectors.json', import.meta.url),
);

type Kind = 'category' | 'universe' | 'snapshot' | 'outcome' | 'candidate' | 'identity' | 'replay';
interface Vector {
  readonly name: string;
  readonly kind: Kind;
  readonly domainTag: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly canonicalText: string;
  readonly hash: string;
  readonly snapshotVector?: string;
  readonly candidateVector?: string;
  readonly identityVector?: string;
  readonly expectState?: string;
  readonly expectCurrent?: readonly string[];
}

const REF = {
  category: [DomainTag.recordCategoryVersion, SchemaRef.recordCategoryVersion],
  universe: [DomainTag.recordCategoryUniverse, SchemaRef.recordCategoryUniverse],
  snapshot: [DomainTag.recordEvaluationSnapshot, SchemaRef.recordEvaluationSnapshot],
  outcome: [DomainTag.recordEvaluationOutcome, SchemaRef.recordEvaluationOutcome],
  candidate: [DomainTag.recordMark, SchemaRef.recordMark],
  identity: [DomainTag.recordMarkIdentity, SchemaRef.recordMarkIdentity],
  replay: [DomainTag.recordReplay, SchemaRef.recordReplayInput],
} as const;

function vector(name: string, kind: Kind, doc: unknown, extra: Partial<Vector> = {}): Vector {
  const [tag, schema] = REF[kind];
  const r = platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  return {
    name,
    kind,
    domainTag: tag,
    schemaId: schema.id,
    schemaVersion: schema.version,
    canonicalText: r.canonicalText,
    hash: r.contentHash,
    ...extra,
  };
}

const reversed = (v: unknown): unknown =>
  Array.isArray(v)
    ? [...v].reverse().map(reversed)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        )
      : v;

function evaluated(name: string, s: RecordEvaluationSnapshot) {
  const e = evaluateRecord(s);
  const c = e.outcome.candidate;
  const out: Vector[] = [vector(`snapshot/${name}`, 'snapshot', s)];
  const extra: Partial<Vector> = {
    snapshotVector: `snapshot/${name}`,
    expectState: e.outcome.state,
  };
  if (c !== undefined) {
    out.push(vector(`candidate/${name}`, 'candidate', c.candidate));
    out.push(
      vector(
        `identity/${name}`,
        'identity',
        markIdentityOf({
          categoryId: c.candidate.category.categoryId,
          holder: c.candidate.holder,
          value: c.candidate.value,
          resultVersionId: c.candidate.basis.resultVersionId,
          contentHash: c.candidate.basis.contentHash,
          participantId: c.candidate.basis.participantId,
          performanceOrdinal: c.candidate.basis.performanceOrdinal,
        }).identity,
      ),
    );
    Object.assign(extra, {
      candidateVector: `candidate/${name}`,
      identityVector: `identity/${name}`,
    });
  }
  out.push(vector(`outcome/${name}`, 'outcome', e.outcome, extra));
  return out;
}

const replayMark = (label: string, value: string, minute: number, valid = true): ReplayMark => ({
  recordMarkId: rfxId(`mark:${label}`),
  value: { metricId: 'athletics.100m.time', value, unit: 'ms', precision: 0 },
  effectiveFrom: new Date(Date.parse('2026-06-01T08:00:00.000Z') + minute * 60_000).toISOString(),
  ratifiedSeq: minute,
  standing: 'RATIFIED',
  valid,
});

export function generateBrt09Vectors() {
  const comp = fixtureCategory(categorySpec({ scopeType: 'COMPETITION' }), 'competition');
  const comp2 = categorySpec({
    scopeType: 'COMPETITION',
    competitionIds: [RFX.competition, RFX.competition2],
    displayName: 'Fictional 100 m record — editions 2026+',
  });
  const scratch = fixtureCategory(
    categorySpec({
      scopeType: 'COMPETITION',
      sport: 'bowling',
      population: { handicapMode: 'SCRATCH' },
    }),
    'scratch',
  );
  const first = fixtureCategory(
    categorySpec({ scopeType: 'PLATFORM', tiePolicy: 'FIRST_ACHIEVED' }),
    'first',
  );
  const national = fixtureCategory(
    categorySpec({ scopeType: 'NATIONAL', canonicalKeeper: true }),
    'national',
  );
  const p = { rv: 'v-a', athlete: 'a', value: '10900', minute: 10 };
  const nationalPending = evaluateRecord(
    recordSnapshot({ category: national, performance: { ...p, level: 'V3' } }),
  ).outcome.candidate?.candidateHash as string;
  const ratifyNational = recordSnapshot({
    category: national,
    performance: { ...p, level: 'V4' },
    pending: { recordMarkId: rfxId('pending:national'), markHash: nationalPending },
    world: authorityWorld(national.spec, { ratifierIsKeeper: true }, 'vector'),
  });
  const replayABC = {
    categoryId: comp.categoryId,
    tiePolicy: 'SHARED' as const,
    comparator: 'LOWER_IS_BETTER' as const,
    marks: [replayMark('A', '10000', 1), replayMark('B', '9800', 2), replayMark('C', '9700', 3)],
  };
  const replayRescinded = {
    ...replayABC,
    marks: [
      replayMark('A', '10000', 1),
      replayMark('B', '9800', 2),
      replayMark('C', '9700', 3, false),
    ],
  };
  const base = recordSnapshot({ category: comp, performance: p });
  // The same Performance carried by a ResultVersion that corrects an earlier one (upstream fact).
  const correction = recordSnapshot({ category: comp, performance: { ...p, supersedes: 'v-a0' } });
  const vectors: Vector[] = [
    vector('category/competition', 'category', comp.spec),
    vector('category/competition-reordered', 'category', reversed(comp.spec)),
    vector('category/national-keeper', 'category', national.spec),
    vector('universe/competition-v1', 'universe', universeOf(comp.spec)),
    vector('universe/competition-v2-more-editions', 'universe', universeOf(comp2)),
    ...evaluated('establish-qualifies', base),
    vector('snapshot/establish-qualifies-reordered', 'snapshot', reversed(base)),
    ...evaluated('establish-correction', correction),
    ...evaluated(
      'lower-is-better-worse',
      recordSnapshot({
        category: comp,
        performance: { rv: 'v-b', athlete: 'b', value: '10950', minute: 30 },
        currentMarks: [standingMark(comp.spec, 'current-1090', '10900', 20)],
      }),
    ),
    ...evaluated(
      'handicap-into-scratch',
      recordSnapshot({
        category: scratch,
        performance: { rv: 'v-h', athlete: 'h', value: '720', minute: 5 },
        population: { HANDICAP_MODE: 'HANDICAP' },
      }),
    ),
    ...evaluated(
      'first-achieved-equal',
      recordSnapshot({
        category: first,
        performance: { rv: 'v-f', athlete: 'f', value: '10900', minute: 30 },
        currentMarks: [standingMark(first.spec, 'first-1090', '10900', 20)],
      }),
    ),
    ...evaluated('ratify-national-canonical', ratifyNational),
    ...evaluated('ratify-national-forged-subject', {
      ...ratifyNational,
      ratification: {
        ...(ratifyNational.ratification as NonNullable<RecordEvaluationSnapshot['ratification']>),
        subject: {
          subjectType: 'RECORD_MARK',
          subjectId: rfxId('pending:national'),
          subjectHash: rfxHash('forged'),
        },
      },
    }),
    vector('replay/a-b-c', 'replay', replayABC, {
      expectCurrent: replayRecordHistory(replayABC).current,
    }),
    vector('replay/a-b-c-rescind-c', 'replay', replayRescinded, {
      expectCurrent: replayRecordHistory(replayRescinded).current,
    }),
  ];
  return {
    schema: 'br-record-vectors/1',
    note: 'REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. hash = SHA-256("BR"‖0x01‖domainTag‖0x00‖schemaId@version‖0x00‖"br-json/1"‖0x00‖JCS). A RecordMark value is byte-equal to its Performance mark; only QUALIFYING outcomes carry a candidate or a ratification.',
    vectors,
    equal: [
      ['category/competition', 'category/competition-reordered'],
      ['snapshot/establish-qualifies', 'snapshot/establish-qualifies-reordered'],
      // A new version that only adds a series edition / renames keeps the comparison universe.
      ['universe/competition-v1', 'universe/competition-v2-more-editions'],
      // The correction fact is a snapshot fact, never part of the mark candidate / identity.
      ['candidate/establish-qualifies', 'candidate/establish-correction'],
      ['identity/establish-qualifies', 'identity/establish-correction'],
    ],
    distinct: [
      ['category/competition', 'category/national-keeper'],
      ['replay/a-b-c', 'replay/a-b-c-rescind-c'],
      ['snapshot/ratify-national-canonical', 'snapshot/ratify-national-forged-subject'],
      // Absent (not a correction) and present encode differently; absence has one encoding.
      ['snapshot/establish-qualifies', 'snapshot/establish-correction'],
    ],
  };
}

export const serialize = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
