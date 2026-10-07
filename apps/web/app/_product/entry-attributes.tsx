import { randomUUID } from 'node:crypto';
import {
  attributeField,
  attributeHint,
  attributeLabel,
  displayValue,
  type AttributeContext,
} from '../_lib/entry-attributes';
import { SubmitButton } from './submit-button';

/**
 * ONCF-05B declared entry values on a registration (entry time, average, handicap index, bib,
 * classification points…). Editable until the field is locked when an `action` is given;
 * otherwise read-only. Always labelled as declared: OnChainFest never verifies these values.
 */
export function EntryAttributesPanel({
  registrationId,
  ctx,
  action,
}: {
  registrationId: string;
  ctx: AttributeContext;
  action?: (form: FormData) => Promise<never>;
}) {
  const value = (key: string, athleteId?: string) =>
    ctx.values.find((v) => v.key === key && v.athleteId === athleteId)?.value;
  // Members come from the team the viewer manages; staff (read-only) see the declared members.
  const members =
    ctx.members.length > 0
      ? ctx.members
      : [
          ...new Set(ctx.values.flatMap((v) => (v.athleteId === undefined ? [] : [v.athleteId]))),
        ].map((athleteId, i) => ({ athleteId, label: `Member ${i + 1}` }));
  const rows = ctx.specs.flatMap((s) =>
    s.scope === 'MEMBER'
      ? members.map((m) => ({ spec: s, athleteId: m.athleteId, who: m.label }))
      : [{ spec: s, athleteId: undefined as string | undefined, who: null as string | null }],
  );
  const editing = action !== undefined && ctx.editable;
  return (
    <section className="rg-panel ea-panel" aria-labelledby="ea-h">
      <h2 id="ea-h" className="mono muted">
        Entry details <span className="chip mono">Declared · not verified</span>
      </h2>
      <p className="muted small">
        {editing
          ? 'Used for seeding, start lists and handicaps. You can change them until the organizer locks the field.'
          : ctx.editable
            ? 'Declared by the entrant.'
            : 'Frozen: the organizer has locked the field.'}
      </p>
      {editing ? (
        <form action={action} className="tb-form ea-form">
          <input type="hidden" name="registrationId" value={registrationId} />
          <input type="hidden" name="key" value={`oc-attr-${randomUUID()}`} />
          {rows.map(({ spec, athleteId, who }) => {
            const name = attributeField(spec.key, athleteId);
            const v = value(spec.key, athleteId);
            return (
              <label key={name}>
                <span className="mono muted small">
                  {attributeLabel(spec.key)}
                  {who !== null ? ` · ${who}` : ''}
                  {spec.required ? ' (required)' : ''}
                </span>
                <input
                  name={name}
                  defaultValue={v === undefined ? '' : displayValue(spec, v)}
                  placeholder={attributeHint(spec)}
                />
                <input type="hidden" name={`prev.${name}`} value={v ?? ''} />
              </label>
            );
          })}
          <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
            Save entry details
          </SubmitButton>
        </form>
      ) : (
        <dl className="rg-summary">
          {rows.map(({ spec, athleteId, who }) => {
            const v = value(spec.key, athleteId);
            return (
              <div key={attributeField(spec.key, athleteId)}>
                <dt className="mono">
                  {attributeLabel(spec.key)}
                  {who !== null ? ` · ${who}` : ''}
                </dt>
                <dd>
                  {v === undefined ? <span className="muted">—</span> : displayValue(spec, v)}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
