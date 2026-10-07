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

describe('ONCF-03A canonical catalog manifest (version histories since ONCF-05B)', () => {
  const disciplines = CANONICAL_CATALOG.sports.flatMap((s) =>
    s.disciplines.map((d) => ({ sport: s.code, ...d })),
  );
  const v1 = (code: string) => disciplines.find((d) => d.code === code)?.specs[0];

  it('keeps the ONCF-03A racket disciplines first in their histories and adds nothing unrunnable', () => {
    expect(CANONICAL_CATALOG.sports.slice(0, 2).map((s) => s.code)).toEqual(['padel', 'tennis']);
    expect(disciplines.slice(0, 3).map((d) => d.code)).toEqual([
      'padel.doubles',
      'tennis.singles',
      'tennis.doubles',
    ]);
    // running.5k stays dev-only; the canonical running disciplines are parameterised by data.
    expect(disciplines.some((d) => d.code === 'running.5k')).toBe(false);
  });

  it('has valid codes and specifications', () => {
    for (const s of CANONICAL_CATALOG.sports) expect(SPORT_CODE.test(s.code), s.code).toBe(true);
    for (const d of disciplines) {
      expect(DISCIPLINE_CODE.test(d.code), d.code).toBe(true);
      expect(disciplineBelongsToSport(d.code, d.sport), d.code).toBe(true);
      for (const spec of d.specs) expect(validateDisciplineVersionSpec(spec), d.code).toEqual([]);
    }
    for (const f of CANONICAL_CATALOG.formats) {
      expect(FORMAT_CODE.test(f.code), f.code).toBe(true);
      for (const v of f.versions)
        expect(formatEngine(v.engineId, v.engineVersion), f.code).toBeDefined();
    }
  });

  it('gives every discipline version at least one format version whose contest type it allows', () => {
    const contestTypes = CANONICAL_CATALOG.formats.flatMap((f) =>
      f.versions.map((v) => formatEngine(v.engineId, v.engineVersion)?.contestType),
    );
    for (const d of disciplines)
      for (const spec of d.specs)
        expect(
          contestTypes.some((t) => t !== undefined && spec.allowedContestTypes.includes(t)),
          d.code,
        ).toBe(true);
  });

  it('declares the entrant kind each ONCF-03A discipline is played with', () => {
    expect(v1('padel.doubles')?.participation.participantKinds).toEqual(['TEAM']);
    expect(v1('tennis.singles')?.participation.participantKinds).toEqual(['INDIVIDUAL']);
    expect(v1('tennis.doubles')?.participation.participantKinds).toEqual(['TEAM']);
  });

  it('keeps v1 specification hashes stable (changing one needs a new catalog version)', () => {
    const h = (code: string) => catalogSpecHash('br:discipline-version-spec', v1(code));
    // Padel and tennis doubles share the racket-match semantics, so their v1 content is identical.
    expect(h('padel.doubles')).toBe(h('tennis.doubles'));
    expect(h('tennis.singles')).not.toBe(h('padel.doubles'));
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
