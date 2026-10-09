import type { RuleBasis } from '../ruleset';
import type { SchedulingProfileSpec } from './profile';

export interface SchedulingProfileTemplate {
  readonly code: string;
  readonly name: string;
  readonly spec: SchedulingProfileSpec;
  readonly basis: RuleBasis;
}

/**
 * Canonical SchedulingProfile versions (ONCF-05E-B, ADR-0072). Templates are catalog DATA provisioned
 * by the operator; the same generic spec type serves every sport and only values differ. No
 * governing body fixes slot lengths, changeovers or rest for these shapes, so every basis is
 * COMMON_PRACTICE and names the choice. Organizers pin a version as published; there are no
 * per-event overrides (real-world changes are reasoned assignment adjustments, ADR-0070).
 *
 * What is deliberately NOT here (owned elsewhere, never duplicated): wave sizes, group sizes,
 * interval-start offsets and lanes (format plan), periods and games per block (ruleset), capacity
 * values and attributes (resource), opening hours (availability), feeders (05D).
 */
export const SCHEDULING_PROFILE_TEMPLATES: readonly SchedulingProfileTemplate[] = [
  {
    code: 'tennis-court-match',
    name: 'Court match (best of three sets)',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'TENNIS_COURT',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 5_400,
          changeoverSeconds: 600,
          rest: { minimumSeconds: 3_600, enforcement: 'SOFT' },
          dependencyLeadSeconds: 900,
          maxUnitsPerEntrantPerDay: { value: 2, enforcement: 'SOFT' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a 90-minute slot per best-of-three match, 10 minutes to turn the court over, at least one hour between a player’s matches and no more than two a day (both soft), 15 minutes after a feeder match for the result to be official',
    },
  },
  {
    code: 'padel-court-match',
    name: 'Padel court match (doubles, best of three sets)',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'PADEL_COURT',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 5_400,
          changeoverSeconds: 600,
          rest: { minimumSeconds: 3_600, enforcement: 'SOFT' },
          dependencyLeadSeconds: 900,
          maxUnitsPerEntrantPerDay: { value: 3, enforcement: 'SOFT' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a 90-minute slot per doubles match, 10 minutes of court changeover, at least one hour between a pair’s matches and up to three a day (both soft)',
    },
  },
  {
    code: 'road-course-waves',
    name: 'Road course, wave starts (marathon window)',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'ROAD_COURSE',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 21_600,
          changeoverSeconds: 0,
          startSpacingSeconds: 900,
          maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'runners occupy the course for up to six hours from their wave’s start (the course-closing window); waves start at least 15 minutes apart; a runner starts once a day',
    },
  },
  {
    code: 'pool-heats',
    name: 'Pool heats (lanes are seeding slots)',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'POOL',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 300,
          changeoverSeconds: 60,
          rest: { minimumSeconds: 1_800, enforcement: 'SOFT' },
          dependencyLeadSeconds: 1_800,
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'the pool is booked one heat at a time: five minutes per heat (start, race, exit) and one minute to clear the deck; heats → final leaves 30 minutes for results; 30 minutes of rest between a swimmer’s races (soft)',
    },
  },
  {
    code: 'cycling-course-stage',
    name: 'Cycling course: mass-start stage or time-trial session',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'CYCLING_COURSE',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 18_000,
          changeoverSeconds: 1_800,
          startSpacingSeconds: 300,
          maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' },
        },
        {
          selector: { contestType: 'SESSION' },
          resourceType: 'CYCLING_COURSE',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 3_600,
          changeoverSeconds: 900,
          maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a road stage keeps the course for up to five hours, start groups leave five minutes apart and the course needs 30 minutes to reopen; a time-trial session’s riders start at the plan’s intervals and each rides for up to an hour; one stage per rider per day',
    },
  },
  {
    code: 'bowling-lane-pair-blocks',
    name: 'Bowling lane pairs: qualifying blocks and stepladder matches',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'BOWLING_LANE_PAIR',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 9_000,
          changeoverSeconds: 900,
          rest: { minimumSeconds: 1_800, enforcement: 'SOFT' },
        },
        {
          selector: { contestType: 'MATCH' },
          resourceType: 'BOWLING_LANE_PAIR',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 1_200,
          changeoverSeconds: 300,
          dependencyLeadSeconds: 300,
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a squad bowls a six-game block on its lane pairs in about two and a half hours, then 15 minutes of lane maintenance; bowlers per pair count against the pair’s capacity; a stepladder match is one game on a pair, five minutes after its feeder',
    },
  },
  {
    code: 'basketball-court-game',
    name: 'Basketball court game (4 × 10 min)',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'BASKETBALL_COURT',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 7_200,
          changeoverSeconds: 900,
          rest: { minimumSeconds: 10_800, enforcement: 'SOFT' },
          dependencyLeadSeconds: 1_800,
          maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'SOFT' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a two-hour slot per four-period game including warm-up and stoppages, 15 minutes between games on a court, three hours of rest and one game per team per day (soft)',
    },
  },
  {
    code: 'basketball-half-court-3x3',
    name: 'Half-court 3x3 game',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'BASKETBALL_HALF_COURT',
          capacityUnit: 'CONTEST',
          expectedDurationSeconds: 1_500,
          changeoverSeconds: 300,
          rest: { minimumSeconds: 1_200, enforcement: 'SOFT' },
        },
      ],
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a 25-minute slot per ten-minute game, five minutes of changeover, 20 minutes between a team’s games (soft)',
    },
  },
  {
    code: 'golf-course-tee-groups',
    name: 'Golf course: tee groups, two starting tees',
    spec: {
      specVersion: 1,
      requirements: [
        {
          selector: {},
          resourceType: 'GOLF_COURSE',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 14_400,
          changeoverSeconds: 0,
          startSpacingSeconds: 600,
          concurrentStarts: 2,
          maxUnitsPerEntrantPerDay: { value: 1, enforcement: 'HARD' },
        },
        {
          selector: { contestType: 'MATCH' },
          resourceType: 'GOLF_COURSE',
          capacityUnit: 'ENTRANT',
          expectedDurationSeconds: 14_400,
          changeoverSeconds: 0,
          startSpacingSeconds: 600,
          dependencyLeadSeconds: 1_800,
          maxUnitsPerEntrantPerDay: { value: 2, enforcement: 'SOFT' },
        },
      ],
      regrouping: { groupSize: 3, order: 'FIELD_ORDINAL_DESC' },
    },
    basis: {
      kind: 'COMMON_PRACTICE',
      note: 'a four-hour round per tee group, groups 10 minutes apart from two starting tees, one round per player per day; after a cut the field is regrouped in threes, the leaders teeing off last; a match-play match follows its feeder by 30 minutes',
    },
  },
];
