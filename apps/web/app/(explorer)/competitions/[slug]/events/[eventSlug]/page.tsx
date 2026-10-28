import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../../../_lib/api';
import {
  Entrant,
  groupName,
  OFFICIAL_AUTHORITY_NOTE,
  partitionLabel,
  placeLabel,
  SlotView,
  StatusPill,
  when,
  type Contest,
  type Entry,
  type FieldEntry,
  type PublicEvent,
  type PublicEventOutcome,
  type StructureRound,
} from '../../../../../_lib/competition';
import { RegistrationCtaPanel } from '../../../../../_lib/registration-cta';
import { officialScore } from '../../../../../_lib/score-sheet';
import { Unavailable } from '../../../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string; eventSlug: string }> };

async function load(slug: string, eventSlug: string) {
  const base = `/v1/competitions/${encodeURIComponent(slug)}/events/${encodeURIComponent(eventSlug)}`;
  const [event, participants, schedule, bracket, outcome] = await Promise.all([
    getPublic<PublicEvent>(base),
    getPublic<{ items: Entry[] }>(`${base}/participants`),
    getPublic<{ items: Contest[] }>(`${base}/schedule`),
    getPublic<{ rounds: StructureRound[] }>(`${base}/bracket`),
    getPublic<PublicEventOutcome>(`${base}/outcome`),
  ]);
  return { event, participants, schedule, bracket, outcome };
}

export async function generateMetadata({ params }: Params) {
  const p = await params;
  const r = await getPublic<PublicEvent>(
    `/v1/competitions/${encodeURIComponent(p.slug)}/events/${encodeURIComponent(p.eventSlug)}`,
  );
  return { title: r.kind === 'ok' ? `${r.data.event.name} · ${r.data.competition.name}` : 'Event' };
}

export default async function EventPage({ params }: Params) {
  const { slug, eventSlug } = await params;
  const { event, participants, schedule, bracket, outcome } = await load(slug, eventSlug);
  if (event.kind === 'not_found') notFound();
  if (event.kind === 'unavailable') return <Unavailable />;
  const d = event.data;
  if (d.redirected || d.canonical.competitionSlug !== slug || d.canonical.eventSlug !== eventSlug) {
    permanentRedirect(
      `/competitions/${d.canonical.competitionSlug}/events/${d.canonical.eventSlug}`,
    );
  }
  const e = d.event;
  const tz = e.timezone;
  const entries = participants.kind === 'ok' ? participants.data.items : [];
  const contests = schedule.kind === 'ok' ? schedule.data.items : [];
  const rounds = bracket.kind === 'ok' ? bracket.data.rounds : [];
  return (
    <main style={{ maxWidth: 960 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        <a href={`/competitions/${d.competition.slug}`}>{d.competition.name}</a> · Event
      </p>
      <h1 style={{ marginBottom: 0 }}>
        {e.name}
        <StatusPill status={e.status} />
      </h1>
      <p style={{ color: '#6b7280' }}>
        {e.sport.name} · {e.discipline.name} (rules v{e.discipline.version}) · {e.format.name} (
        {e.format.engine})
      </p>
      <p>
        Registration: {e.status.toLowerCase().replace(/_/g, ' ')} · {e.confirmedCount} confirmed
        {e.capacity !== null && ` of ${e.capacity}`}
        {e.waitlistCount > 0 && ` · ${e.waitlistCount} on the waitlist`}
        {e.participantCount > 0 && ` · field locked with ${e.participantCount} participants`}
      </p>
      <RegistrationCtaPanel
        event={e}
        competitionStatus={d.competition.status}
        competitionSlug={d.competition.slug}
      />
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        This page shows how the event is operated — entries, schedule and structure — and its
        official results. Official results are declared by the organizer and are not independently
        verified; contest and event statuses are operational, not results.
      </aside>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Participants</h2>
        {entries.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No confirmed entries yet.</p>
        ) : (
          <ol>
            {entries.map((p, i) => (
              <li key={p.participantId ?? i}>
                <Entrant display={p.display} />
                {p.seed !== null && <small style={{ color: '#6b7280' }}> · seed {p.seed}</small>}
                {p.participantStatus !== null && p.participantStatus !== 'ACTIVE' && (
                  <StatusPill status={p.participantStatus} />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Schedule</h2>
        {contests.length === 0 ? (
          <p style={{ color: '#6b7280' }}>
            No contests yet (the structure is generated after the field is locked).
          </p>
        ) : (
          // A narrow screen scrolls the schedule sideways instead of the page.
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th>#</th>
                  <th>Round</th>
                  <th>When</th>
                  <th>Where</th>
                  <th>Contestants</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {contests.map((c) => (
                  <tr key={c.contestId} style={{ borderTop: '1px solid #e5e7eb' }}>
                    <td>{c.sequence}</td>
                    <td>{c.round.label}</td>
                    <td>{when(c.scheduledStart, tz)}</td>
                    <td>{[c.locationLabel, c.courtLabel].filter(Boolean).join(' · ') || '—'}</td>
                    <td>
                      {c.slots.length === 0 && (c.entryCount ?? 0) > 0
                        ? `${c.entryCount} entrants${c.partitionKey ? ` · ${partitionLabel(c.partitionKey) ?? ''}` : ''}`
                        : c.slots.map((s, i) => (
                            <span key={s.slot}>
                              {i > 0 && ' vs '}
                              <SlotView slot={s} />
                            </span>
                          ))}
                    </td>
                    <td>{c.status.toLowerCase().replace(/_/g, ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Structure</h2>
        {rounds.length === 0 ? (
          <p style={{ color: '#6b7280' }}>Not generated yet.</p>
        ) : rounds.some((r) => r.stage !== null && r.stage !== undefined) ? (
          <StageStructure rounds={rounds} />
        ) : (
          <div style={{ display: 'flex', gap: '1.5rem', overflowX: 'auto' }}>
            {rounds.map((r) => (
              <div key={r.sequence} style={{ minWidth: 200 }}>
                <h3 style={{ fontSize: '0.95rem' }}>{r.label}</h3>
                {r.contests.map((c) => (
                  <div
                    key={c.contestId}
                    style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      padding: '0.4rem 0.6rem',
                      marginBottom: '0.5rem',
                      fontSize: '0.85rem',
                    }}
                  >
                    <small style={{ color: '#6b7280' }}>#{c.sequence}</small>
                    {c.slots.map((s) => (
                      <div key={s.slot}>
                        <SlotView slot={s} />
                      </div>
                    ))}
                  </div>
                ))}
                {r.byes.length > 0 && (
                  <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                    Bye:{' '}
                    {r.byes.map((b) => (
                      <span key={b.participantId}>
                        <Entrant display={b.display} />{' '}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <OutcomeSection
        status={e.status}
        outcome={outcome.kind === 'ok' ? outcome.data : null}
        unavailable={outcome.kind === 'unavailable'}
      />

      {(d.plan || d.seeding) && (
        <section style={{ marginTop: '1.5rem', fontSize: '0.8rem', color: '#6b7280' }}>
          <h2 style={{ fontSize: '0.95rem' }}>How this structure was generated</h2>
          {d.field.fieldHash && (
            <p>
              Field snapshot: <code>{d.field.fieldHash}</code>
            </p>
          )}
          {d.seeding && (
            <p>
              Seeding: {d.seeding.method.toLowerCase().replace(/_/g, ' ')}
              {d.seeding.drawSeed && (
                <>
                  {' '}
                  ({d.seeding.drawAlgorithm}, seed <code>{d.seeding.drawSeed}</code>) — reproducible
                  from the stored seed; not a provably fair draw
                </>
              )}
            </p>
          )}
          {d.plan && (
            <p>
              Plan: {d.plan.engine} · input <code>{d.plan.inputHash}</code> · output{' '}
              <code>{d.plan.planHash}</code>
            </p>
          )}
        </section>
      )}
    </main>
  );
}

const muted = { color: '#6b7280' } as const;
const PLAYED = new Set(['IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const NOTE: Record<string, string> = {
  TIE_UNBROKEN_LOT: 'A tie that only an organizer lot could separate is shown as shared.',
  GROUPS_NO_CHAMPION: 'Groups are ranked separately: there is no overall champion.',
};

/**
 * ONCF-L6 (ADR-0078): the category's OFFICIAL results only — standings so far while it is played,
 * the final podium once it is completed. Nothing below OFFICIAL is ever shown, and nothing is
 * shown rather than something not yet decided.
 */
function OutcomeSection({
  status,
  outcome,
  unavailable,
}: {
  status: string;
  outcome: PublicEventOutcome | null;
  unavailable: boolean;
}) {
  const official = (outcome?.matches ?? []).filter((m) => m.official);
  const podium = outcome?.podium.status === 'AVAILABLE' ? outcome.podium.placements : [];
  const positions = [...new Set(podium.map((p) => p.position))].sort((a, b) => a - b);
  return (
    <section style={{ marginTop: '1.5rem' }} aria-label="Results and standings">
      <h2 style={{ fontSize: '1.1rem' }}>
        {outcome?.final ? 'Final result' : 'Results & standings'}
      </h2>
      {unavailable ? (
        <p style={muted}>Results can’t be loaded right now. Try again in a moment.</p>
      ) : outcome === null || !PLAYED.has(status) ? (
        <p style={muted}>Results appear here once matches are played.</p>
      ) : (
        <>
          <p style={{ ...muted, fontSize: '0.85rem' }}>
            {status === 'CANCELLED'
              ? 'Category cancelled — no outcome is decided. Official results recorded before it was cancelled are kept below.'
              : outcome.final
                ? `Final · ${OFFICIAL_AUTHORITY_NOTE}`
                : `Standings so far — official results only (${OFFICIAL_AUTHORITY_NOTE.toLowerCase()}). The podium is shown once the category is completed.`}
          </p>
          {positions.length > 0 && (
            <ol style={{ listStyle: 'none', padding: 0 }} aria-label="Podium">
              {positions.map((pos) => {
                const at = podium.filter((p) => p.position === pos);
                return (
                  <li key={pos} style={{ marginBottom: '0.35rem' }}>
                    <strong>{placeLabel(pos, at.length)}:</strong>{' '}
                    {at.map((p, i) => (
                      <span key={p.participantId}>
                        {i > 0 && ' · '}
                        <Entrant display={p.display} />
                      </span>
                    ))}
                  </li>
                );
              })}
            </ol>
          )}
          {outcome.notes.map((n) => (
            <p key={n} style={{ ...muted, fontSize: '0.85rem' }}>
              {NOTE[n] ?? n}
            </p>
          ))}
          {outcome.standings.map((t) => (
            <div key={t.groupKey ?? 'all'} style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
              <h3 style={{ fontSize: '0.95rem' }}>
                {t.groupKey !== null ? `Group ${groupName(t.groupKey)} · ` : ''}
                {t.complete ? 'Standings' : 'Standings so far'}
              </h3>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left' }}>
                    <th>#</th>
                    <th>Entrant</th>
                    <th>Values</th>
                  </tr>
                </thead>
                <tbody>
                  {t.entries.map((x) => (
                    <tr key={x.participantId} style={{ borderTop: '1px solid #e5e7eb' }}>
                      <td>
                        {x.status === 'CLASSIFIED' ? `${x.position}${x.tied ? '=' : ''}` : x.status}
                      </td>
                      <td>
                        <Entrant display={x.display} />
                      </td>
                      <td style={muted}>
                        {x.values.map((v) => `${v.key} ${v.value}`).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <h3 style={{ fontSize: '0.95rem', marginTop: '0.75rem' }}>Official results</h3>
          {official.length === 0 ? (
            <p style={muted}>No official results yet.</p>
          ) : (
            <ul style={{ fontSize: '0.85rem' }}>
              {official.map((m) => {
                const scored = officialScore(
                  m.scoring,
                  m.entrants.map((x) => x.participantId),
                );
                const byId = new Map(m.entrants.map((x) => [x.participantId, x]));
                const [first, second] =
                  scored === null ? [] : scored.order.map((id) => byId.get(id));
                // D-P4: the sport's own score line (sets, tie-breaks…), winner first when decided.
                if (scored !== null && first !== undefined && second !== undefined)
                  return (
                    <li key={m.contestId}>
                      <small style={muted}>{m.roundLabel} · </small>
                      <Entrant display={first.display} />
                      {scored.line.winner === null ? ' – ' : ' d. '}
                      <Entrant display={second.display} />{' '}
                      <small style={muted}>
                        · {scored.line.score}
                        {scored.line.how !== null && ` (${scored.line.how.toLowerCase()})`}
                      </small>
                    </li>
                  );
                return (
                  <li key={m.contestId}>
                    <small style={muted}>{m.roundLabel} · </small>
                    {m.entrants.map((x, i) => (
                      <span key={x.participantId}>
                        {i > 0 && ' · '}
                        <Entrant display={x.display} />{' '}
                        <small style={muted}>
                          {(x.outcome ?? '').toLowerCase().replace(/_/g, ' ')}
                          {x.score.length > 0 &&
                            ` (${x.score.map((v) => `${v.key} ${v.value}`).join(', ')})`}
                        </small>
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const ENTRY_PREVIEW = 50;

/** "+1:30" from seconds after the start (interval starts). */
function offset(seconds: number | null): string {
  if (seconds === null) return '';
  return ` +${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function Entries({ entries, total }: { entries: FieldEntry[]; total: number }) {
  return (
    <ol style={{ margin: '0.25rem 0 0', paddingLeft: '1.4rem' }}>
      {entries.slice(0, ENTRY_PREVIEW).map((e) => (
        <li key={e.participantId} value={e.position}>
          <Entrant display={e.display} />
          {e.startOffsetSeconds !== null && (
            <small style={{ color: '#6b7280' }}>{offset(e.startOffsetSeconds)}</small>
          )}
        </li>
      ))}
      {total > ENTRY_PREVIEW && (
        <li style={{ listStyle: 'none', color: '#6b7280' }}>and {total - ENTRY_PREVIEW} more</li>
      )}
    </ol>
  );
}

const box = {
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  padding: '0.4rem 0.6rem',
  marginBottom: '0.5rem',
  fontSize: '0.85rem',
} as const;

/**
 * ONCF-05B stage-graph structure: rounds grouped under their stage, partitions (waves, heats,
 * start groups, groups) labelled, field entries listed, and dependencies shown only as where the
 * entrant will come from. ONCF-05D: a dependent slot shows its entrant once advancement placed
 * one there (provenance stays organizer-only); a dynamic round lists its field once committed.
 */
function StageStructure({ rounds }: { rounds: StructureRound[] }) {
  const stages = [...new Map(rounds.map((r) => [r.stage?.key ?? '', r.stage])).values()];
  return (
    <div>
      {stages.map((stage) => {
        const own = rounds.filter((r) => (r.stage?.key ?? '') === (stage?.key ?? ''));
        return (
          <div key={stage?.key ?? 'single'} style={{ marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>
              {stage?.label ?? 'Structure'}
              {stage?.partitionKind === 'COMPETITIVE' && (
                <small style={{ color: '#6b7280' }}> · ranked within each group</small>
              )}
              {stage?.partitionKind === 'LOGISTIC' && (
                <small style={{ color: '#6b7280' }}> · one classification across all groups</small>
              )}
            </h3>
            <div style={{ display: 'flex', gap: '1.5rem', overflowX: 'auto' }}>
              {own.map((r) => (
                <div key={r.sequence} style={{ minWidth: 220 }}>
                  <h4 style={{ fontSize: '0.9rem', margin: '0.25rem 0' }}>
                    {r.label}
                    {r.groupKey && !r.label.startsWith('Group') && (
                      <small style={{ color: '#6b7280' }}> · Group {groupName(r.groupKey)}</small>
                    )}
                  </h4>
                  {r.dynamicEntry ? (
                    <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                      Field set after the previous round’s results (cut or elimination).
                    </p>
                  ) : (
                    <RoundContests round={r} />
                  )}
                  {r.byes.length > 0 && (
                    <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                      Bye:{' '}
                      {r.byes.map((b) => (
                        <span key={b.participantId}>
                          <Entrant display={b.display} />{' '}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RoundContests({ round }: { round: StructureRound }) {
  const contests = round.contests;
  // Per-entrant contests in start groups (e.g. a round played in groups): one box per group.
  const grouped =
    contests.length > 0 &&
    contests.every((c) => c.slots.length <= 1 && (c.entryCount ?? 0) === 0 && c.partitionKey);
  if (grouped) {
    const parts = [...new Set(contests.map((c) => c.partitionKey as string))];
    return (
      <>
        {parts.map((p) => (
          <div key={p} style={box}>
            <small style={{ color: '#6b7280' }}>{partitionLabel(p)}</small>
            {contests
              .filter((c) => c.partitionKey === p)
              .map((c) => (
                <div key={c.contestId}>
                  {c.slots[0] !== undefined && <SlotView slot={c.slots[0]} />}
                </div>
              ))}
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {contests.map((c) => (
        <div key={c.contestId} style={box}>
          <small style={{ color: '#6b7280' }}>
            #{c.sequence}
            {c.partitionKey &&
              !c.partitionKey.startsWith('g') &&
              ` · ${partitionLabel(c.partitionKey)}`}
            {(c.entryCount ?? 0) > 0 && ` · ${c.entryCount} entrants`}
          </small>
          {(c.entryCount ?? 0) > 0 ? (
            <Entries entries={c.entries ?? []} total={c.entryCount ?? 0} />
          ) : (
            c.slots.map((s) => (
              <div key={s.slot}>
                {c.slots.length > 2 && <small style={{ color: '#6b7280' }}>Lane {s.slot} · </small>}
                <SlotView slot={s} />
              </div>
            ))
          )}
        </div>
      ))}
    </>
  );
}
