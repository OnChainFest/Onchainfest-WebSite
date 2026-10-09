'use client';

import { useActionState, useState } from 'react';
import { errorMessage } from '../_lib/auth/messages';
import type { InviteState } from '../app/orgs/[slug]/actions';
import { SubmitButton } from './submit-button';

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  STAFF: 'Staff',
  COACH: 'Coach',
  OFFICIAL: 'Official',
  ATHLETE: 'Athlete',
  MEMBER: 'Member',
};

/**
 * Invitation form. Presentation only: the server action calls the canonical invitation API, which
 * enforces ORG_INVITE_MEMBER and the role rules. The one-time link exists only in this response.
 */
export function InviteForm({
  slug,
  roles,
  initialKey,
  action,
}: {
  slug: string;
  roles: string[];
  initialKey: string;
  action: (prev: InviteState, form: FormData) => Promise<InviteState>;
}) {
  const [state, formAction] = useActionState(action, { kind: 'idle', nextKey: initialKey });
  const [copied, setCopied] = useState(false);
  const error = state.kind === 'error' ? errorMessage(state.error) : null;

  return (
    <div className="invite">
      <form action={formAction} className="form-col">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="key" value={state.nextKey} />
        <label className="field">
          <span>Athlete profile address</span>
          <input
            required
            name="athleteSlug"
            maxLength={200}
            placeholder="ana-perez or …/athletes/ana-perez"
            autoComplete="off"
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Role</span>
            <select name="role" defaultValue={roles.includes('ATHLETE') ? 'ATHLETE' : roles[0]}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Shown on roster to</span>
            <select name="visibility" defaultValue="MEMBERS">
              <option value="PUBLIC">Everyone</option>
              <option value="MEMBERS">Members</option>
              <option value="PRIVATE">Admins only</option>
            </select>
          </label>
        </div>
        {error !== null ? (
          <p className="flash" role="alert">
            {error}
          </p>
        ) : null}
        <SubmitButton pending="Creating invitation">Create invitation</SubmitButton>
      </form>
      {state.kind === 'ok' && state.link !== undefined ? (
        <div className="one-time" role="status">
          <span className="mono">Invitation link · shown once</span>
          <p className="muted small">
            Send it to the athlete. It works only for their account and expires{' '}
            {state.expiresAt !== undefined
              ? new Date(state.expiresAt).toLocaleDateString('en', {
                  day: 'numeric',
                  month: 'short',
                  timeZone: 'UTC',
                })
              : 'in 7 days'}
            .
          </p>
          <div className="copy-field">
            <input
              readOnly
              value={state.link}
              aria-label="Invitation link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(state.link ?? '')
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
