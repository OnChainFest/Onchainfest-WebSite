/**
 * Public verification DTOs (mirror @br/persistence PublicVerificationV1 / public run summary) and a
 * level ladder that always shows the exact level name — never a bare "Verified ✓", never a
 * percentage or score.
 */
export type Level = 'V0' | 'V1' | 'V2' | 'V3' | 'V4';
export type LevelStatus = 'SATISFIED' | 'BLOCKED' | 'NOT_REACHED' | 'NOT_DEFINED';

export interface LevelLine {
  level: Level;
  label: string;
  status: LevelStatus;
}

export interface Blocked {
  level: Level;
  label: string;
  blocked: { criterion: string; status: string; explanation: string }[];
}

export interface PublicVerification {
  schema: 'br:public-verification@1';
  resultVersionId: string;
  freshness: 'NOT_EVALUATED' | 'CURRENT' | 'STALE';
  evaluationState: string;
  level?: Level;
  label?: string;
  statement: string;
  notice: string;
  policy?: { code: string; version: number };
  evaluatedAsOf?: string;
  runId?: string;
  lastEvaluated?: {
    runId: string;
    level?: Level;
    label?: string;
    evaluatedAsOf: string;
    policy: { code: string; version: number };
  };
  reEvaluationRequired: boolean;
  activeDispute: boolean;
  levels?: LevelLine[];
  next?: Blocked;
}

export interface PublicVerificationRun {
  schema: 'br:public-verification-run@1';
  runId: string;
  historical: true;
  notice: string;
  statement: string;
  context: {
    resultVersionId: string;
    competition: { competitionId: string; name: string };
    event?: { eventId: string; name: string | null };
    contestId?: string;
  };
  policy: { code: string; version: number };
  engineVersion: string;
  evaluatedAsOf: string;
  evaluationState: string;
  level?: Level;
  label?: string;
  levels: LevelLine[];
  next?: Blocked;
  activeDispute: boolean;
}

const TONE: Record<LevelStatus, string> = {
  SATISFIED: '#15803d',
  BLOCKED: '#b45309',
  NOT_REACHED: '#6b7280',
  NOT_DEFINED: '#9ca3af',
};
const MARK: Record<LevelStatus, string> = {
  SATISFIED: '✓',
  BLOCKED: '—',
  NOT_REACHED: '·',
  NOT_DEFINED: '·',
};

export function LevelLadder({ levels, next }: { levels: LevelLine[]; next?: Blocked | undefined }) {
  return (
    <section style={{ marginTop: '1.25rem' }}>
      <h2 style={{ fontSize: '1.1rem' }}>Levels</h2>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {levels.map((l) => (
          <li key={l.level} style={{ color: TONE[l.status], marginBottom: '0.25rem' }}>
            <code>{l.level}</code> {MARK[l.status]} {l.label}{' '}
            <span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
              ({l.status.toLowerCase().replace('_', ' ')})
            </span>
          </li>
        ))}
      </ol>
      {next && (
        <div
          style={{ borderLeft: '3px solid #b45309', paddingLeft: '0.75rem', marginTop: '0.75rem' }}
        >
          <p style={{ margin: 0 }}>
            <strong>
              Next: {next.level} {next.label}
            </strong>{' '}
            — blocked:
          </p>
          <ul style={{ fontSize: '0.9rem' }}>
            {next.blocked.map((b) => (
              <li key={b.criterion}>
                <code>{b.criterion}</code>{' '}
                <span style={{ color: '#6b7280' }}>
                  ({b.status.toLowerCase().replaceAll('_', ' ')})
                </span>
                : {b.explanation}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <aside
      style={{
        background: '#f3f4f6',
        padding: '0.75rem 1rem',
        borderRadius: 8,
        fontSize: '0.9rem',
        margin: '1rem 0',
      }}
    >
      {text}
    </aside>
  );
}
