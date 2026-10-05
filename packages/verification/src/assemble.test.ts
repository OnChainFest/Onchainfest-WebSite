import { describe, expect, it } from 'vitest';
import { ParticipationIndex, type RawParticipation, type RawStatusChange } from './assemble';

const t = (m: number) => new Date(Date.UTC(2026, 2, 1, 9, m));
const id = (n: number) => `00000000-0000-8000-a000-${String(n).padStart(12, '0')}`;
const P = { A: id(1), B: id(2) }; // participants
const ATH = { a1: id(11), a2: id(12), b1: id(13) };
const PER = {
  a1: id(21),
  a2: id(22),
  b1: id(23),
  guardian: id(24),
  manager: id(25),
  admin: id(26),
  staff: id(27),
  outsider: id(28),
};
const PR = {
  a1: id(31),
  a2: id(32),
  b1: id(33),
  guardian: id(34),
  manager: id(35),
  admin: id(36),
  staff: id(37),
  org: id(38),
  teamOrg: id(39),
  outsider: id(40),
};
const TEAM = id(51);
const active = (m: number): RawStatusChange[] => [{ status: 'ACTIVE', recordedAt: t(m) }];
const SUBMITTED = t(30);
const ORG = { organizer: id(61), team: id(62) };

const raw: RawParticipation = {
  contestants: [
    { participantId: P.A, recordedAt: t(0) },
    { participantId: P.B, recordedAt: t(0) },
  ],
  contestStatusChanges: [
    { status: 'IN_PROGRESS', recordedAt: t(6) },
    { status: 'COMPLETED', recordedAt: t(20) },
  ],
  participants: [
    { participantId: P.A, kind: 'TEAM', teamId: TEAM, recordedAt: t(0) },
    { participantId: P.B, kind: 'INDIVIDUAL', athleteId: ATH.b1, recordedAt: t(0) },
  ],
  athletes: [
    { athleteId: ATH.a1, personId: PER.a1, recordedAt: t(0) },
    { athleteId: ATH.a2, personId: PER.a2, recordedAt: t(0) },
    { athleteId: ATH.b1, personId: PER.b1, recordedAt: t(0) },
  ],
  teamMemberships: [{ teamId: TEAM, athleteId: ATH.a1, statusChanges: active(0) }],
  teamManagers: [{ teamId: TEAM, personId: PER.manager, recordedAt: t(0) }],
  teamOrganizations: [{ teamId: TEAM, organizationId: ORG.team, recordedAt: t(0) }],
  lineupMembers: [{ participantId: P.A, athleteId: ATH.a2, recordedAt: t(5) }],
  guardians: [
    {
      guardianPersonId: PER.guardian,
      dependentPersonId: PER.b1,
      effectiveFrom: t(0),
      statusChanges: active(0),
    },
  ],
  personPrincipals: [
    { personId: PER.a1, principalId: PR.a1, recordedAt: t(0) },
    { personId: PER.a2, principalId: PR.a2, recordedAt: t(0) },
    { personId: PER.b1, principalId: PR.b1, recordedAt: t(0) },
    { personId: PER.guardian, principalId: PR.guardian, recordedAt: t(0) },
    { personId: PER.manager, principalId: PR.manager, recordedAt: t(0) },
    { personId: PER.admin, principalId: PR.admin, recordedAt: t(0) },
    { personId: PER.staff, principalId: PR.staff, recordedAt: t(0) },
    { personId: PER.outsider, principalId: PR.outsider, recordedAt: t(0) },
  ],
  organizationPrincipals: [
    { organizationId: ORG.organizer, principalId: PR.org, recordedAt: t(0) },
    { organizationId: ORG.team, principalId: PR.teamOrg, recordedAt: t(0) },
  ],
  organizerOrganizationId: ORG.organizer,
  organizerAdmins: [{ personId: PER.admin, statusChanges: active(0) }],
  staff: [{ personId: PER.staff, statusChanges: active(0) }],
};

describe('ParticipationIndex — structural facts only (no PII, no policy)', () => {
  const idx = new ParticipationIndex(raw, t(40), 'CONTEST', SUBMITTED);
  const kinds = (p: string) =>
    idx
      .relationsOf(p)
      .map((r) => `${r.kind}${r.participantId === undefined ? '' : `@${r.participantId}`}`)
      .sort();

  it('maps athlete participants to their explicit PERSON principals (never Person.id)', () => {
    expect(idx.principalOfAthleteParticipant(P.B)).toEqual(expect.arrayContaining([PR.b1]));
    expect(idx.principalOfAthleteParticipant(P.B)).not.toContain(PER.b1);
  });

  it('answers every participation question', () => {
    expect(kinds(PR.b1)).toEqual([`SELF_PARTICIPANT@${P.B}`]);
    expect(kinds(PR.a1)).toEqual([`TEAM_MEMBER_OF_PARTICIPANT@${P.A}`]);
    expect(kinds(PR.a2)).toEqual([`LINEUP_MEMBER_OF_PARTICIPANT@${P.A}`]);
    expect(kinds(PR.manager)).toEqual([`TEAM_MANAGER_OF_PARTICIPANT@${P.A}`]);
    expect(kinds(PR.guardian)).toEqual([`GUARDIAN_OF_PARTICIPANT@${P.B}`]);
    expect(kinds(PR.teamOrg)).toEqual([`TEAM_AFFILIATED_ORGANIZATION@${P.A}`]);
    expect(kinds(PR.org)).toEqual(['ORGANIZER_ORGANIZATION']);
    expect(kinds(PR.admin)).toEqual(['ORGANIZER_ORGANIZATION_ADMIN']);
    expect(kinds(PR.staff)).toEqual(['COMPETITION_STAFF']);
    expect(kinds(PR.outsider)).toEqual([]);
    expect(idx.sidesComplete).toBe(true);
  });

  it('resolution: mapped persons/organizations and PLATFORM/SYSTEM are RESOLVED; unmapped are not', () => {
    expect(idx.resolution(PR.outsider, 'PERSON')).toBe('RESOLVED');
    expect(idx.resolution(id(99), 'PERSON')).toBe('UNRESOLVED');
    expect(idx.resolution(id(98), 'ORGANIZATION')).toBe('UNRESOLVED');
    expect(idx.resolution(id(97), 'SYSTEM')).toBe('RESOLVED');
  });

  it('knowledge cutoff: facts recorded after asOf are unknown; an unresolved slot makes sides incomplete', () => {
    const early = new ParticipationIndex(raw, t(1), 'CONTEST', SUBMITTED);
    expect(early.relationsOf(PR.a2)).toEqual([]); // lineup declared at t(5)
    const open = new ParticipationIndex(
      { ...raw, contestants: [{ participantId: P.A, recordedAt: t(0) }, { recordedAt: t(0) }] },
      t(40),
      'CONTEST',
      SUBMITTED,
    );
    expect(open.sidesComplete).toBe(false);
  });
});

describe('ParticipationIndex — temporal slicing at the contest occurrence window (BRT-07R)', () => {
  // Occurrence window W = [IN_PROGRESS t(6), min(COMPLETED t(20), submitted t(30))] = [t(6), t(20)].
  const withMembership = (changes: RawStatusChange[], extra: Partial<RawParticipation> = {}) => ({
    ...raw,
    teamMemberships: [{ teamId: TEAM, athleteId: ATH.a1, statusChanges: changes }],
    ...extra,
  });
  const at = (r: RawParticipation, asOf = t(40)) =>
    new ParticipationIndex(r, asOf, 'CONTEST', SUBMITTED);

  it('window: from = first IN_PROGRESS, to = earliest of COMPLETED and submission', () => {
    expect(at(raw).window).toEqual({ from: t(6).getTime(), to: t(20).getTime() });
    const noStart = at({ ...raw, contestStatusChanges: [] });
    expect(noStart.window).toEqual({ to: SUBMITTED.getTime() });
  });

  it('a membership that ENDED before the occurrence is not a teammate', () => {
    const idx = at(withMembership([...active(0), { status: 'ENDED', recordedAt: t(3) }]));
    expect(idx.relationsOf(PR.a1)).toEqual([]);
    expect(idx.resolution(PR.a1, 'PERSON')).toBe('RESOLVED');
    expect(idx.principalOfAthleteParticipant(P.A)).not.toContain(PR.a1);
  });

  it('a membership that BEGAN after the occurrence is not a teammate', () => {
    const idx = at(withMembership(active(25)));
    expect(idx.relationsOf(PR.a1)).toEqual([]);
    expect(idx.resolution(PR.a1, 'PERSON')).toBe('RESOLVED');
  });

  it('a membership active during the occurrence (even partially) is a teammate', () => {
    for (const changes of [
      active(0),
      [...active(0), { status: 'ENDED', recordedAt: t(10) }],
      active(15),
    ]) {
      const idx = at(withMembership(changes));
      expect(idx.relationsOf(PR.a1)).toEqual([
        { kind: 'TEAM_MEMBER_OF_PARTICIPANT', participantId: P.A, timing: 'DURING_OCCURRENCE' },
      ]);
      expect(idx.principalOfAthleteParticipant(P.A)).toContain(PR.a1);
    }
  });

  it('historical asOf never uses facts unknown at the cutoff (a later ENDED is ignored)', () => {
    const r = withMembership([...active(0), { status: 'ENDED', recordedAt: t(3) }], {
      contestStatusChanges: [{ status: 'IN_PROGRESS', recordedAt: t(1) }],
    });
    // As known at t(2): the membership was still open and play had started → teammate.
    expect(at(r, t(2)).relationsOf(PR.a1)).toEqual([
      { kind: 'TEAM_MEMBER_OF_PARTICIPANT', participantId: P.A, timing: 'DURING_OCCURRENCE' },
    ]);
    // As known now: it ended at t(3), after play began at t(1) → still overlapped → teammate.
    expect(at(r).relationsOf(PR.a1)[0]?.timing).toBe('DURING_OCCURRENCE');
    // An occurrence start recorded after the cutoff is unknown at the cutoff.
    const late = withMembership([...active(0), { status: 'ENDED', recordedAt: t(3) }], {
      contestStatusChanges: [{ status: 'IN_PROGRESS', recordedAt: t(35) }],
    });
    expect(at(late, t(34)).resolution(PR.a1, 'PERSON')).toBe('TEMPORALLY_UNDETERMINED');
  });

  it('undeterminable temporal state is UNDETERMINED — never "conflicted forever", never "conflict-free"', () => {
    const idx = at(
      withMembership([...active(0), { status: 'ENDED', recordedAt: t(3) }], {
        contestStatusChanges: [], // occurrence start unknown: did it end before play? unknowable
      }),
    );
    expect(idx.relationsOf(PR.a1)).toEqual([
      { kind: 'TEAM_MEMBER_OF_PARTICIPANT', participantId: P.A, timing: 'UNDETERMINED' },
    ]);
    expect(idx.resolution(PR.a1, 'PERSON')).toBe('TEMPORALLY_UNDETERMINED');
    expect(idx.principalOfAthleteParticipant(P.A)).not.toContain(PR.a1);
    expect(idx.undeterminedPrincipals.has(PR.a1)).toBe(true);
  });

  it('a direct Participant and an exact-lineup member remain related regardless of time', () => {
    const idx = at({
      ...raw,
      contestStatusChanges: [],
      teamMemberships: [
        {
          teamId: TEAM,
          athleteId: ATH.a2,
          statusChanges: [...active(0), { status: 'ENDED', recordedAt: t(2) }],
        },
      ],
    });
    expect(idx.relationsOf(PR.b1)).toEqual([
      { kind: 'SELF_PARTICIPANT', participantId: P.B, timing: 'STRUCTURAL' },
    ]);
    // a2 is in the exact lineup of P.A: membership is not re-judged (the lineup takes precedence).
    expect(idx.relationsOf(PR.a2)).toEqual([
      { kind: 'LINEUP_MEMBER_OF_PARTICIPANT', participantId: P.A, timing: 'STRUCTURAL' },
    ]);
    expect(idx.resolution(PR.a2, 'PERSON')).toBe('RESOLVED');
  });

  it('staff, admin, manager and guardian relations are sliced at the same window', () => {
    const idx = at({
      ...raw,
      staff: [
        {
          personId: PER.staff,
          statusChanges: [...active(0), { status: 'ENDED', recordedAt: t(4) }],
        },
      ],
      organizerAdmins: [{ personId: PER.admin, statusChanges: active(25) }],
      teamManagers: [{ teamId: TEAM, personId: PER.manager, recordedAt: t(25) }],
      guardians: [
        {
          guardianPersonId: PER.guardian,
          dependentPersonId: PER.b1,
          effectiveFrom: t(0),
          statusChanges: [...active(0), { status: 'REVOKED', recordedAt: t(5) }],
        },
      ],
    });
    expect(idx.relationsOf(PR.staff)).toEqual([]);
    expect(idx.relationsOf(PR.admin)).toEqual([]);
    expect(idx.relationsOf(PR.manager)).toEqual([]);
    expect(idx.relationsOf(PR.guardian)).toEqual([]);
  });
});
