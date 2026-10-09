import { GENDER_LABEL, instantToZoned } from '../_lib/tournament-builder';
import type { ManagedEvent } from '../_lib/tournaments';
import { NameAddressFields, ZoneSelect } from './tournament-fields';

type Settings = ManagedEvent['settings'];

/**
 * Category settings, in builder order: identity labels → registration → schedule. Used by the
 * add-category builder and the category page. With `capacityEditable` false (the API's
 * `editable.capacityAndRegistrationMode`), capacity and registration mode are shown, not offered.
 */
export function CategorySettingsFields({
  settings,
  capacityEditable,
  zones,
  competitionTz,
  namePlaceholder,
  create = false,
  startNumber = 1,
}: {
  settings?: Settings;
  capacityEditable: boolean;
  zones: readonly string[];
  competitionTz: string;
  namePlaceholder?: string | undefined;
  create?: boolean;
  startNumber?: number;
}) {
  const tz = settings?.timezone ?? competitionTz;
  const cat = (settings?.category ?? {}) as Record<string, unknown>;
  const age = (cat.ageCategory ?? {}) as { label?: string; minAge?: number; maxAge?: number };
  const gender = typeof cat.genderCategory === 'string' ? cat.genderCategory : '';
  const n = (i: number) => String(startNumber + i).padStart(2, '0');
  return (
    <>
      <fieldset className="tb-group">
        <legend className="mono">{n(0)} · Category</legend>
        {create ? (
          <NameAddressFields
            nameLabel="Category name"
            addressPrefix="…/events/"
            placeholder={namePlaceholder ?? 'Men’s Open'}
          />
        ) : (
          <label className="field tb-name">
            <span>Category name</span>
            <input required name="name" maxLength={120} defaultValue={settings?.name ?? ''} />
          </label>
        )}
        <div className="field">
          <span>Division</span>
          <div className="tb-seg" role="radiogroup" aria-label="Division">
            <label>
              <input type="radio" name="genderCategory" value="" defaultChecked={gender === ''} />
              <span>None</span>
            </label>
            {Object.entries(GENDER_LABEL).map(([code, label]) => (
              <label key={code}>
                <input
                  type="radio"
                  name="genderCategory"
                  value={code}
                  defaultChecked={gender === code}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Level</span>
            <input
              name="skillClass"
              maxLength={40}
              defaultValue={typeof cat.skillClass === 'string' ? cat.skillClass : ''}
              placeholder="A, B, Pro…"
            />
          </label>
          <label className="field">
            <span>Age group</span>
            <input
              name="ageLabel"
              maxLength={40}
              defaultValue={age.label ?? ''}
              placeholder="U18, 40+…"
            />
          </label>
        </div>
        <details
          className="tb-more"
          open={age.minAge !== undefined || typeof cat.division === 'string'}
        >
          <summary className="mono">More labels</summary>
          <div className="field-row">
            <label className="field">
              <span>Min age</span>
              <input
                name="minAge"
                type="number"
                min={0}
                max={120}
                defaultValue={age.minAge ?? ''}
              />
            </label>
            <label className="field">
              <span>Max age</span>
              <input
                name="maxAge"
                type="number"
                min={0}
                max={120}
                defaultValue={age.maxAge ?? ''}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Group</span>
              <input
                name="division"
                maxLength={40}
                defaultValue={typeof cat.division === 'string' ? cat.division : ''}
                placeholder="Gold, Silver…"
              />
            </label>
            <label className="field">
              <span>Tags · comma separated</span>
              <input
                name="customLabels"
                maxLength={330}
                defaultValue={Array.isArray(cat.customLabels) ? cat.customLabels.join(', ') : ''}
              />
            </label>
          </div>
        </details>
      </fieldset>

      <fieldset className="tb-group">
        <legend className="mono">{n(1)} · Registration</legend>
        {capacityEditable ? (
          <>
            <div className="field-row">
              <label className="field">
                <span>Capacity</span>
                <input
                  name="capacity"
                  type="number"
                  min={1}
                  max={4096}
                  defaultValue={settings?.capacity ?? ''}
                  placeholder="No cap"
                />
              </label>
              <div className="field">
                <span>Entries</span>
                <div className="tb-seg" role="radiogroup" aria-label="Entries">
                  <label>
                    <input
                      type="radio"
                      name="registrationMode"
                      value="AUTO_CONFIRM"
                      defaultChecked={settings?.registrationMode !== 'ORGANIZER_APPROVAL'}
                    />
                    <span>Auto-confirm</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="registrationMode"
                      value="ORGANIZER_APPROVAL"
                      defaultChecked={settings?.registrationMode === 'ORGANIZER_APPROVAL'}
                    />
                    <span>Approval</span>
                  </label>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="tb-locked-row">
            <span className="tb-lock mono">Locked after draft</span>
            <span>
              <span className="mono muted">Capacity</span> {settings?.capacity ?? 'No cap'}
            </span>
            <span>
              <span className="mono muted">Entries</span>{' '}
              {settings?.registrationMode === 'ORGANIZER_APPROVAL' ? 'Approval' : 'Auto-confirm'}
            </span>
          </div>
        )}
        <div className="field-row">
          <label className="field">
            <span>Registration opens</span>
            <input
              type="datetime-local"
              name="registrationOpensAt"
              defaultValue={instantToZoned(settings?.registrationOpensAt ?? null, tz)}
            />
          </label>
          <label className="field">
            <span>Registration closes</span>
            <input
              type="datetime-local"
              name="registrationClosesAt"
              defaultValue={instantToZoned(settings?.registrationClosesAt ?? null, tz)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="tb-group">
        <legend className="mono">{n(2)} · Schedule</legend>
        <div className="field-row">
          <label className="field">
            <span>Play starts</span>
            <input
              type="datetime-local"
              name="startsAt"
              defaultValue={instantToZoned(settings?.startsAt ?? null, tz)}
            />
          </label>
          <label className="field">
            <span>Play ends</span>
            <input
              type="datetime-local"
              name="endsAt"
              defaultValue={instantToZoned(settings?.endsAt ?? null, tz)}
            />
          </label>
        </div>
        <ZoneSelect defaultValue={tz} zones={zones} />
      </fieldset>
    </>
  );
}
