import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  advancementState,
  contestNames,
  decodeTarget,
  encodeTarget,
  provenanceLine,
  reasonLabel,
  STATE_LABEL,
  targetHistory,
  type AdvancementState,
} from '../../../../../../../../_lib/advancement';
import { orgContext } from '../../../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../../../_lib/search-params';
import { lockedField } from '../../../../../../../../_lib/structure';
import { tournamentFor } from '../../../../../../../../_lib/tournament-context';
import { Flash } from '../../../../../../../../_product/flash';
import { SubmitButton } from '../../../../../../../../_product/submit-button';
import { SportGlyph, StatusBadge } from '../../../../../../../../_product/tournament-ui';
import { commitUnitAction, overrideAction, revokeOverrideAction } from './actions';

export const metadata = { title: 'Progression · OnChainFest' };

/**
 * ONCF-05D organizer progression: for every next-stage place, who is there (or proposed), its state
 * (pending · resolved · stale · overridden · vacant) and why — from official results, classifications
 * and the pinned advancement policy. Confirming records exactly the preview shown; an override needs
 * a reason and stays reversible. Nothing here schedules a contest (that is 05E).
 */
export default async function ProgressionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string; eventId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId, eventId }, query] = await Promise.all([params, searchParams]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const t = await tournamentFor(org.ctx, competitionId);
  if (t.kind === 'not_found') notFound();
  const e = t.kind === 'ok' ? t.data.events.find((x) => x.id === eventId) : undefined;
  if (t.kind === 'ok' && e === undefined) notFound();
  const state = t.kind === 'ok' ? await advancementState(org.ctx.accessToken, eventId) : null;
  if (t.kind === 'unavailable' || e === undefined || state === null || state.kind !== 'ok') {
    if (state?.kind === 'error' && state.status === 404) notFound();
    return (
      <div className="state-block bad">
        <strong>This category’s progression can’t be loaded right now.</strong>
        <p className="muted">Nothing changed. Try again in a moment.</p>
      </div>
    );
  }
  const { competition: c, access } = t.data;
  const canDecide = access.permissions.includes('COMP_GENERATE_STRUCTURE');
  const s = state.data;
  const base = `/app/orgs/${slug}/tournaments/${c.id}`;
  const category = `${base}/categories/${e.id}`;
  const [field, contests] = await Promise.all([
    lockedField(org.ctx.accessToken, e.id),
    contestNames(org.ctx.accessToken, c.slug, e.slug),
  ]);
  const people = field.kind === 'ok' ? field.data.items : [];
  const nameOf = (id: string | null | undefined) => {
    if (id === null || id === undefined) return '—';
    const p = people.find((x) => x.participantId === id);
    return p?.athlete?.displayName ?? p?.teamName ?? 'Private entrant';
  };
  const contestName = (id: string) => contests.get(id) ?? 'a contest';
  const why = decodeTarget(one(query.why) ?? '');
  const history = why === undefined ? null : await targetHistory(org.ctx.accessToken, e.id, why);
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="competitionId" value={c.id} />
      <input type="hidden" name="eventId" value={e.id} />
    </>
  );

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={`/app/orgs/${slug}/tournaments`}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span>{' '}
        <a href={category}>{e.settings.name}</a> <span aria-hidden="true">/</span>{' '}
        <span>Progression</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="tb-cat-hero" data-status={e.status}>
        <SportGlyph code={e.discipline.sport.code} name={e.discipline.sport.name} size={72} />
        <div className="tb-cat-hero-id">
          <span className="mono muted">
            {e.discipline.sport.name} · {e.discipline.name} · {e.format.name}
          </span>
          <h2 className="tb-hero-title">Results & progression · {e.settings.name}</h2>
          <span className="muted small">
            Who moves on, and why. Only results under the pinned advancement policy count; every
            change is kept.
          </span>
        </div>
        <StatusBadge status={e.status} />
      </header>

      <div className="tb-layout tb-layout-ops">
        <div className="tb-main">
          <Overview s={s} structureHref={`${category}/structure`} />
          {s.units.map((u) => (
            <section key={u.unitKey} className="tb-panel" aria-label={unitTitle(u, contestName)}>
              <div className="pg-unit-head">
                <h3 className="mono muted">{unitTitle(u, contestName)}</h3>
                <span className="pg-chip" data-tone={u.complete ? 'ok' : 'wait'}>
                  {u.complete ? 'Decided by the results' : 'Waiting'}
                </span>
              </div>
              <div className="st-table-wrap">
                <table className="st-table pg-table">
                  <thead>
                    <tr>
                      <th scope="col">Next-stage place</th>
                      <th scope="col">State</th>
                      <th scope="col">Entrant</th>
                      <th scope="col">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {u.targets.map((x) => {
                      const proposedDiffers =
                        x.proposed.participantId !== (x.current?.participantId ?? null) &&
                        (x.proposed.state === 'RESOLVED' || x.proposed.state === 'VACANT');
                      return (
                        <tr key={encodeTarget(x.target)} data-state={x.state}>
                          <td>
                            {x.label.round ?? 'Next round'}
                            {x.label.contestSequence === null
                              ? ''
                              : ` · #${x.label.contestSequence}`}{' '}
                            ·{' '}
                            {x.target.kind === 'SLOT'
                              ? `slot ${x.target.slot}`
                              : `place ${x.target.ordinal}`}
                          </td>
                          <td>
                            <span className="pg-state" data-state={x.state}>
                              {STATE_LABEL[x.state]}
                            </span>
                          </td>
                          <td>
                            {x.current === null ? (
                              <span className="muted">{nameOf(x.proposed.participantId)}</span>
                            ) : (
                              nameOf(x.current.participantId)
                            )}
                            {x.current !== null && proposedDiffers ? (
                              <div className="small muted">
                                now: {nameOf(x.proposed.participantId)}
                              </div>
                            ) : null}
                            {x.proposed.reason !== null && x.proposed.state !== 'RESOLVED' ? (
                              <div className="small muted">{reasonLabel(x.proposed.reason)}</div>
                            ) : null}
                          </td>
                          <td className="small">
                            {provenanceLine(x.proposed.provenance, contestName)}{' '}
                            <a href={`?why=${encodeURIComponent(encodeTarget(x.target))}`}>
                              History
                            </a>
                            {canDecide ? (
                              <Decide
                                hidden={hidden}
                                target={encodeTarget(x.target)}
                                overridden={x.state === 'OVERRIDDEN'}
                                people={people.filter((p) => p.status === 'ACTIVE')}
                                nameOf={nameOf}
                              />
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {canDecide && u.needsCommit ? (
                <form action={commitUnitAction} className="pg-confirm">
                  {hidden}
                  <input type="hidden" name="key" value={`oc-adv-${randomUUID()}`} />
                  <input type="hidden" name="unitKey" value={u.unitKey} />
                  <input type="hidden" name="previewHash" value={u.previewHash} />
                  <SubmitButton pending="Confirming" className="btn btn-cyan btn-sm">
                    Confirm these places
                  </SubmitButton>
                  <span className="muted small"> Records exactly what is shown above.</span>
                </form>
              ) : null}
            </section>
          ))}
        </div>

        <aside className="tb-side">
          {history !== null && why !== undefined ? (
            <section className="tb-panel" aria-labelledby="why-h">
              <h3 id="why-h" className="mono muted">
                History of this place
              </h3>
              {history.kind !== 'ok' ? (
                <p className="muted small">The history can’t be loaded.</p>
              ) : history.data.facts.length === 0 ? (
                <p className="muted small">Nothing has been recorded for this place yet.</p>
              ) : (
                <ol className="pg-history">
                  {history.data.facts.map((f) => (
                    <li key={`${f.recordedAt}-${f.decision.documentHash}`} data-status={f.status}>
                      <strong>{nameOf(f.participantId)}</strong>{' '}
                      <span className="mono muted small">
                        {f.status.toLowerCase()} ·{' '}
                        {f.decision.kind.toLowerCase().replace(/_/g, ' ')}
                      </span>
                      {f.provenance !== null ? (
                        <div className="small">{provenanceLine(f.provenance, contestName)}</div>
                      ) : null}
                      {f.decision.reason !== null ? (
                        <div className="small muted">Reason: {f.decision.reason}</div>
                      ) : null}
                      <div className="mono muted small">{new Date(f.recordedAt).toISOString()}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : null}
          <section className="tb-panel" data-tone="muted">
            <p className="muted small">
              Places fill only from results declared <strong>official</strong> by an authorized
              official. A later correction marks the affected places <strong>stale</strong> until
              you confirm them again — a contest whose entrants are stale cannot start. Times and
              courts are scheduled separately.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function Overview({ s, structureHref }: { s: AdvancementState; structureHref: string }) {
  const counts = s.units
    .flatMap((u) => u.targets)
    .reduce<Record<string, number>>((m, t) => ({ ...m, [t.state]: (m[t.state] ?? 0) + 1 }), {});
  return (
    <section className="tb-panel" aria-labelledby="pg-h">
      <h3 id="pg-h" className="mono muted">
        Progression
      </h3>
      {s.advancement === 'NOT_APPLICABLE' ? (
        <p className="muted">This category has no generated stage structure yet.</p>
      ) : s.advancement === 'POLICY_NOT_PINNED' ? (
        <p className="muted">
          No advancement policy is set, so next-stage places can’t be resolved.{' '}
          <a href={structureHref}>Set it with the scoring</a> (before the field locks).
        </p>
      ) : s.advancement === 'NO_ADVANCEMENT_REQUIRED' ? (
        <p className="muted">
          Nobody advances in this format: the classification of its single stage is the outcome.
        </p>
      ) : (
        <p className="muted small">
          Policy {s.policy?.code} v{s.policy?.version} ·{' '}
          {s.commitMode === 'CONFIRM' ? 'you confirm each step' : 'resolved on command'} ·{' '}
          {Object.entries(counts)
            .map(([k, n]) => `${n} ${STATE_LABEL[k as keyof typeof STATE_LABEL].toLowerCase()}`)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

function unitTitle(
  u: AdvancementState['units'][number],
  contestName: (id: string) => string,
): string {
  const [kind, a, b] = u.unitKey.split(':');
  if (kind === 'contest') return `From ${contestName(a ?? '')}`;
  if (kind === 'rank')
    return b === undefined ? `From the ${a} classification` : `From group ${b.slice(1)}`;
  if (kind === 'best') return `Best place-${b} entrants across groups`;
  if (kind === 'field') return 'Field selection';
  return u.unitKey;
}

function Decide({
  hidden,
  target,
  overridden,
  people,
  nameOf,
}: {
  hidden: ReactNode;
  target: string;
  overridden: boolean;
  people: readonly { participantId: string }[];
  nameOf: (id: string) => string;
}) {
  return (
    <details className="pg-decide">
      <summary>{overridden ? 'Revoke override' : 'Override'}</summary>
      <form action={overridden ? revokeOverrideAction : overrideAction} className="tb-form">
        {hidden}
        <input type="hidden" name="key" value={`oc-ovr-${randomUUID()}`} />
        <input type="hidden" name="target" value={target} />
        {overridden ? null : (
          <label>
            Entrant
            <select name="participantId" defaultValue="">
              <option value="">Nobody (vacant)</option>
              {people.map((p) => (
                <option key={p.participantId} value={p.participantId}>
                  {nameOf(p.participantId)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Reason (kept in the audit trail)
          <input name="reason" required maxLength={500} />
        </label>
        <SubmitButton pending="Saving" className="btn btn-ghost btn-sm">
          {overridden ? 'Revoke' : 'Record override'}
        </SubmitButton>
      </form>
    </details>
  );
}
