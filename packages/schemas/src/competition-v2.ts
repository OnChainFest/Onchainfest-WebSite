import type { BrRootSchema, BrSchema, BrStringSchema } from '@br/canonical';
import { enumOf, hashRef, setOf, uuid } from './primitives';

/**
 * ONCF-05B competition documents (v2). The BRT-05 v1 documents are unchanged; events pinned to a
 * v1 DisciplineVersion keep producing v1 field/seeding/plan documents and hashes.
 *  - `br:competition-field@2`: + roster snapshot (TEAM) and declared entry attributes (ADR-0056, -0057).
 *  - `br:competition-seeding@2`: + ranked-then-drawn / entry-attribute methods, sources, overrides (ADR-0058).
 *  - `br:competition-plan-input@2` / `br:competition-plan@2`: stage graphs, fields beyond 64 (ADR-0054).
 */

const root = (id: string, version: number, body: Omit<BrRootSchema, '$id' | 'x-br-version'>) =>
  ({ $id: id, 'x-br-version': version, ...body }) as BrRootSchema;

const MAX_FIELD = 20000;
const participantKind = enumOf(['INDIVIDUAL', 'TEAM']);
const contestType = enumOf(['MATCH', 'HEAT', 'SERIES', 'ATTEMPT_SET', 'ROUTINE', 'SESSION']);
const attributeKey: BrStringSchema = { type: 'string', pattern: '^[a-z][A-Za-z0-9]{0,31}$' };
const attributeValue: BrStringSchema = { type: 'string', minLength: 1, maxLength: 64 };
const planKey: BrStringSchema = {
  type: 'string',
  pattern: '^s[0-9]{1,2}(-[a-z0-9]{1,6}){0,4}$',
  maxLength: 40,
};
const stageKey: BrStringSchema = { type: 'string', pattern: '^s[0-9]{1,2}$' };
const transitionKey: BrStringSchema = { type: 'string', pattern: '^t[0-9]{1,2}$' };
const groupKey: BrStringSchema = { type: 'string', pattern: '^g[0-9]{1,2}$' };
const partitionKey: BrStringSchema = { type: 'string', pattern: '^[a-z][0-9]{1,5}$' };
const posInt = (maximum: number): BrSchema => ({ type: 'integer', minimum: 1, maximum });
const nonNegInt = (maximum: number): BrSchema => ({ type: 'integer', minimum: 0, maximum });

export const competitionFieldV2 = root('br:competition-field', 2, {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'participants'],
  properties: {
    eventId: uuid,
    participants: {
      ...setOf(
        {
          type: 'object',
          additionalProperties: false,
          required: ['participantId', 'registrationId', 'kind'],
          properties: {
            participantId: uuid,
            registrationId: uuid,
            kind: participantKind,
            athleteId: uuid,
            teamId: uuid,
            /** ACTIVE team members at lock (TEAM only). */
            roster: { ...setOf(uuid), uniqueItems: true, maxItems: 100 },
            attributes: {
              ...setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['key', 'value'],
                  properties: { key: attributeKey, value: attributeValue },
                },
                { sortBy: ['/key'], keyUnique: true },
              ),
              maxItems: 16,
            },
            memberAttributes: {
              ...setOf(
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['athleteId', 'key', 'value'],
                  properties: { athleteId: uuid, key: attributeKey, value: attributeValue },
                },
                { sortBy: ['/athleteId', '/key'], keyUnique: true },
              ),
              maxItems: 1600,
            },
          },
        },
        { sortBy: ['/participantId'], keyUnique: true },
      ),
      maxItems: MAX_FIELD,
    },
  },
});

export const competitionSeedingV2 = root('br:competition-seeding', 2, {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'fieldHash', 'method', 'order'],
  properties: {
    eventId: uuid,
    fieldHash: hashRef,
    method: enumOf(['MANUAL', 'DETERMINISTIC_DRAW', 'RANKED_THEN_DRAWN', 'BY_ENTRY_ATTRIBUTE']),
    drawAlgorithm: { type: 'string', pattern: '^[a-z0-9-]+/[0-9]+$', maxLength: 32 },
    drawSeed: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    seeds: { type: 'array', items: uuid, maxItems: 64, uniqueItems: true },
    banded: { type: 'boolean' },
    attributeKey,
    direction: enumOf(['ASC', 'DESC']),
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: enumOf(['ORGANIZER', 'DECLARED_EXTERNAL', 'ENTRY_ATTRIBUTE']),
        label: { type: 'string', minLength: 1, maxLength: 120 },
        asOf: { type: 'string', 'x-br-type': 'date' },
      },
    },
    overrides: {
      type: 'array',
      maxItems: 256,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['participantId', 'toPosition', 'reason'],
        properties: {
          participantId: uuid,
          toPosition: posInt(MAX_FIELD),
          reason: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
    order: { type: 'array', items: uuid, maxItems: MAX_FIELD, uniqueItems: true },
  },
});

export const competitionPlanInputV2 = root('br:competition-plan-input', 2, {
  type: 'object',
  additionalProperties: false,
  required: [
    'eventId',
    'disciplineVersionId',
    'disciplineVersionHash',
    'formatVersionId',
    'formatVersionHash',
    'engineId',
    'engineVersion',
    'fieldHash',
    'seedingHash',
    'configHash',
    'seedOrder',
  ],
  properties: {
    eventId: uuid,
    disciplineVersionId: uuid,
    disciplineVersionHash: hashRef,
    formatVersionId: uuid,
    formatVersionHash: hashRef,
    engineId: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 },
    engineVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    fieldHash: hashRef,
    seedingHash: hashRef,
    configHash: hashRef,
    seedOrder: { type: 'array', items: uuid, maxItems: MAX_FIELD, uniqueItems: true },
  },
});

const slotV2: BrSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slot', 'source'],
  properties: {
    slot: posInt(64),
    source: enumOf([
      'PARTICIPANT',
      'WINNER_OF_CONTEST',
      'LOSER_OF_CONTEST',
      'RANK_FROM_STAGE',
      'BEST_RANKED_FROM_STAGE',
      'QUALIFIER',
    ]),
    participantId: uuid,
    contestKey: planKey,
    stageKey,
    groupKey,
    rank: posInt(MAX_FIELD),
    ordinal: posInt(MAX_FIELD),
    transitionKey,
  },
};

const entryV2: BrSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['participantId', 'position'],
  properties: {
    participantId: uuid,
    position: posInt(MAX_FIELD),
    startOffsetSeconds: nonNegInt(10_000_000),
  },
};

export const competitionPlanV2 = root('br:competition-plan', 2, {
  type: 'object',
  additionalProperties: false,
  required: ['planVersion', 'engineId', 'engineVersion', 'stages', 'transitions', 'rounds'],
  properties: {
    planVersion: { type: 'integer', minimum: 2, maximum: 2 },
    engineId: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 64 },
    engineVersion: { type: 'integer', minimum: 1, maximum: 1000 },
    stages: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'sequence', 'primitive', 'label'],
        properties: {
          key: stageKey,
          sequence: posInt(16),
          primitive: enumOf(['KNOCKOUT', 'ROUND_ROBIN', 'FIELD', 'HEATS']),
          label: { type: 'string', minLength: 1, maxLength: 80 },
          partition: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'method'],
            properties: {
              kind: enumOf(['LOGISTIC', 'COMPETITIVE']),
              method: enumOf([
                'SINGLE_START',
                'WAVE_START',
                'INTERVAL_START',
                'LANE_HEATS',
                'GROUPED_ENTRANTS',
                'GROUPS',
              ]),
            },
          },
        },
      },
    },
    transitions: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'kind', 'fromStage', 'toStage', 'params'],
        properties: {
          key: transitionKey,
          kind: enumOf([
            'RANK_FROM_GROUP',
            'QUALIFY_BY_PLACE_AND_TIME',
            'CUT',
            'ELIMINATE_NON_FINISHERS',
            'STEPLADDER',
            'RANK_TO_BRACKET',
          ]),
          fromStage: stageKey,
          toStage: stageKey,
          afterRound: planKey,
          params: {
            type: 'object',
            additionalProperties: false,
            properties: {
              qualifiersPerGroup: nonNegInt(64),
              bestRankedExtra: nonNegInt(64),
              qualifyByPlace: nonNegInt(64),
              qualifyByTime: nonNegInt(64),
              heats: nonNegInt(2000),
              topN: nonNegInt(MAX_FIELD),
              includeTies: { type: 'boolean' },
              qualifiers: nonNegInt(64),
            },
          },
        },
      },
    },
    rounds: {
      type: 'array',
      maxItems: 2048,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'sequence', 'roundType', 'label', 'stageKey', 'byes', 'contests'],
        properties: {
          key: planKey,
          sequence: posInt(2048),
          roundType: enumOf([
            'QUALIFYING',
            'GROUP',
            'HEAT',
            'KNOCKOUT',
            'REPECHAGE',
            'FINAL',
            'SESSION',
          ]),
          label: { type: 'string', minLength: 1, maxLength: 80 },
          stageKey,
          groupKey,
          byes: { ...setOf(uuid), uniqueItems: true, maxItems: 64 },
          dynamicEntry: {
            type: 'object',
            additionalProperties: false,
            required: ['transitionKey'],
            properties: { transitionKey },
          },
          contests: {
            type: 'array',
            maxItems: MAX_FIELD,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'sequence', 'contestType', 'slots'],
              properties: {
                key: planKey,
                sequence: posInt(1_000_000),
                contestType,
                partitionKey,
                slots: { type: 'array', maxItems: 64, items: slotV2 },
                entries: { type: 'array', maxItems: MAX_FIELD, items: entryV2 },
              },
            },
          },
        },
      },
    },
  },
});

export const ONCF05B_SCHEMAS: readonly BrRootSchema[] = [
  competitionFieldV2,
  competitionSeedingV2,
  competitionPlanInputV2,
  competitionPlanV2,
];
