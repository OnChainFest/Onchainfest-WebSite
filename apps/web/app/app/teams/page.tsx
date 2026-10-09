import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';
import { appContext } from '../../_lib/app-context';
import { validateContinuationRoute } from '../../_lib/auth/continuation';
import { one, type SearchParams } from '../../_lib/search-params';
import {
  activeMembers,
  myMemberships,
  myTeams,
  TEAM_KIND_LABEL,
  type MyMembership,
  type MyTeam,
} from '../../_lib/teams';
import { Flash } from '../../_product/flash';
import { SubmitButton } from '../../_product/submit-button';
import { createTeamAction, inviteMemberAction, respondMembershipAction } from './actions';

export const metadata = { title: 'Teams · OnChainFest' };

/**
 * ONCF-05B pairs and squads: the teams you manage (members and their consent status), creating a
 * team, inviting a member by public athlete address, and invitations waiting for your answer. A
 * team is a competition identity, not an organization; entries are made from the category page.
 */
export default async function TeamsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  const token = ctx.session.accessToken;
  const [teams, memberships] = await Promise.all([myTeams(token), myMemberships(token)]);
  if (teams.kind !== 'ok' || memberships.kind !== 'ok')
    return (
      <div className="state-block bad">
        <strong>Your teams can’t be loaded right now.</strong>
        <p className="muted">Nothing changed. Try again in a moment.</p>
      </div>
    );
  const next = validateContinuationRoute(one(query.next));
  const athletes = ctx.account.me.athletes;
  const managed = new Set(teams.data.items.map((t) => t.teamId));
  const pending = memberships.data.items.filter((m) => m.status === 'PROPOSED');
  const joined = memberships.data.items.filter(
    (m) => m.status === 'ACTIVE' && !managed.has(m.teamId),
  );
  const slugOf = (athleteId: string) => athletes.find((a) => a.athleteId === athleteId)?.slug;
  const keep = next === null ? null : <input type="hidden" name="next" value={next} />;

  return (
    <>
      <div className="page-head">
        <span className="mono muted">Your OnChainFest</span>
        <h1 className="page-title">
          Your <span className="outline">teams.</span>
        </h1>
        <p className="muted">
          Pairs and squads you enter categories with. Members join by accepting an invitation.
        </p>
        {next !== null ? (
          <a className="btn btn-cyan btn-sm" href={next}>
            Back to your entry →
          </a>
        ) : null}
      </div>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      {pending.length > 0 ? (
        <section className="rg-panel" aria-labelledby="inv-h">
          <h2 id="inv-h" className="rg-h2">
            Invitations
          </h2>
          <ul className="tm-list">
            {pending.map((m) => (
              <Invitation key={m.membershipId} m={m} slug={slugOf(m.athleteId)} keep={keep} />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rg-panel" aria-labelledby="mine-h">
        <h2 id="mine-h" className="rg-h2">
          Teams you manage
        </h2>
        {teams.data.items.length === 0 ? (
          <p className="muted">No teams yet. Create one below.</p>
        ) : (
          <ul className="tm-list">
            {teams.data.items.map((t) => (
              <TeamCard key={t.teamId} t={t} keep={keep} />
            ))}
          </ul>
        )}
      </section>

      {joined.length > 0 ? (
        <section className="rg-panel" aria-labelledby="in-h">
          <h2 id="in-h" className="rg-h2">
            Teams you play for
          </h2>
          <ul className="tm-list">
            {joined.map((m) => (
              <li key={m.membershipId} className="tm-team">
                <strong>{m.teamName}</strong>{' '}
                <span className="chip mono">{TEAM_KIND_LABEL[m.teamKind]}</span>
                {slugOf(m.athleteId) !== undefined ? (
                  <span className="muted small"> · as @{slugOf(m.athleteId)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rg-panel" aria-labelledby="new-h">
        <h2 id="new-h" className="rg-h2">
          Create a team
        </h2>
        <form action={createTeamAction} className="tb-form tm-form">
          <input type="hidden" name="key" value={`oc-team-${randomUUID()}`} />
          {keep}
          <label>
            <span className="mono muted small">Team name</span>
            <input name="displayName" required maxLength={80} placeholder="e.g. Rojas & Mora" />
          </label>
          <fieldset className="st-methods">
            <legend className="mono muted small">Type</legend>
            <label>
              <input type="radio" name="teamKind" value="EVENT_PAIR" defaultChecked /> Pair
            </label>
            <label>
              <input type="radio" name="teamKind" value="EVENT_SQUAD" /> Squad
            </label>
          </fieldset>
          {athletes.length > 0 ? (
            <label>
              <span className="mono muted small">Play in it as</span>
              <select name="athleteId" defaultValue={athletes[0]?.athleteId}>
                {athletes.map((a) => (
                  <option key={a.athleteId} value={a.athleteId}>
                    @{a.slug}
                  </option>
                ))}
                <option value="">Don’t add me (I only manage it)</option>
              </select>
            </label>
          ) : null}
          <SubmitButton pending="Creating" className="btn btn-cyan">
            Create team
          </SubmitButton>
        </form>
      </section>
    </>
  );
}

function TeamCard({ t, keep }: { t: MyTeam; keep: ReactElement | null }) {
  const active = activeMembers(t).length;
  return (
    <li className="tm-team">
      <div className="tm-team-head">
        <strong>{t.displayName}</strong>{' '}
        <span className="chip mono">{TEAM_KIND_LABEL[t.teamKind]}</span>
        <span className="muted small">
          {' '}
          · {active} active member{active === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="tm-members">
        {t.members.map((m) => (
          <li key={m.membershipId} data-status={m.status}>
            {m.athlete !== null ? (
              <a href={`/athletes/${m.athlete.slug}`}>{m.athlete.displayName}</a>
            ) : (
              <em className="muted">Private athlete</em>
            )}
            <span className="muted small">
              {' '}
              · {m.status === 'ACTIVE' ? 'member' : 'invited — waiting for them to accept'}
            </span>
          </li>
        ))}
      </ul>
      <form action={inviteMemberAction} className="tm-invite">
        <input type="hidden" name="teamId" value={t.teamId} />
        <input type="hidden" name="key" value={`oc-inv-${randomUUID()}`} />
        {keep}
        <input
          name="athleteSlug"
          required
          maxLength={51}
          placeholder="athlete address, e.g. ana-rojas"
          aria-label={`Invite to ${t.displayName}`}
        />
        <SubmitButton pending="Inviting" className="btn btn-ghost btn-sm">
          Invite
        </SubmitButton>
      </form>
    </li>
  );
}

function Invitation({
  m,
  slug,
  keep,
}: {
  m: MyMembership;
  slug: string | undefined;
  keep: ReactElement | null;
}) {
  return (
    <li className="tm-team">
      <strong>{m.teamName}</strong> <span className="chip mono">{TEAM_KIND_LABEL[m.teamKind]}</span>
      {slug !== undefined ? <span className="muted small"> · invites @{slug}</span> : null}
      <div className="rg-row-inline">
        {(['accept', 'decline'] as const).map((answer) => (
          <form key={answer} action={respondMembershipAction}>
            <input type="hidden" name="membershipId" value={m.membershipId} />
            <input type="hidden" name="answer" value={answer} />
            {keep}
            <SubmitButton
              pending={answer === 'accept' ? 'Joining' : 'Declining'}
              className={answer === 'accept' ? 'btn btn-cyan btn-sm' : 'btn btn-ghost btn-sm'}
            >
              {answer === 'accept' ? 'Accept' : 'Decline'}
            </SubmitButton>
          </form>
        ))}
      </div>
    </li>
  );
}
