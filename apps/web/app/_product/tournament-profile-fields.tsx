import { instantToZoned, timeZones } from '../_lib/tournament-builder';
import type { ManagedCompetition } from '../_lib/tournaments';
import { NameAddressFields, ZoneSelect } from './tournament-fields';

type Profile = ManagedCompetition['competition']['profile'];

/**
 * Tournament identity fields, shared by "new" and "edit". Grouped as the organizer thinks about an
 * event (what · when · where · about) rather than as a record. Dates are entered as wall-clock time
 * in the tournament's timezone and sent as instants.
 */
export function TournamentProfileFields({
  profile,
  address = '',
  regionDefault = '',
}: {
  profile?: Profile;
  address?: string;
  regionDefault?: string;
}) {
  const tz = profile?.timezone ?? '';
  return (
    <>
      <fieldset className="tb-group" id="identity">
        <legend className="mono">01 · Identity</legend>
        <NameAddressFields
          nameLabel="Tournament name"
          defaultName={profile?.name ?? ''}
          defaultAddress={address}
          addressPrefix="/competitions/"
          placeholder="Autumn Padel Open"
        />
      </fieldset>
      <fieldset className="tb-group">
        <legend className="mono">02 · When</legend>
        <div className="field-row">
          <label className="field">
            <span>Starts</span>
            <input
              type="datetime-local"
              name="startsAt"
              defaultValue={instantToZoned(profile?.startsAt ?? null, tz)}
            />
          </label>
          <label className="field">
            <span>Ends</span>
            <input
              type="datetime-local"
              name="endsAt"
              defaultValue={instantToZoned(profile?.endsAt ?? null, tz)}
            />
          </label>
        </div>
        <ZoneSelect defaultValue={tz} zones={timeZones()} />
      </fieldset>
      <fieldset className="tb-group">
        <legend className="mono">03 · Where</legend>
        <div className="field-row tb-row-wide">
          <label className="field">
            <span>Venue</span>
            <input
              name="locationLabel"
              maxLength={120}
              defaultValue={profile?.locationLabel ?? ''}
              placeholder="Club courts, city"
            />
          </label>
          <label className="field">
            <span>Region</span>
            <input
              name="regionCode"
              maxLength={6}
              pattern="[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?"
              defaultValue={profile?.regionCode ?? regionDefault}
              placeholder="CR or CR-SJ"
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="tb-group">
        <legend className="mono">04 · About</legend>
        <label className="field">
          <span>Description</span>
          <textarea
            name="description"
            maxLength={2000}
            rows={3}
            defaultValue={profile?.description ?? ''}
          />
        </label>
        <label className="field">
          <span>Website</span>
          <input
            name="website"
            type="url"
            pattern="https://.*"
            maxLength={255}
            defaultValue={profile?.website ?? ''}
            placeholder="https://"
          />
        </label>
      </fieldset>
    </>
  );
}
