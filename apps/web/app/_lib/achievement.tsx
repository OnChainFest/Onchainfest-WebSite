/**
 * BRT-08 public Achievement presentation (PUBLIC endpoints only). Precise wording: an Achievement is
 * never "V2" — it is "derived from a V2 Event Certified result"; a non-current Achievement is shown
 * as historical, never as a bare "Verified ✓". TEAM Achievements show the TEAM as holder and the
 * credited athletes as member credits (never as holders).
 */
export interface PublicAthleteRef {
  privateEntrant?: true;
  athleteId?: string;
  slug?: string;
  displayName?: string;
}

export interface PublicAchievement {
  schema: 'br:public-achievement@1';
  achievementId: string;
  type: string;
  typeLabel: string;
  displayName: string;
  holder:
    | { holderType: 'ATHLETE'; athlete: PublicAthleteRef }
    | { holderType: 'TEAM'; team: { teamId: string; name?: string } };
  memberCredits?: { creditType: 'TEAM_MEMBER'; creditRole: string; athlete: PublicAthleteRef }[];
  context: {
    sport?: string;
    discipline?: string;
    competition: { competitionId: string; name?: string };
    event?: { eventId: string; name?: string };
    scopeType: string;
  };
  qualifyingValue?: { display: string };
  verification: {
    levelAtDerivation: string;
    label: string;
    statement: string;
    governingRecognition?: {
      level: string;
      region?: string[];
      sport?: string[];
      statement: string;
    };
  };
  rule: { code: string; version: number; engineVersion: string };
  currentSupport: {
    status: 'ACTIVE' | 'SUSPENDED' | 'SUPERSEDED' | 'REVOKED';
    currentlySupported: boolean;
    statement: string;
    reasons: { code: string; explanation: string }[];
    since: string;
    supersededBy?: string;
    supersedes: string[];
    assessedLive: boolean;
  };
  derivedAt: string;
  notice: string;
}

export interface PassportAchievement {
  achievementId: string;
  typeLabel: string;
  displayName: string;
  creditType: 'HOLDER' | 'TEAM_MEMBER';
  holderType: 'ATHLETE' | 'TEAM';
  teamName?: string;
  competitionName: string;
  eventName?: string;
  qualifyingValue?: string;
  derivedFrom: string;
  currentSupport: string;
  currentlySupported: boolean;
  rule: { code: string; version: number };
}

export function AthleteName({ a }: { a: PublicAthleteRef }) {
  if (a.privateEntrant === true || a.slug === undefined) return <span>Private entrant</span>;
  return <a href={`/athletes/${a.slug}`}>{a.displayName ?? a.slug}</a>;
}

export function SupportBadge({ status }: { status: string }) {
  const current = status === 'ACTIVE';
  return (
    <span
      style={{
        marginLeft: 8,
        padding: '0.1rem 0.45rem',
        borderRadius: 6,
        fontSize: '0.75rem',
        background: current ? '#dcfce7' : '#fef3c7',
        color: current ? '#166534' : '#92400e',
      }}
    >
      {current ? 'Currently supported' : `Historical — ${status.toLowerCase()}`}
    </span>
  );
}

export function PassportAchievementItem({ x }: { x: PassportAchievement }) {
  return (
    <li>
      <a href={`/achievements/${x.achievementId}`}>{x.displayName}</a>{' '}
      <small>({x.typeLabel})</small> — {x.competitionName}
      {x.eventName !== undefined && <> · {x.eventName}</>}
      {x.qualifyingValue !== undefined && <> · {x.qualifyingValue}</>}
      {x.creditType === 'TEAM_MEMBER' && (
        <small>
          {' '}
          · credited as a team member{x.teamName !== undefined ? ` of ${x.teamName}` : ''}
        </small>
      )}
      <SupportBadge status={x.currentSupport} />
      <br />
      <small style={{ color: '#6b7280' }}>
        {x.derivedFrom} Rule {x.rule.code} v{x.rule.version}.
      </small>
    </li>
  );
}
