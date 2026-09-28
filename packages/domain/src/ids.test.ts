import { describe, expect, it } from 'vitest';
import { fromTypeId, isUuid, isUuidV7, newId, parseUuid, toTypeId } from './ids';
import { isWithin, toCanonicalTimestamp, windowContains } from './time';

describe('identifiers (ADR-0013)', () => {
  it('generates canonical, time-ordered UUIDv7 ids', () => {
    const ids = Array.from({ length: 200 }, () => newId());
    for (const id of ids) {
      expect(isUuidV7(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('parses external ids: uppercase lowercased, other forms rejected', () => {
    const id = newId();
    expect(parseUuid(id.toUpperCase())).toBe(id);
    expect(() => parseUuid(`{${id}}`)).toThrow();
    expect(() => parseUuid(`urn:uuid:${id}`)).toThrow();
    expect(isUuid(id.replaceAll('-', ''))).toBe(false);
  });

  it('round-trips TypeID presentation and enforces the prefix', () => {
    const id = newId();
    const typeId = toTypeId('rv', id);
    expect(typeId).toMatch(/^rv_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    expect(fromTypeId('rv', typeId)).toBe(id);
    expect(() => fromTypeId('result', typeId)).toThrow();
  });
});

describe('time helpers', () => {
  it('renders canonical millisecond UTC timestamps', () => {
    expect(toCanonicalTimestamp(new Date('2026-05-14T12:03:07.12-06:00'))).toBe(
      '2026-05-14T18:03:07.120Z',
    );
  });

  it('treats validity windows as half-open [from, to)', () => {
    const w = { effectiveFrom: new Date(1000), effectiveTo: new Date(2000) };
    expect(isWithin(w, new Date(1000))).toBe(true);
    expect(isWithin(w, new Date(1999))).toBe(true);
    expect(isWithin(w, new Date(2000))).toBe(false);
    expect(windowContains(w, { effectiveFrom: new Date(1500) })).toBe(false);
    expect(windowContains({ effectiveFrom: new Date(0) }, w)).toBe(true);
  });
});
