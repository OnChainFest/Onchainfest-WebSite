import { describe, expect, it } from 'vitest';
import { assertRequiredConsumers, WorkerConfigError, type WorkerConsumerState } from './config';

// LAUNCH-02: a production worker can make consumers mandatory instead of silently skipping them.
const states: WorkerConsumerState[] = [
  { name: 'dev.event-log', enabled: true },
  { name: 'achievements.derive', enabled: true },
  {
    name: 'records.evaluate',
    enabled: false,
    disabledReason: 'BR_RECORD_WORKER_DATABASE_URL not set',
  },
  {
    name: 'rankings.react',
    enabled: false,
    disabledReason: 'BR_RANKING_WORKER_DATABASE_URL not set',
  },
];

function refusal(required: string): readonly string[] {
  try {
    assertRequiredConsumers(states, required);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkerConfigError);
    return (err as WorkerConfigError).problems;
  }
  throw new Error('expected a refusal');
}

describe('worker required consumers', () => {
  it('no requirement (development default) accepts disabled consumers', () => {
    expect(() => assertRequiredConsumers(states, undefined)).not.toThrow();
    expect(() => assertRequiredConsumers(states, '')).not.toThrow();
  });

  it('accepts required consumers that are enabled', () => {
    expect(() =>
      assertRequiredConsumers(states, 'dev.event-log, achievements.derive'),
    ).not.toThrow();
  });

  it('refuses every disabled required consumer, naming the missing variable', () => {
    expect(refusal('achievements.derive,records.evaluate,rankings.react')).toEqual([
      'required consumer records.evaluate is disabled: BR_RECORD_WORKER_DATABASE_URL not set',
      'required consumer rankings.react is disabled: BR_RANKING_WORKER_DATABASE_URL not set',
    ]);
  });

  it('refuses an unknown consumer name (typos must not pass silently)', () => {
    expect(refusal('ranking.react')[0]).toMatch(/unknown consumer "ranking\.react"/);
  });
});
