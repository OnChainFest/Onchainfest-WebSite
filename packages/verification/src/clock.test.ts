import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { activeIntervals, occurrenceWindow, sliceAt, type RawParticipation } from './assemble';
import { attestation, FIX, produce, referenceWorld } from './fixtures';
import { evaluateVerification } from './engine';

/**
 * BRT-07R §5 — no semantic clock slack. A clock regression is handled ONLY by retrying the whole
 * evaluation with a fresh cutoff (service level). No code path in verification may widen key or
 * grant validity, clamp or rewrite a cutoff, backdate, or apply a skew / tolerance / grace window.
 */
const repo = join(__dirname, '..', '..', '..');
const sources = [
  ...readdirSync(join(repo, 'packages/verification/src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(repo, 'packages/verification/src', f)),
  ...readdirSync(join(repo, 'packages/persistence/src'))
    .filter((f) => /^verification-.*\.ts$/.test(f) && !f.includes('.test.'))
    .map((f) => join(repo, 'packages/persistence/src', f)),
  join(repo, 'apps/api/src/v1-verification.ts'),
];
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // documentation may name the rule itself
    .join('\n');

describe('no semantic clock slack in verification (source scan)', () => {
  it('scans the engine, assembler, loader, service and API route', () => {
    expect(sources.length).toBeGreaterThanOrEqual(12);
  });
  for (const path of sources)
    it(`${path.slice(repo.length + 1)}: no skew / tolerance / grace constant, no ambient clock`, () => {
      const c = code(path);
      expect(c).not.toMatch(/SIGNER_CLOCK_SKEW_MS|CLOCK_SKEW|skew|tolerance|leeway|grace/i);
      // The pure engine and assembler never read a clock; the service uses the DB transaction time.
      expect(c).not.toMatch(/Date\.now\(\)|new Date\(\s*\)|performance\.now\(\)/);
    });
});

describe('temporal comparisons are exact (no widening at the boundaries)', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 2, 1) + ms);
  it('an interval ending 1 ms after play began overlaps; ending exactly at the start does not', () => {
    const w = { from: t(1000).getTime(), to: t(5000).getTime() };
    const ended = (end: number) =>
      sliceAt(
        activeIntervals(
          [
            { status: 'ACTIVE', recordedAt: t(0) },
            { status: 'ENDED', recordedAt: t(end) },
          ],
          t(10_000),
        ),
        w,
      );
    expect(ended(1001)).toBe('DURING_OCCURRENCE');
    expect(ended(1000)).toBe('OUTSIDE');
    const began = (start: number) =>
      sliceAt(activeIntervals([{ status: 'ACTIVE', recordedAt: t(start) }], t(10_000)), w);
    expect(began(5000)).toBe('DURING_OCCURRENCE');
    expect(began(5001)).toBe('OUTSIDE');
  });

  it('a status fact recorded 1 ms after the cutoff does not exist at that cutoff', () => {
    const raw = {
      contestStatusChanges: [{ status: 'IN_PROGRESS', recordedAt: t(1001) }],
    } as unknown as RawParticipation;
    expect(occurrenceWindow(raw, t(1000), t(2000)).from).toBeUndefined();
    expect(occurrenceWindow(raw, t(1001), t(2000)).from).toBe(t(1001).getTime());
  });

  it('a key valid from T admits a fact issued at T but never at T − 1 ms', () => {
    const at = (iso: string) =>
      evaluateVerification(
        produce(referenceWorld(), (d) => {
          d.keys = d.keys!.map((k) =>
            k.principalId === FIX.athletePrincipalB ? { ...k, effectiveFrom: iso } : k,
          );
          d.attestations = [
            attestation('b-edge', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 60),
          ];
        }),
      ).trace.signedFacts!.find((f) => f.factType === 'ATTESTATION')!.keyTrust;
    expect(at('2026-03-01T10:00:00.000Z')).toBe('TRUSTED');
    expect(at('2026-03-01T10:00:00.001Z')).toBe('INVALID');
  });
});
