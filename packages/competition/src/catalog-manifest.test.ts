import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CATALOG,
  catalogSpecHash,
  competitionAcceptsEvents,
  CompetitionLifecycle,
  competitionProfileEditable,
  disciplineBelongsToSport,
  DISCIPLINE_CODE,
  eventCapacityEditable,
  EventLifecycle,
  eventSettingsEditable,
  FORMAT_CODE,
  formatEngine,
  isTerminal,
  SPORT_CODE,
  validateDisciplineVersionSpec,
} from './index';

describe('ONCF-03A canonical catalog manifest', () => {
  const disciplines = CANONICAL_CATALOG.sports.flatMap((s) =>
    s.disciplines.map((d) => ({ sport: s.code, ...d })),
  );

  it('covers padel and tennis, and nothing that cannot be run', () => {
    expect(CANONICAL_CATALOG.sports.map((s) => s.code)).toEqual(['padel', 'tennis']);
    expect(disciplines.map((d) => d.code)).toEqual([
      'padel.doubles',
      'tennis.singles',
      'tennis.doubles',
    ]);
    expect(disciplines.some((d) => d.sport === 'running')).toBe(false);
  });

  it('has valid codes and specifications', () => {
    for (const s of CANONICAL_CATALOG.sports) expect(SPORT_CODE.test(s.code), s.code).toBe(true);
    for (const d of disciplines) {
      expect(DISCIPLINE_CODE.test(d.code), d.code).toBe(true);
      expect(disciplineBelongsToSport(d.code, d.sport), d.code).toBe(true);
      expect(validateDisciplineVersionSpec(d.spec), d.code).toEqual([]);
    }
    for (const f of CANONICAL_CATALOG.formats) {
      expect(FORMAT_CODE.test(f.code), f.code).toBe(true);
      expect(formatEngine(f.engineId, f.engineVersion), f.code).toBeDefined();
    }
  });

  it('gives every discipline at least one format whose contest type it allows', () => {
    const contestTypes = CANONICAL_CATALOG.formats.map(
      (f) => formatEngine(f.engineId, f.engineVersion)?.contestType,
    );
    for (const d of disciplines)
      expect(
        contestTypes.some((t) => t !== undefined && d.spec.allowedContestTypes.includes(t)),
        d.code,
      ).toBe(true);
  });

  it('declares the entrant kind each discipline is played with', () => {
    const kinds = Object.fromEntries(
      disciplines.map((d) => [d.code, d.spec.participation.participantKinds]),
    );
    expect(kinds).toEqual({
      'padel.doubles': ['TEAM'],
      'tennis.singles': ['INDIVIDUAL'],
      'tennis.doubles': ['TEAM'],
    });
  });

  it('keeps specification hashes stable (changing one needs a new catalog version)', () => {
    const hashes = Object.fromEntries(
      disciplines.map((d) => [d.code, catalogSpecHash('br:discipline-version-spec', d.spec)]),
    );
    // Padel and tennis doubles share the racket-match semantics, so their content is identical.
    expect(hashes['padel.doubles']).toBe(hashes['tennis.doubles']);
    expect(hashes['tennis.singles']).not.toBe(hashes['padel.doubles']);
  });
});

describe('ONCF-03A edit windows restate the lifecycle rules', () => {
  it('competition profile is editable until terminal; events are added while DRAFT/PUBLISHED/ACTIVE', () => {
    for (const s of CompetitionLifecycle.states) {
      expect(competitionProfileEditable(s), s).toBe(!isTerminal(CompetitionLifecycle, s));
      expect(competitionAcceptsEvents(s), s).toBe(['DRAFT', 'PUBLISHED', 'ACTIVE'].includes(s));
    }
  });

  it('event settings lock at FIELD_LOCKED; capacity and registration mode after DRAFT', () => {
    for (const s of EventLifecycle.states) {
      expect(eventSettingsEditable(s), s).toBe(
        ['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(s),
      );
      expect(eventCapacityEditable(s), s).toBe(s === 'DRAFT');
    }
  });
});
