import { notFound } from 'next/navigation';
import { orgContext } from '../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { Flash } from '../../../../_product/flash';
import { SubmitButton } from '../../../../_product/submit-button';
import { changeAddressAction, leaveAction } from '../actions';

export const metadata = { title: 'Settings · OnChainFest' };

export default async function SettingsPage({
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
  const canEdit = ctx.permissions.has('ORG_EDIT_PROFILE');

  return (
    <>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <div className="split">
        <section aria-labelledby="addr-h">
          <h2 id="addr-h" className="mono muted">
            Public page address
          </h2>
          <p className="address mono">/organizations/{slug}</p>
          {canEdit ? (
            <form action={changeAddressAction} className="form-col">
              <input type="hidden" name="slug" value={slug} />
              <label className="field">
                <span>New address</span>
                <input
                  required
                  name="newSlug"
                  maxLength={50}
                  pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
                  placeholder="club-uno"
                />
                <small>Old links keep working and redirect to the new address.</small>
              </label>
              <SubmitButton pending="Changing" className="btn btn-ghost">
                Change address
              </SubmitButton>
            </form>
          ) : (
            <p className="muted">Only owners and admins can change the address.</p>
          )}
        </section>
        <section aria-labelledby="leave-h">
          <h2 id="leave-h" className="mono muted">
            Membership
          </h2>
          <p className="muted">
            Leaving removes this organization from your account. An organization must keep at least
            one owner.
          </p>
          <details className="confirm">
            <summary className="btn btn-ghost">Leave organization</summary>
            <form action={leaveAction}>
              <input type="hidden" name="slug" value={slug} />
              <button className="btn btn-danger" type="submit">
                Confirm — leave {ctx.membership.displayName}
              </button>
            </form>
          </details>
        </section>
      </div>
    </>
  );
}
