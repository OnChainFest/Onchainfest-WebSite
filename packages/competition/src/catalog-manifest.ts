import type { DisciplineVersionSpec } from './catalog';

/**
 * ONCF-03A · The canonical OnChainFest sport catalog: what an operator provisions in every
 * environment (`pnpm db:catalog:provision`). Catalog rows stay DATA in `sports.*`; this manifest is
 * only the operator's declared input, applied lookup-first by `CatalogStore.provision` (existing
 * codes and identical specs are reused, never duplicated). Changing a spec here does not edit a
 * version: the provisioner refuses a spec that differs from the discipline's existing versions
 * until an operator publishes a new version deliberately.
 *
 * Only disciplines that can actually be run end to end are listed: every discipline here has at
 * least one listed format whose contest type it allows. Running (HEAT contests) is deliberately
 * absent — no HEAT format engine exists yet, so an organizer could pick it but never run it.
 */
export interface CatalogManifest {
  readonly sports: readonly {
    readonly code: string;
    readonly name: string;
    readonly disciplines: readonly {
      readonly code: string;
      readonly name: string;
      readonly spec: DisciplineVersionSpec;
    }[];
  }[];
  readonly formats: readonly {
    readonly code: string;
    readonly name: string;
    readonly engineId: string;
    readonly engineVersion: number;
  }[];
}

/** Head-to-head racket match scored in sets and games (the score is recorded, not decided here). */
const RACKET_MATCH: Omit<DisciplineVersionSpec, 'participation'> = {
  resultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['setsWon', 'gamesWon'],
    properties: {
      setsWon: { type: 'integer', minimum: 0, maximum: 5 },
      gamesWon: { type: 'integer', minimum: 0, maximum: 99 },
    },
  },
  metrics: [
    { key: 'setsWon', valueType: 'INTEGER', unit: 'sets' },
    { key: 'gamesWon', valueType: 'INTEGER', unit: 'games' },
  ],
  comparator: {
    outcomeModel: 'WIN_LOSS_DRAW',
    primary: 'HEAD_TO_HEAD_WINNER',
    keys: [
      { metric: 'setsWon', order: 'HIGHER_IS_BETTER' },
      { metric: 'gamesWon', order: 'HIGHER_IS_BETTER' },
    ],
  },
  validation: { bounds: [{ metric: 'setsWon', min: '0', max: '3' }] },
  allowedContestTypes: ['MATCH'],
  evidenceExpectations: ['SIGNED_SCORESHEET'],
};

export const PADEL_DOUBLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
};

export const TENNIS_SINGLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['INDIVIDUAL'], lineupSize: { min: 1, max: 1 } },
};

export const TENNIS_DOUBLES_V1: DisciplineVersionSpec = {
  ...RACKET_MATCH,
  participation: { participantKinds: ['TEAM'], lineupSize: { min: 2, max: 2 } },
};

export const CANONICAL_CATALOG: CatalogManifest = {
  sports: [
    {
      code: 'padel',
      name: 'Padel',
      disciplines: [{ code: 'padel.doubles', name: 'Padel doubles', spec: PADEL_DOUBLES_V1 }],
    },
    {
      code: 'tennis',
      name: 'Tennis',
      disciplines: [
        { code: 'tennis.singles', name: 'Tennis singles', spec: TENNIS_SINGLES_V1 },
        { code: 'tennis.doubles', name: 'Tennis doubles', spec: TENNIS_DOUBLES_V1 },
      ],
    },
  ],
  formats: [
    {
      code: 'single-elimination',
      name: 'Single elimination',
      engineId: 'single-elimination',
      engineVersion: 1,
    },
    { code: 'round-robin', name: 'Round robin', engineId: 'round-robin', engineVersion: 1 },
  ],
};
