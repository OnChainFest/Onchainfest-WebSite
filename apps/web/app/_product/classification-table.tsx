import { decidedByLabel, type StageClassification } from '../_lib/scoring';

/**
 * A classification-engine/2 table (ONCF-05C), shared by the Structure page's classification
 * proposal and the ONCF-L6 official standings. Presentation only: positions, values and the
 * criterion that separated each entrant come from the API's document. Shared positions show as
 * `N=`; an entrant placed by status (DNF, DNS…) shows the status.
 */

export type StandingsEntry = StageClassification['document']['entries'][number];

export function StandingsTable({
  entries,
  nameOf,
}: {
  entries: readonly StandingsEntry[];
  nameOf: (participantId: string) => string;
}) {
  return (
    <table className="st-table">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Entrant</th>
          <th scope="col">Values</th>
          <th scope="col">Decided by</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((x) => (
          <tr key={x.participantId}>
            <td className="mono">
              {x.status === 'CLASSIFIED' ? `${x.position}${x.tied ? '=' : ''}` : x.status}
            </td>
            <td>{nameOf(x.participantId)}</td>
            <td className="mono small">{x.values.map((v) => `${v.key} ${v.value}`).join(' · ')}</td>
            <td className="muted small">
              {decidedByLabel(x.decidedBy?.kind) ?? (x.tied ? 'tied' : '')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ClassificationTable({
  data,
  names,
}: {
  data: StageClassification;
  names: readonly {
    participantId: string;
    athlete: { displayName: string } | null;
    teamName: string | null;
  }[];
}) {
  const nameOf = (id: string) => {
    const p = names.find((x) => x.participantId === id);
    return p?.athlete?.displayName ?? p?.teamName ?? 'Private entrant';
  };
  return (
    <>
      <p className="mono muted small">
        {data.document.complete
          ? 'All results in'
          : `${data.pendingContests.length} contest(s) pending`}{' '}
        · {data.document.policy.code} v{data.document.policy.version}
      </p>
      <StandingsTable entries={data.document.entries} nameOf={nameOf} />
    </>
  );
}
