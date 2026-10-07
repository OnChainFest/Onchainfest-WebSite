'use client';

import { useEffect, useState } from 'react';
import { slugSuggestion } from '../_lib/tournament-builder';

/**
 * Name + public address pair. The address follows the name until the organizer edits it (or when
 * one already exists). Presentation only: the API normalizes and re-validates the slug.
 */
export function NameAddressFields({
  nameLabel,
  defaultName = '',
  defaultAddress = '',
  addressPrefix,
  placeholder,
}: {
  nameLabel: string;
  defaultName?: string;
  defaultAddress?: string;
  addressPrefix: string;
  placeholder?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [address, setAddress] = useState(defaultAddress);
  const [touched, setTouched] = useState(defaultAddress !== '');
  const shown = touched ? address : slugSuggestion(name);
  return (
    <>
      <label className="field tb-name">
        <span>{nameLabel}</span>
        <input
          required
          name="name"
          maxLength={120}
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Public address</span>
        <span className="tb-address">
          <span className="mono muted">{addressPrefix}</span>
          <input
            name="address"
            minLength={3}
            maxLength={50}
            pattern="[a-z0-9](?:[a-z0-9\-]{1,48}[a-z0-9])"
            value={shown}
            onChange={(e) => {
              setTouched(true);
              setAddress(e.target.value.toLowerCase());
            }}
          />
        </span>
      </label>
    </>
  );
}

/** IANA timezone picker; with no stored value it starts at the browser's zone when listed. */
export function ZoneSelect({
  name = 'timezone',
  defaultValue,
  zones,
  label = 'Timezone',
}: {
  name?: string;
  defaultValue: string;
  zones: readonly string[];
  label?: string;
}) {
  const [value, setValue] = useState(defaultValue === '' ? 'UTC' : defaultValue);
  useEffect(() => {
    if (defaultValue !== '') return;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zones.includes(local)) setValue(local);
  }, [defaultValue, zones]);
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} value={value} onChange={(e) => setValue(e.target.value)}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}
