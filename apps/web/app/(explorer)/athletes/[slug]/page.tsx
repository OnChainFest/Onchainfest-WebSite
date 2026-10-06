import { notFound, permanentRedirect } from 'next/navigation';
import { PassportAchievementItem } from '../../../_lib/achievement';
import { PassportRecordItemView } from '../../../_lib/record';
import { getPublic, type AthletePassport } from '../../../_lib/api';
import { SectionBlock, TrustBadge, Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return getPublic<{ passport: AthletePassport; canonicalSlug: string; redirected: boolean }>(
    `/v1/athletes/${encodeURIComponent(slug)}`,
  );
}

export async function generateMetadata({ params }: Params) {
  const r = await load((await params).slug);
  return {
    title:
      r.kind === 'ok'
        ? `${r.data.passport.athlete.displayName.value} · Athlete Passport`
        : 'Athlete Passport',
  };
}

export default async function AthletePage({ params }: Params) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  if (r.data.redirected || r.data.canonicalSlug !== slug)
    permanentRedirect(`/athletes/${r.data.canonicalSlug}`);
  const p = r.data.passport;
  const a = p.athlete;
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>Athlete Passport</p>
      <h1 style={{ marginBottom: 0 }}>
        {a.displayName.value}
        <TrustBadge provenance={a.displayName.provenance} />
      </h1>
      <p style={{ color: '#6b7280' }}>@{a.slug}</p>
      {a.bio && (
        <p>
          {a.bio.value}
          <TrustBadge provenance={a.bio.provenance} />
        </p>
      )}
      <p>
        {a.homeCountry && <>Home country: {a.homeCountry.value} </>}
        {a.preferredSports.value.length > 0 && <>· Sports: {a.preferredSports.value.join(', ')}</>}
        {(a.homeCountry || a.preferredSports.value.length > 0) && (
          <TrustBadge provenance={a.preferredSports.provenance} />
        )}
      </p>
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        The profile above is described by the athlete. It is not a verified sporting record.
        Verified achievements appear only when a published rule derives them from exact, currently
        verified sporting facts — they are never awarded manually.
      </aside>

      <SectionBlock
        title="Affiliations"
        section={p.affiliations}
        empty="No public affiliations."
        render={(x, i) => (
          <li key={i}>
            {x.role.value.toLowerCase()} at{' '}
            <a href={`/organizations/${x.organizationSlug}`}>{x.organizationName.value}</a> (
            {x.organizationType.toLowerCase()}) since {x.since.slice(0, 10)}
            <TrustBadge provenance={x.role.provenance} />
          </li>
        )}
      />
      <SectionBlock
        title="External identities"
        section={p.externalIdentities}
        empty="No public external identities."
        render={(x, i) => (
          <li key={i}>
            {x.namespace}: {x.value} <small>({x.status.toLowerCase()})</small>
            <TrustBadge provenance={x.provenance} />
          </li>
        )}
      />
      <SectionBlock
        title="Wallets"
        section={p.wallets}
        empty="No public wallets."
        render={(x, i) => (
          <li key={i}>
            <code>{x.address}</code> on {x.network}
            <TrustBadge provenance={x.provenance} />
          </li>
        )}
      />
      <SectionBlock
        title="Verified achievements"
        section={p.verifiedAchievements}
        empty="None yet."
        render={(x) => <PassportAchievementItem key={x.achievementId} x={x} />}
      />
      <SectionBlock
        title="Records"
        section={p.records}
        empty="None yet. (Personal bests appear under Verified achievements.)"
        render={(x) => <PassportRecordItemView key={x.recordMarkId} x={x} />}
      />
      <SectionBlock
        title="Competition history"
        section={p.competitionHistory}
        empty="None yet."
        render={() => null}
      />
      <SectionBlock
        title="Career statistics"
        section={p.careerStats}
        empty="None yet."
        render={() => null}
      />
      <SectionBlock title="Trophies" section={p.trophies} empty="None yet." render={() => null} />
    </main>
  );
}
