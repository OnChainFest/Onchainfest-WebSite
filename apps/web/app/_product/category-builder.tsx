'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  catalogSports,
  compatibleFormats,
  configFields,
  disciplinesFor,
  entrantLabel,
  GENDER_LABEL,
  type ConfigField,
} from '../_lib/tournament-builder';
import type { Catalog, EntrantKind } from '../_lib/tournaments';
import { CategorySettingsFields } from './category-fields';
import { SubmitButton } from './submit-button';
import { SportGlyph } from './tournament-ui';

/**
 * Category builder: Sport → Discipline → Entrants → Format, then the category's settings, with a
 * card that assembles as choices are made. Every option comes from GET /v1/catalog; a format is
 * offered only when the discipline lists it in `compatibleFormatVersionIds`, and an entrant kind
 * only when the discipline's `participantKinds` include it. The server action and the API
 * re-check the combination.
 */
export function CategoryBuilder({
  catalog,
  action,
  slug,
  competitionId,
  idemKey,
  competitionTz,
  zones,
  cancelHref,
}: {
  catalog: Catalog;
  action: (form: FormData) => Promise<never>;
  slug: string;
  competitionId: string;
  idemKey: string;
  competitionTz: string;
  zones: readonly string[];
  cancelHref: string;
}) {
  const sports = useMemo(() => catalogSports(catalog), [catalog]);
  const initial = useMemo(
    () => pick(catalog, sports.length === 1 ? (sports[0]?.code ?? '') : ''),
    [catalog, sports],
  );
  const [sport, setSport] = useState(initial.sport);
  const [dv, setDv] = useState(initial.dv);
  const [kind, setKind] = useState<string>(initial.kind);
  const [fv, setFv] = useState(initial.fv);
  const [preview, setPreview] = useState<Record<string, string>>({});

  const disciplines = sport === '' ? [] : disciplinesFor(catalog, sport);
  const discipline = disciplines.find((d) => d.disciplineVersionId === dv);
  const formats = dv === '' ? [] : compatibleFormats(catalog, dv);
  const format = formats.find((f) => f.formatVersionId === fv);
  const config = configFields(format?.configurationSchema);
  const sportInfo = sports.find((s) => s.code === sport);
  const codeCount = (code: string) => disciplines.filter((d) => d.discipline.code === code).length;
  const ready =
    discipline !== undefined && kind !== '' && format !== undefined && config.kind === 'fields';

  function chooseSport(code: string) {
    const next = pick(catalog, code);
    setSport(next.sport);
    setDv(next.dv);
    setKind(next.kind);
    setFv(next.fv);
  }
  function chooseDiscipline(id: string) {
    const next = pickDiscipline(catalog, id);
    setDv(id);
    setKind(next.kind);
    setFv(next.fv);
  }
  function track(e: FormEvent<HTMLFormElement>) {
    const t = e.target as HTMLInputElement;
    if (
      ['name', 'genderCategory', 'capacity', 'registrationMode', 'skillClass', 'ageLabel'].includes(
        t.name,
      )
    )
      setPreview((p) => ({ ...p, [t.name]: t.value }));
  }

  if (sports.length === 0)
    return (
      <div className="state-block bad">
        <strong>No sports are available in the catalog yet.</strong>
        <p className="muted">A platform operator needs to provision the catalog first.</p>
      </div>
    );

  return (
    <div className="tb-builder cb">
      <form action={action} className="tb-form" onChange={track}>
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="competitionId" value={competitionId} />
        <input type="hidden" name="key" value={idemKey} />

        <Step n={1} title="Sport" done={sport !== ''} summary={sportInfo?.name}>
          <div className="cb-tiles" role="radiogroup" aria-label="Sport">
            {sports.map((s) => (
              <label key={s.code} className="cb-tile" data-on={s.code === sport}>
                <input
                  type="radio"
                  name="sport"
                  value={s.code}
                  checked={s.code === sport}
                  onChange={() => chooseSport(s.code)}
                />
                <SportGlyph code={s.code} name={s.name} size={52} />
                <strong>{s.name}</strong>
                <span className="muted small">
                  {s.disciplines} {s.disciplines === 1 ? 'discipline' : 'disciplines'}
                </span>
              </label>
            ))}
          </div>
        </Step>

        <Step
          n={2}
          title="Discipline"
          done={discipline !== undefined}
          locked={sport === ''}
          summary={discipline?.discipline.name}
        >
          <div className="cb-tiles" role="radiogroup" aria-label="Discipline">
            {disciplines.map((d) => (
              <label
                key={d.disciplineVersionId}
                className="cb-tile"
                data-on={d.disciplineVersionId === dv}
              >
                <input
                  type="radio"
                  name="disciplineVersionId"
                  value={d.disciplineVersionId}
                  checked={d.disciplineVersionId === dv}
                  onChange={() => chooseDiscipline(d.disciplineVersionId)}
                />
                <strong>
                  {d.discipline.name}
                  {codeCount(d.discipline.code) > 1 ? (
                    <span className="mono muted"> v{d.version}</span>
                  ) : null}
                </strong>
                <span className="muted small">
                  {d.participantKinds.map((k) => entrantLabel(k, d.lineupSize)).join(' · ')}
                </span>
              </label>
            ))}
          </div>
        </Step>

        <Step
          n={3}
          title="Entrants"
          done={kind !== ''}
          locked={discipline === undefined}
          summary={
            discipline !== undefined && kind !== ''
              ? entrantLabel(kind as EntrantKind, discipline.lineupSize)
              : undefined
          }
        >
          <div className="cb-tiles" role="radiogroup" aria-label="Entrants">
            {(discipline?.participantKinds ?? []).map((k) => (
              <label key={k} className="cb-tile" data-on={k === kind}>
                <input
                  type="radio"
                  name="entrantKind"
                  value={k}
                  checked={k === kind}
                  onChange={() => setKind(k)}
                />
                <span className="cb-people" aria-hidden="true">
                  {Array.from(
                    { length: k === 'TEAM' ? Math.min(4, discipline?.lineupSize.max ?? 2) : 1 },
                    (_, i) => (
                      <span key={i} />
                    ),
                  )}
                </span>
                <strong>{entrantLabel(k, discipline?.lineupSize ?? { min: 1, max: 1 })}</strong>
              </label>
            ))}
          </div>
        </Step>

        <Step
          n={4}
          title="Format"
          done={format !== undefined}
          locked={kind === ''}
          summary={format?.format.name}
        >
          {formats.length === 0 ? (
            <p className="muted">No format in the catalog can run this discipline yet.</p>
          ) : (
            <div className="cb-tiles" role="radiogroup" aria-label="Format">
              {formats.map((f) => (
                <label
                  key={f.formatVersionId}
                  className="cb-tile"
                  data-on={f.formatVersionId === fv}
                >
                  <input
                    type="radio"
                    name="formatVersionId"
                    value={f.formatVersionId}
                    checked={f.formatVersionId === fv}
                    onChange={() => setFv(f.formatVersionId)}
                  />
                  <FormatArt code={f.format.code} />
                  <strong>{f.format.name}</strong>
                  <span className="mono muted">
                    {(f.contestType ?? '').toLowerCase()} · v{f.version}
                  </span>
                </label>
              ))}
            </div>
          )}
          {config.kind === 'unsupported' ? (
            <p className="flash" role="alert">
              This format needs settings the builder can’t edit yet.
            </p>
          ) : config.fields.length > 0 ? (
            <div className="cb-config">
              {config.fields.map((f) => (
                <ConfigControl key={f.name} f={f} />
              ))}
            </div>
          ) : null}
        </Step>

        <div className="cb-settings" data-locked={!ready}>
          <CategorySettingsFields
            create
            startNumber={5}
            capacityEditable
            zones={zones}
            competitionTz={competitionTz}
            namePlaceholder={discipline?.discipline.name}
          />
        </div>

        <div className="tb-form-foot">
          {ready ? (
            <SubmitButton pending="Adding" className="btn btn-cyan">
              Add category →
            </SubmitButton>
          ) : (
            <button className="btn btn-cyan" type="button" disabled aria-disabled="true">
              Choose sport, discipline, entrants and format
            </button>
          )}
          <a className="btn btn-ghost" href={cancelHref}>
            Cancel
          </a>
        </div>
      </form>

      <aside className="tb-aside cb-preview" aria-label="Category preview">
        <div className="cb-card">
          <span className="cb-card-head">
            {sportInfo !== undefined ? (
              <SportGlyph code={sportInfo.code} name={sportInfo.name} size={56} />
            ) : (
              <span className="cb-ph-glyph" aria-hidden="true" />
            )}
            <span>
              <strong>{preview.name || discipline?.discipline.name || 'New category'}</strong>
              <span className="muted small">
                {[sportInfo?.name, discipline?.discipline.name].filter(Boolean).join(' · ') ||
                  'Pick a sport'}
              </span>
            </span>
          </span>
          <span className="tb-chips">
            <Slot on={kind !== '' && discipline !== undefined}>
              {discipline !== undefined && kind !== ''
                ? entrantLabel(kind as EntrantKind, discipline.lineupSize)
                : 'Entrants'}
            </Slot>
            <Slot on={format !== undefined}>{format?.format.name ?? 'Format'}</Slot>
            {preview.genderCategory ? (
              <Slot on>{GENDER_LABEL[preview.genderCategory] ?? ''}</Slot>
            ) : null}
            {preview.skillClass ? <Slot on>{preview.skillClass}</Slot> : null}
            {preview.ageLabel ? <Slot on>{preview.ageLabel}</Slot> : null}
          </span>
          <span className="cb-card-foot mono">
            <span>{preview.capacity ? `${preview.capacity} spots` : 'No cap'}</span>
            <span>
              {preview.registrationMode === 'ORGANIZER_APPROVAL' ? 'Approval' : 'Auto-confirm'}
            </span>
          </span>
        </div>
      </aside>
    </div>
  );
}

function pickDiscipline(catalog: Catalog, dv: string) {
  const d = catalog.disciplineVersions.find((x) => x.disciplineVersionId === dv);
  const fs = dv === '' ? [] : compatibleFormats(catalog, dv);
  return {
    kind: d !== undefined && d.participantKinds.length === 1 ? (d.participantKinds[0] ?? '') : '',
    fv: fs.length === 1 ? (fs[0]?.formatVersionId ?? '') : '',
  };
}

/** Choosing a sport preselects anything that has a single option left. */
function pick(catalog: Catalog, sport: string) {
  const ds = sport === '' ? [] : disciplinesFor(catalog, sport);
  const dv = ds.length === 1 ? (ds[0]?.disciplineVersionId ?? '') : '';
  return { sport, dv, ...pickDiscipline(catalog, dv) };
}

function Step({
  n,
  title,
  done,
  locked = false,
  summary,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  locked?: boolean;
  summary?: string | undefined;
  children: ReactNode;
}) {
  return (
    <fieldset
      className="tb-group cb-step"
      data-state={locked ? 'locked' : done ? 'done' : 'current'}
      disabled={locked}
    >
      <legend className="mono">
        {String(n).padStart(2, '0')} · {title}
        {summary !== undefined && done ? <span className="cb-summary"> — {summary}</span> : null}
      </legend>
      {locked ? null : children}
    </fieldset>
  );
}

function Slot({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={on ? 'chip mono' : 'chip mono cb-ph'}>{children}</span>;
}

/** Small structural diagram for a format (bracket for elimination, grid otherwise). */
function FormatArt({ code }: { code: string }) {
  const bracket = code.includes('elimination') || code.includes('knockout');
  return (
    <svg className="cb-format-art" viewBox="0 0 80 40" aria-hidden="true">
      {bracket ? (
        <path d="M2 4h14v8H2M2 28h14v8H2M16 8h8v24h-8M24 20h14M38 20h0M44 12h14v16H44M58 20h20" />
      ) : (
        <>
          <rect x="8" y="4" width="64" height="32" />
          <path d="M8 12.5h64M8 20.5h64M8 28.5h64M24 4v32M40 4v32M56 4v32" />
        </>
      )}
    </svg>
  );
}

function ConfigControl({ f }: { f: ConfigField }) {
  const label = f.name.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (f.kind === 'boolean')
    return (
      <label className="field cb-check">
        <input type="checkbox" name={`cfg.${f.name}`} defaultChecked={f.default ?? false} />
        <span>{label}</span>
      </label>
    );
  if (f.kind === 'enum')
    return (
      <label className="field">
        <span>{label}</span>
        <select name={`cfg.${f.name}`} required={f.required} defaultValue={f.default ?? ''}>
          {f.required ? null : <option value="">—</option>}
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={`cfg.${f.name}`}
        required={f.required}
        {...(f.kind === 'integer'
          ? { type: 'number', min: f.minimum, max: f.maximum, defaultValue: f.default }
          : { maxLength: f.maxLength, defaultValue: f.default })}
      />
    </label>
  );
}
