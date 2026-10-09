import type { PublicAthleteRef } from './achievement';
import { AthleteName } from './achievement';

/** BRT-09 public record DTOs (mirrors br:public-record-mark@1 etc.; public-safe by construction). */
export type RecordHolder =
  | { holderType: 'ATHLETE'; athlete: PublicAthleteRef }
  | { holderType: 'TEAM'; team: { teamId: string; name?: string } };

export interface PublicRecordMark {
  schema: 'br:public-record-mark@1';
  recordMarkId: string;
  recordLabel: string;
  category: { code: string; name: string; version: number; scopeType: string };
  metric: string;
  value: { value: string; unit: string; display: string };
  holder: RecordHolder;
  memberCredits?: { creditType: 'TEAM_MEMBER'; athlete: PublicAthleteRef }[];
  effectiveFrom: string;
  effectiveTo?: string;
  holding: 'CURRENT' | 'FORMER' | 'NOT_A_RECORD';
  status: string;
  statusLabel: string;
  statusStatement: string;
  statusReasons: { code: string; explanation: string }[];
  recognition: { level: string; region?: string[]; sport?: string; discipline?: string };
  verification: {
    basisLevelAtEstablishment: string;
    levelAtRatification?: string;
    statement: string;
  };
  ratification: { state: string; ratifiedAt?: string; statement: string };
  currentSupport?: {
    support: string;
    statement: string;
    reasons: { code: string; explanation: string }[];
  };
  recordSetAchievementId?: string;
  supersededByMarkId?: string;
  competition: { competitionId: string; name?: string };
  notice: string;
}

export interface HallOfFameItem {
  recordMarkId: string;
  categoryCode: string;
  scopeType: string;
  recordLabel: string;
  holding: 'CURRENT' | 'FORMER';
  status: string;
  holder: RecordHolder;
  value: { display: string };
  effectiveFrom: string;
  effectiveTo?: string;
  recognition: { level: string; region?: string[]; sport?: string };
  recordSetAchievementId?: string;
}

export interface PassportRecordItem {
  recordMarkId: string;
  categoryCode: string;
  recordLabel: string;
  scopeType: string;
  holding: 'CURRENT' | 'FORMER';
  status: string;
  creditType: 'HOLDER' | 'TEAM_MEMBER';
  holderType: 'ATHLETE' | 'TEAM';
  value: string;
  effectiveFrom: string;
  effectiveTo?: string;
  recordSetAchievementId?: string;
}

export function HolderName({ h }: { h: RecordHolder }) {
  return h.holderType === 'TEAM' ? (
    <>Team {h.team.name ?? '(unnamed)'}</>
  ) : (
    <AthleteName a={h.athlete} />
  );
}

const day = (iso: string) => iso.slice(0, 10);
export function Period({ from, to }: { from: string; to?: string }) {
  return (
    <>
      {day(from)} → {to === undefined ? 'present' : day(to)}
    </>
  );
}

/** CURRENT / FORMER / not-a-record badges; PENDING and RESCINDED are never shown as records. */
export function HoldingBadge({ holding, status }: { holding: string; status: string }) {
  const text =
    holding === 'CURRENT'
      ? 'Current record holder'
      : holding === 'FORMER'
        ? 'Former record holder'
        : status === 'RESCINDED'
          ? 'RESCINDED — not a record'
          : 'Pending ratification — not a record';
  const bg = holding === 'CURRENT' ? '#dcfce7' : holding === 'FORMER' ? '#e5e7eb' : '#fee2e2';
  return (
    <span
      style={{
        marginLeft: 8,
        padding: '0.1rem 0.45rem',
        borderRadius: 6,
        fontSize: '0.75rem',
        background: bg,
      }}
    >
      {text}
    </span>
  );
}

export function PassportRecordItemView({ x }: { x: PassportRecordItem }) {
  return (
    <li>
      <a href={`/records/${x.recordMarkId}`}>{x.recordLabel}</a> — {x.value}{' '}
      <HoldingBadge holding={x.holding} status={x.status} />
      {x.creditType === 'TEAM_MEMBER' && <small> (credited team member of the TEAM record)</small>}
      <br />
      <small>
        <Period
          from={x.effectiveFrom}
          {...(x.effectiveTo === undefined ? {} : { to: x.effectiveTo })}
        />
        {x.recordSetAchievementId !== undefined && (
          <>
            {' · '}
            <a href={`/achievements/${x.recordSetAchievementId}`}>Record set achievement</a>
          </>
        )}
      </small>
    </li>
  );
}
