import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { attributeLabel, displayValue } from '../../../../../../../../_lib/entry-attributes';
import { orgContext } from '../../../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../../../_lib/search-params';
import {
  BLOCKER_LABEL,
  lockedField,
  planPreview,
  PRIMITIVE_LABEL,
  readiness,
  SEEDING_METHOD_LABEL,
  seedableAttributes,
  TRANSITION_LABEL,
  WARNING_LABEL,
  type FieldParticipant,
  type PlanPreview,
} from '../../../../../../../../_lib/structure';
import { tournamentFor } from '../../../../../../../../_lib/tournament-context';
import { catalogDiscipline, tournamentCatalog } from '../../../../../../../../_lib/tournaments';
import {
  basisLabel,
  compatibleRulesets,
  decidedByLabel,
  eventScoring,
  stageClassification,
  templatesFor,
} from '../../../../../../../../_lib/scoring';
import { Flash } from '../../../../../../../../_product/flash';
import { SubmitButton } from '../../../../../../../../_product/submit-button';
import { SportGlyph, StatusBadge } from '../../../../../../../../_product/tournament-ui';
import { pinScoringAction, generatePlanAction, lockFieldAction, seedFieldAction } from './actions';

export const metadata = { title: 'Structure · OnChainFest' };

const AFTER_CLOSE = ['REGISTRATION_CLOSED', 'FIELD_LOCKED', 'IN_PROGRESS', 'COMPLETED'];

/**
 * ONCF-05B category structure: readiness checklist → lock the field → seed → preview → generate.
 * Every step is one immutable API command, offered only when the readiness facts and the caller's
 * permissions allow it; the API re-checks everything. Declared values are shown to staff only.
 */
export default async function StructurePage({
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
  const ready = t.kind === 'ok' ? await readiness(org.ctx.accessToken, eventId) : null;
  if (t.kind === 'unavailable' || e === undefined || ready === null || ready.kind !== 'ok') {
    if (ready?.kind === 'error') notFound();
    return (
      <div className="state-block bad">
        <strong>This category’s structure can’t be loaded right now.</strong>
        <p className="muted">Nothing changed. Try again in a moment.</p>
      </div>
    );
  }
  const { competition: c, access } = t.data;
  const perms = access.permissions;
  const r = ready.data;
  const base = `/app/orgs/${slug}/tournaments/${c.id}`;
  const category = `${base}/categories/${e.id}`;
  const publicEvent = `/competitions/${c.slug}/events/${e.slug}`;

  const stageParam = one(query.stage);
  const groupParam = one(query.group);
  const [field, preview, catalog, scoringPin] = await Promise.all([
    r.fieldLocked ? lockedField(org.ctx.accessToken, e.id) : Promise.resolve(null),
    r.seeded && !r.planGenerated ? planPreview(org.ctx.accessToken, e.id) : Promise.resolve(null),
    tournamentCatalog(),
    eventScoring(org.ctx.accessToken, e.id),
  ]);
  const pinned = scoringPin.kind === 'ok' && scoringPin.data.pinned ? scoringPin.data : null;
  const table =
    pinned !== null &&
    r.planGenerated &&
    stageParam !== undefined &&
    /^s[0-9]{1,2}$/.test(stageParam)
      ? await stageClassification(
          org.ctx.accessToken,
          e.id,
          stageParam,
          groupParam !== undefined && /^g[0-9]{1,2}$/.test(groupParam) ? groupParam : undefined,
        )
      : null;
  const participants = field?.kind === 'ok' ? field.data.items : [];
  const discipline =
    catalog.kind === 'ok'
      ? catalogDiscipline(catalog.data, e.discipline.code, e.discipline.version)
      : undefined;
  const specs = discipline?.entryAttributes ?? [];
  const seedable = seedableAttributes(specs);
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="competitionId" value={c.id} />
      <input type="hidden" name="eventId" value={e.id} />
    </>
  );
  const canLock = e.status === 'REGISTRATION_CLOSED' && perms.includes('COMP_LOCK_FIELD');
  const canSeed = r.fieldLocked && !r.seeded && perms.includes('COMP_GENERATE_STRUCTURE');
  const canGenerate = r.seeded && !r.planGenerated && perms.includes('COMP_GENERATE_STRUCTURE');

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={`/app/orgs/${slug}/tournaments`}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span>{' '}
        <a href={category}>{e.settings.name}</a> <span aria-hidden="true">/</span>{' '}
        <span>Structure</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="tb-cat-hero" data-status={e.status}>
        <SportGlyph code={e.discipline.sport.code} name={e.discipline.sport.name} size={72} />
        <div className="tb-cat-hero-id">
          <span className="mono muted">
            {e.discipline.sport.name} · {e.discipline.name} · {e.format.name}
          </span>
          <h2 className="tb-hero-title">Structure · {e.settings.name}</h2>
          <span className="muted small">
            Lock the field, seed it and generate the draw. Each step happens once and is kept.
          </span>
        </div>
        <StatusBadge status={e.status} />
      </header>

      <div className="tb-layout tb-layout-ops">
        <div className="tb-main">
          {!AFTER_CLOSE.includes(e.status) ? (
            <section className="tb-panel" aria-labelledby="wait-h">
              <h3 id="wait-h" className="mono muted">
                Not yet
              </h3>
              <p className="muted">
                The structure is built after registration closes. Close registration from the
                category page first.
              </p>
              <a className="btn btn-ghost btn-sm" href={category}>
                Back to the category
              </a>
            </section>
          ) : null}

          {canLock ? (
            <section className="tb-panel" aria-labelledby="lock-h">
              <h3 id="lock-h" className="mono muted">
                1 · Lock the field
              </h3>
              <p className="muted small">
                Every confirmed entry becomes a participant. Team rosters and declared entry values
                are frozen with it; waitlisted and pending entries stay out. This can’t be undone.
              </p>
              <form action={lockFieldAction}>
                {hidden}
                <input type="hidden" name="key" value={`oc-lock-${randomUUID()}`} />
                <SubmitButton pending="Locking" className="btn btn-cyan">
                  Lock the field ({e.counts.confirmed} confirmed)
                </SubmitButton>
              </form>
            </section>
          ) : null}

          {canSeed ? (
            <section className="tb-panel st-seed" aria-labelledby="seed-h">
              <h3 id="seed-h" className="mono muted">
                2 · Seed the field
              </h3>
              <form action={seedFieldAction} className="tb-form">
                {hidden}
                <input type="hidden" name="key" value={`oc-seed-${randomUUID()}`} />
                <fieldset className="st-methods">
                  <legend className="mono muted small">Method</legend>
                  <label>
                    <input type="radio" name="method" value="DETERMINISTIC_DRAW" defaultChecked />{' '}
                    Random draw{' '}
                    <span className="muted small">— reproducible from a stored seed</span>
                  </label>
                  <label>
                    <input type="radio" name="method" value="RANKED_THEN_DRAWN" /> Seeds, then draw{' '}
                    <span className="muted small">
                      — number the seeds below; the rest are drawn
                    </span>
                  </label>
                  {seedable.length > 0 ? (
                    <label>
                      <input type="radio" name="method" value="BY_ENTRY_ATTRIBUTE" /> By a declared
                      value{' '}
                      <select name="attributeKey" aria-label="Value to seed by">
                        {seedable.map((a) => (
                          <option key={a.key} value={a.key}>
                            {attributeLabel(a.key)}
                          </option>
                        ))}
                      </select>{' '}
                      <select name="direction" aria-label="Order">
                        <option value="ASC">lowest first</option>
                        <option value="DESC">highest first</option>
                      </select>
                    </label>
                  ) : null}
                </fieldset>
                <label className="st-inline">
                  <input type="checkbox" name="banded" defaultChecked /> Draw seeds within bands
                  (3–4, 5–8, …)
                </label>
                <div className="st-source">
                  <label>
                    <span className="mono muted small">Seeding source (declared)</span>
                    <input name="sourceLabel" maxLength={120} placeholder="e.g. club ranking" />
                  </label>
                  <label>
                    <span className="mono muted small">As of</span>
                    <input name="sourceAsOf" type="date" />
                  </label>
                </div>
                <FieldTable participants={participants} specs={specs} seedInputs />
                <details className="st-overrides">
                  <summary className="mono small">Overrides (audited, shown publicly)</summary>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="st-override">
                      <select
                        name={`override.${i}.participant`}
                        aria-label={`Override ${i} entrant`}
                      >
                        <option value="">—</option>
                        {participants.map((p) => (
                          <option key={p.participantId} value={p.participantId}>
                            {entrantName(p)}
                          </option>
                        ))}
                      </select>
                      <input
                        name={`override.${i}.position`}
                        type="number"
                        min={1}
                        max={participants.length}
                        placeholder="position"
                        aria-label={`Override ${i} position`}
                      />
                      <input
                        name={`override.${i}.reason`}
                        maxLength={300}
                        placeholder="reason (required)"
                        aria-label={`Override ${i} reason`}
                      />
                    </div>
                  ))}
                </details>
                <p className="muted small">
                  Seeding happens once and can’t be changed. Declared values and rankings are not
                  verified by OnChainFest.
                </p>
                <SubmitButton pending="Seeding" className="btn btn-cyan">
                  Seed the field
                </SubmitButton>
              </form>
            </section>
          ) : null}

          {r.fieldLocked && !canSeed ? (
            <section className="tb-panel" aria-labelledby="fld-h">
              <h3 id="fld-h" className="mono muted">
                Locked field · {r.participants} participants
              </h3>
              <FieldTable participants={participants} specs={specs} />
            </section>
          ) : null}

          {preview !== null && preview.kind === 'ok' ? (
            <section className="tb-panel" aria-labelledby="prev-h">
              <h3 id="prev-h" className="mono muted">
                3 · Structure preview
              </h3>
              <Preview plan={preview.data} />
              {canGenerate ? (
                <form action={generatePlanAction} className="st-generate">
                  {hidden}
                  <input type="hidden" name="key" value={`oc-plan-${randomUUID()}`} />
                  <label className="rg-declare">
                    <input type="checkbox" name="confirm" value="yes" required />
                    <span>
                      I understand the structure is permanent: it can’t be regenerated or edited
                      once generated.
                    </span>
                  </label>
                  <SubmitButton pending="Generating" className="btn btn-cyan">
                    Generate the structure
                  </SubmitButton>
                </form>
              ) : null}
            </section>
          ) : preview !== null ? (
            <section className="tb-panel" data-tone="muted">
              <p className="muted">
                The preview isn’t available: this field and the format settings don’t produce a
                valid structure. Check the category’s format settings.
              </p>
            </section>
          ) : null}

          {r.planGenerated ? (
            <section className="tb-panel" aria-labelledby="done-h">
              <h3 id="done-h" className="mono muted">
                Structure generated
              </h3>
              <p className="muted small">
                {r.plan?.contests ?? 0} contests in {r.plan?.stages || 1} stage
                {(r.plan?.stages ?? 1) > 1 ? 's' : ''} · {r.plan?.engine}
              </p>
              <a className="btn btn-ghost btn-sm" href={`${category}/progression`}>
                Results & progression
              </a>{' '}
              <a className="btn btn-cyan btn-sm" href={publicEvent}>
                See it on the public category page ↗
              </a>
            </section>
          ) : null}
          <ScoringPanel
            pinned={pinned}
            rulesets={
              catalog.kind === 'ok'
                ? compatibleRulesets(catalog.data, discipline?.disciplineVersionId)
                : []
            }
            templates={(family) =>
              catalog.kind === 'ok' ? templatesFor(catalog.data, family) : []
            }
            policies={catalog.kind === 'ok' ? (catalog.data.advancementPolicyVersions ?? []) : []}
            canPin={
              !(scoringPin.kind === 'ok' && scoringPin.data.frozen) && perms.includes('COMP_EDIT')
            }
            hidden={hidden}
          />

          {pinned !== null && r.planGenerated && (r.stageList ?? []).length > 0 ? (
            <section className="tb-panel" aria-labelledby="cls-h">
              <h3 id="cls-h" className="mono muted">
                Classification (proposal)
              </h3>
              <p className="muted small">
                Computed from the current results under{' '}
                {pinned.classificationTemplate?.name ?? 'the pinned template'}. Not official until
                it is submitted by an authority.
              </p>
              <ul className="st-stage-links">
                {(r.stageList ?? []).flatMap((st) =>
                  (st.groups.length > 0 ? st.groups : [undefined]).map((g) => (
                    <li key={`${st.key}-${g ?? ''}`}>
                      <a href={`?stage=${st.key}${g === undefined ? '' : `&group=${g}`}`}>
                        {st.label}
                        {g === undefined ? '' : ` · Group ${g.slice(1)}`}
                      </a>
                    </li>
                  )),
                )}
              </ul>
              {table === null ? null : table.kind !== 'ok' ? (
                <p className="muted small">
                  This classification can’t be computed yet (check the pinned template and results).
                </p>
              ) : (
                <div className="st-table-wrap">
                  <ClassificationTable data={table.data} names={participants} />
                </div>
              )}
            </section>
          ) : null}
        </div>

        <aside className="tb-side">
          <section className="tb-panel" aria-labelledby="rd-h">
            <h3 id="rd-h" className="mono muted">
              Readiness
            </h3>
            <ul className="st-checklist">
              <Check done={r.fieldLocked} label="Field locked">
                {r.fieldLocked ? `${r.participants} participants` : null}
              </Check>
              {r.rosterSnapshot !== null && r.rosterSnapshot.teams > 0 ? (
                <Check
                  done={r.rosterSnapshot.snapshotted === r.rosterSnapshot.teams}
                  label="Team rosters frozen"
                >
                  {`${r.rosterSnapshot.snapshotted} of ${r.rosterSnapshot.teams}`}
                </Check>
              ) : null}
              <Check done={r.seeded} label="Seeded">
                {r.seeding !== null
                  ? `${SEEDING_METHOD_LABEL[r.seeding.method] ?? r.seeding.method}${
                      r.seeding.overrides > 0 ? ` · ${r.seeding.overrides} override(s)` : ''
                    }`
                  : null}
              </Check>
              <Check done={r.planGenerated} label="Structure generated">
                {r.plan !== null ? `${r.plan.contests} contests` : null}
              </Check>
              <Check
                done={
                  r.contestsScheduled.total > 0 &&
                  r.contestsScheduled.scheduled === r.contestsScheduled.total
                }
                label="Contests scheduled"
                optional
              >
                {r.contestsScheduled.total > 0
                  ? `${r.contestsScheduled.scheduled} of ${r.contestsScheduled.total}`
                  : null}
              </Check>
            </ul>
            {r.blockers.length > 0 ? (
              <p className="small">
                <span className="mono muted">Next</span>{' '}
                {BLOCKER_LABEL[r.blockers[0] ?? ''] ?? r.blockers[0]}
              </p>
            ) : null}
            {r.warnings.map((w) => (
              <p key={w} className="muted small">
                {WARNING_LABEL[w] ?? w}
              </p>
            ))}
            <a className="btn btn-ghost btn-full" href={category}>
              Back to the category
            </a>
          </section>
        </aside>
      </div>
    </>
  );
}

function Check({
  done,
  label,
  optional,
  children,
}: {
  done: boolean;
  label: string;
  optional?: boolean;
  children?: ReactNode;
}) {
  return (
    <li data-done={done} data-optional={optional === true}>
      <span aria-hidden="true">{done ? '✓' : '○'}</span> {label}
      {children !== null && children !== undefined ? (
        <span className="muted small"> · {children}</span>
      ) : null}
    </li>
  );
}

function entrantName(p: FieldParticipant): string {
  if (p.kind === 'TEAM') return p.teamName ?? 'Team';
  return p.athlete !== null ? p.athlete.displayName : 'Private entrant';
}

function FieldTable({
  participants,
  specs,
  seedInputs,
}: {
  participants: FieldParticipant[];
  specs: { key: string; valueType: 'DURATION_MS' | 'INTEGER' | 'DECIMAL' | 'TEXT' }[];
  seedInputs?: boolean;
}) {
  if (participants.length === 0)
    return <p className="muted small">No participants in the field.</p>;
  const teams = participants.some((p) => p.kind === 'TEAM');
  return (
    <div className="st-table-wrap">
      <table className="st-table">
        <thead>
          <tr>
            <th className="mono">{seedInputs === true ? 'Seed #' : 'Seed'}</th>
            <th>Entrant</th>
            {teams ? <th className="mono">Roster</th> : null}
            <th>Declared values</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((p) => (
            <tr key={p.participantId} data-status={p.status}>
              <td className="mono">
                {seedInputs === true ? (
                  <input
                    name={`seed.${p.participantId}`}
                    inputMode="numeric"
                    size={3}
                    aria-label={`Seed for ${entrantName(p)}`}
                  />
                ) : (
                  (p.seed ?? '—')
                )}
              </td>
              <td>
                {p.kind === 'INDIVIDUAL' && p.athlete === null ? (
                  <em className="muted">Private entrant</em>
                ) : (
                  entrantName(p)
                )}
                {p.status !== 'ACTIVE' ? (
                  <span className="muted small"> · {p.status.toLowerCase()}</span>
                ) : null}
              </td>
              {teams ? <td className="mono">{p.rosterSize ?? '—'}</td> : null}
              <td className="small">
                {p.attributes.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  p.attributes
                    .map(
                      (a) =>
                        `${attributeLabel(a.key)} ${displayValue(
                          specs.find((s) => s.key === a.key),
                          a.value,
                        )}`,
                    )
                    .join(' · ')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Declared · not verified.</p>
    </div>
  );
}

function Preview({ plan }: { plan: PlanPreview }) {
  const stages =
    plan.stages.length > 0
      ? plan.stages
      : [{ key: '', label: 'Structure', primitive: '', partitionKind: null }];
  return (
    <div className="st-preview">
      <p className="muted small">
        {plan.contests} contests · {plan.engine}
      </p>
      {stages.map((s) => {
        const rounds = plan.rounds.filter((r) => (r.stageKey ?? '') === s.key);
        const incoming = plan.transitions.find((t) => t.toStage === s.key && t.fromStage !== s.key);
        return (
          <div key={s.key || 'single'} className="st-stage">
            <h4>
              {s.label}
              {s.primitive !== '' ? (
                <span className="chip mono">{PRIMITIVE_LABEL[s.primitive] ?? s.primitive}</span>
              ) : null}
              {s.partitionKind !== null ? (
                <span className="chip mono">
                  {s.partitionKind === 'COMPETITIVE' ? 'competitive groups' : 'logistic groups'}
                </span>
              ) : null}
            </h4>
            {incoming !== undefined ? (
              <p className="muted small">
                Entrants come from {TRANSITION_LABEL[incoming.kind] ?? incoming.kind}.
              </p>
            ) : null}
            <ul className="st-rounds">
              {rounds.map((r) => {
                const by = plan.transitions.find(
                  (t) => t.fromStage === s.key && t.toStage === s.key,
                );
                return (
                  <li key={r.key}>
                    <strong>{r.label}</strong>{' '}
                    {r.dynamic ? (
                      <span className="muted small">
                        · field set by {TRANSITION_LABEL[by?.kind ?? ''] ?? 'results'}
                      </span>
                    ) : (
                      <span className="muted small">
                        · {r.contests} contest{r.contests === 1 ? '' : 's'}
                        {r.entries > 0 ? ` · ${r.entries} entries` : ''}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ScoringPanel({
  pinned,
  rulesets,
  templates,
  policies,
  canPin,
  hidden,
}: {
  pinned: Awaited<ReturnType<typeof eventScoring>> extends infer R
    ? R extends { kind: 'ok'; data: infer D }
      ? D | null
      : never
    : never;
  rulesets: ReturnType<typeof compatibleRulesets>;
  templates: (family: string | undefined) => ReturnType<typeof templatesFor>;
  policies: ReturnType<typeof templatesFor>;
  canPin: boolean;
  hidden: ReactNode;
}) {
  return (
    <section className="tb-panel" aria-labelledby="sc-h">
      <h3 id="sc-h" className="mono muted">
        Scoring
      </h3>
      {pinned?.ruleset ? (
        <dl className="st-scoring">
          <dt>Ruleset</dt>
          <dd>
            {pinned.ruleset.name} <span className="mono muted">v{pinned.ruleset.version}</span>
            <div className="muted small">{basisLabel(pinned.ruleset)}</div>
          </dd>
          <dt>Classification</dt>
          <dd>
            {pinned.classificationTemplate ? (
              <>
                {pinned.classificationTemplate.name}{' '}
                <span className="mono muted">v{pinned.classificationTemplate.version}</span>
                <div className="muted small">{basisLabel(pinned.classificationTemplate)}</div>
              </>
            ) : (
              <span className="muted">None (no table for this format)</span>
            )}
          </dd>
          <dt>Advancement</dt>
          <dd>
            {pinned.advancementPolicy ? (
              <>
                {pinned.advancementPolicy.name}{' '}
                <span className="mono muted">v{pinned.advancementPolicy.version}</span>
                <div className="muted small">{basisLabel(pinned.advancementPolicy)}</div>
              </>
            ) : (
              <span className="muted">None — next-stage slots can’t be resolved</span>
            )}
          </dd>
          {pinned.schedulingProfile ? (
            <>
              <dt>Scheduling profile</dt>
              <dd>
                {pinned.schedulingProfile.name}{' '}
                <span className="mono muted">v{pinned.schedulingProfile.version}</span>
                <div className="muted small">{basisLabel(pinned.schedulingProfile)}</div>
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="muted small">
          No scoring is set yet. Results can’t be validated or classified until it is.
        </p>
      )}
      {canPin && rulesets.length > 0 ? (
        <form action={pinScoringAction} className="tb-form">
          {hidden}
          <input type="hidden" name="key" value={`oc-scoring-${randomUUID()}`} />
          <input
            type="hidden"
            name="schedulingProfileVersionId"
            value={pinned?.schedulingProfile?.versionId ?? ''}
          />
          <label>
            Ruleset
            <select
              name="rulesetVersionId"
              defaultValue={pinned?.ruleset?.versionId ?? ''}
              required
            >
              <option value="">Choose…</option>
              {rulesets.map((rs) => (
                <option key={rs.versionId} value={rs.versionId}>
                  {rs.name} (v{rs.version})
                  {rs.basis.kind === 'COMMON_PRACTICE' ? ' · common practice' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Classification
            <select
              name="classificationTemplateVersionId"
              defaultValue={pinned?.classificationTemplate?.versionId ?? ''}
            >
              <option value="">None</option>
              {[
                ...new Map(
                  rulesets.flatMap((rs) => templates(rs.family)).map((t) => [t.versionId, t]),
                ).values(),
              ].map((t) => (
                <option key={t.versionId} value={t.versionId}>
                  {t.name} (v{t.version})
                </option>
              ))}
            </select>
          </label>
          <label>
            Advancement
            <select
              name="advancementPolicyVersionId"
              defaultValue={pinned?.advancementPolicy?.versionId ?? ''}
            >
              <option value="">None</option>
              {policies.map((p) => (
                <option key={p.versionId} value={p.versionId}>
                  {p.name} (v{p.version})
                  {p.basis.kind === 'COMMON_PRACTICE' ? ' · common practice' : ''}
                </option>
              ))}
            </select>
          </label>
          <SubmitButton pending="Saving" className="btn btn-ghost btn-sm">
            {pinned === null ? 'Set scoring' : 'Change scoring'}
          </SubmitButton>
        </form>
      ) : null}
    </section>
  );
}

function ClassificationTable({
  data,
  names,
}: {
  data: Awaited<ReturnType<typeof stageClassification>> extends infer R
    ? R extends { kind: 'ok'; data: infer D }
      ? D
      : never
    : never;
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
          {data.document.entries.map((x) => (
            <tr key={x.participantId}>
              <td className="mono">
                {x.status === 'CLASSIFIED' ? `${x.position}${x.tied ? '=' : ''}` : x.status}
              </td>
              <td>{nameOf(x.participantId)}</td>
              <td className="mono small">
                {x.values.map((v) => `${v.key} ${v.value}`).join(' · ')}
              </td>
              <td className="muted small">
                {decidedByLabel(x.decidedBy?.kind) ?? (x.tied ? 'tied' : '')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
