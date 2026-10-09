import { describe, expect, it } from 'vitest';
import {
  availableRegistrationDecisions,
  canTransition,
  EventLifecycle,
  REGISTRATION_DECISIONS,
  registrationCanWithdraw,
  registrationDecisionsOpen,
  RegistrationLifecycle,
  registrationWithdrawable,
  type EventStatus,
  type RegistrationStatus,
} from './lifecycle';

// ONCF-04: the registration windows restate the lifecycle; they must never offer a decision the
// registration lifecycle refuses, nor any decision once the field is locked.

const EVENT_STATUSES = EventLifecycle.states as EventStatus[];
const STATUSES = RegistrationLifecycle.states as RegistrationStatus[];

describe('registration windows', () => {
  it('decisions are open only while registration is open or closed (before the lock)', () => {
    expect(EVENT_STATUSES.filter(registrationDecisionsOpen)).toEqual([
      'REGISTRATION_OPEN',
      'REGISTRATION_CLOSED',
    ]);
    expect(EVENT_STATUSES.filter(registrationWithdrawable)).toEqual([
      'DRAFT',
      'REGISTRATION_OPEN',
      'REGISTRATION_CLOSED',
    ]);
  });

  it('offers exactly the lifecycle’s transitions, per status', () => {
    expect(availableRegistrationDecisions('REQUESTED', 'REGISTRATION_OPEN')).toEqual([
      'CONFIRM',
      'WAITLIST',
      'DECLINE',
    ]);
    expect(availableRegistrationDecisions('WAITLISTED', 'REGISTRATION_CLOSED')).toEqual([
      'CONFIRM',
      'DECLINE',
    ]);
    expect(availableRegistrationDecisions('CONFIRMED', 'REGISTRATION_OPEN')).toEqual(['CANCEL']);
    for (const s of ['DECLINED', 'WITHDRAWN', 'CANCELLED'] as const)
      expect(availableRegistrationDecisions(s, 'REGISTRATION_OPEN')).toEqual([]);
    for (const status of STATUSES)
      for (const e of EVENT_STATUSES)
        for (const d of availableRegistrationDecisions(status, e))
          expect(canTransition(RegistrationLifecycle, status, REGISTRATION_DECISIONS[d])).toBe(
            true,
          );
  });

  it('nothing is offered after the field lock', () => {
    for (const e of ['FIELD_LOCKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const)
      for (const s of STATUSES) {
        expect(availableRegistrationDecisions(s, e)).toEqual([]);
        expect(registrationCanWithdraw(s, e)).toBe(false);
      }
  });

  it('withdrawal follows the lifecycle (active entries only)', () => {
    expect(STATUSES.filter((s) => registrationCanWithdraw(s, 'REGISTRATION_OPEN'))).toEqual([
      'REQUESTED',
      'WAITLISTED',
      'CONFIRMED',
    ]);
  });
});
