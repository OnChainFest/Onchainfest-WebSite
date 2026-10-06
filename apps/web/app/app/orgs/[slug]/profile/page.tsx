import { notFound } from 'next/navigation';
import { orgContext, ORG_TYPE_LABEL } from '../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { Flash } from '../../../../_product/flash';
import { OrgMark } from '../../../../_product/org-chrome';
import { SubmitButton } from '../../../../_product/submit-button';
import { updateProfileAction } from '../actions';

export const metadata = { title: 'Profile · OnChainFest' };

/** Brand swatches drawn from the OnChainFest palette; any #rrggbb is accepted by the API. */
const SWATCHES = ['#00d8ff', '#7c3cff', '#ff2da4', '#52f0b0', '#ffd166', '#ff7a1a', '#f8fafc'];

export default async function OrgProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const result = await orgContext(slug);
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  const p = ctx.profile?.profile;
  const canEdit = ctx.permissions.has('ORG_EDIT_PROFILE');
  const accent = p?.accentColor ?? '#00d8ff';

  return (
    <div className="split">
      <section aria-labelledby="pf-h">
        <h2 id="pf-h" className="mono muted">
          Public profile
        </h2>
        <Flash error={one(query.error)} notice={one(query.notice)} />
        {canEdit ? (
          <form action={updateProfileAction} className="form-col">
            <input type="hidden" name="slug" value={slug} />
            <label className="field">
              <span>Organization name</span>
              <input
                required
                name="displayName"
                maxLength={120}
                defaultValue={p?.displayName ?? ctx.membership.displayName}
              />
            </label>
            <label className="field">
              <span>About</span>
              <textarea
                name="description"
                maxLength={2000}
                rows={4}
                defaultValue={p?.description ?? ''}
              />
            </label>
            <label className="field">
              <span>Sports · comma separated</span>
              <input
                name="sports"
                maxLength={450}
                defaultValue={(p?.sports ?? []).join(', ')}
                placeholder="Padel, Tennis"
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Website</span>
                <input
                  name="website"
                  type="url"
                  defaultValue={p?.website ?? ''}
                  placeholder="https://"
                />
              </label>
              <label className="field">
                <span>Country</span>
                <input
                  name="country"
                  maxLength={2}
                  pattern="[A-Za-z]{2}"
                  defaultValue={p?.country ?? ''}
                  placeholder="CR"
                />
              </label>
            </div>
            <label className="field">
              <span>Public contact</span>
              <input
                name="publicContact"
                maxLength={200}
                defaultValue={p?.publicContact ?? ''}
                placeholder="Email or phone shown on your public page"
              />
              <small>Shown publicly. Leave blank to hide.</small>
            </label>
            <label className="field">
              <span>Logo URL</span>
              <input
                name="logoUrl"
                type="url"
                maxLength={500}
                defaultValue={p?.logoUrl ?? ''}
                placeholder="https://…/logo.png"
              />
              <small>A square https image works best.</small>
            </label>
            <fieldset className="field swatches">
              <span>Brand colour</span>
              <div>
                {SWATCHES.map((c) => (
                  <label key={c} className="swatch" style={{ background: c }}>
                    <input
                      type="radio"
                      name="accentColor"
                      value={c}
                      defaultChecked={c === accent}
                    />
                    <span className="sr-only">{c}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <SubmitButton pending="Saving">Save profile</SubmitButton>
          </form>
        ) : (
          <p className="muted">
            Only owners and admins can edit the profile. This is how it appears publicly.
          </p>
        )}
      </section>
      <section aria-label="Preview">
        <h2 className="mono muted">Preview</h2>
        <article className="preview-card" style={{ '--brand': accent } as Record<string, string>}>
          <div className="preview-band" />
          <div className="preview-body">
            <OrgMark
              name={p?.displayName ?? ctx.membership.displayName}
              logoUrl={p?.logoUrl}
              size={72}
            />
            <span className="mono muted">
              {ORG_TYPE_LABEL[ctx.membership.orgType] ?? ctx.membership.orgType}
              {p?.country ? ` · ${p.country}` : ''}
            </span>
            <h3>{p?.displayName ?? ctx.membership.displayName}</h3>
            {p?.description ? <p className="muted">{p.description}</p> : null}
            {(p?.sports ?? []).length > 0 ? (
              <div className="chip-row">
                {(p?.sports ?? []).map((s) => (
                  <span key={s} className="chip mono">
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
            <a className="link mono" href={`/organizations/${slug}`}>
              /organizations/{slug} ↗
            </a>
          </div>
        </article>
      </section>
    </div>
  );
}
