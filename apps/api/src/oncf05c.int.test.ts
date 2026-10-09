import { RULESET_TEMPLATES, SWIMMING_POOL_V2 } from '@br/competition';
import { newId } from '@br/domain';
import { CatalogStore, CompetitionReader, IdentityStore } from '@br/persistence';
import { CLASSIFICATION_TEMPLATES } from '@br/rankings';
import { apiDb, newTestAccount, operatorDb, uniqueSlug } from '@br/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-05C API: pin scoring, validate a score sheet, read a stage classification. All COMP_STAFF;
// nothing writes a result or a classification (results are the ResultLedger's; 05D).

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf05c-api-int-secret-0123456789abcdef';
const db = apiDb();
const operator = operatorDb();
const app = buildServer({
  db,
  operatorDb: operator,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await app.close();
  await Promise.all([db.destroy(), operator.destroy()]);
});

const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const auth = (subject: string) => ({
  authorization: `Bearer ${mintDevToken(subject, { secret: SECRET })}`,
});
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: res.body.length > 0 ? (res.json() as Json) : null,
    text: res.body,
  };
}
async function person(label: string) {
  const h = auth(`${label}-${newId()}`);
  const p = await call('POST', '/v1/persons', { ...h, ...idem() }, { relation: 'SELF' });
  expect(p.status).toBe(201);
  return { h, personId: p.body?.personId as string };
}
async function athlete(label: string) {
  const u = await person(label);
  const a = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    {
      personId: u.personId,
      slug: uniqueSlug(label),
      profile: { displayName: `Athlete ${label}`, profileVisibility: 'PUBLIC' },
    },
  );
  expect(a.status, a.text).toBe(201);
  return { ...u, athleteId: a.body?.athleteId as string };
}

const tag = newId().replace(/-/g, '').slice(-8);
const v: Record<string, string> = {};
let owner: Awaited<ReturnType<typeof person>>;
let comp = { id: '', slug: '' };

beforeAll(async () => {
  const identity = new IdentityStore(db);
  const op = (await newTestAccount(identity, { withPerson: false, label: 'operator' })).accountId;
  const report = await new CatalogStore(operator).provision({
    operatorAccountId: op,
    manifest: {
      sports: [
        {
          code: `w${tag}`,
          name: '05C API sport',
          disciplines: [{ code: `w${tag}.pool`, name: 'Pool', specs: [SWIMMING_POOL_V2] }],
        },
      ],
      formats: [
        {
          code: `heats-${tag}`,
          name: 'Heats',
          versions: [{ engineId: 'heats-final', engineVersion: 1 }],
        },
      ],
      rulesets: RULESET_TEMPLATES.filter((t) =>
        ['swim-hundredths', 'sets-bo3-tiebreak'].includes(t.code),
      ).map((t) => ({
        code: `q${tag}-${t.code}`,
        name: t.name,
        versions: [{ spec: t.spec, basis: t.basis }],
      })),
    },
    classificationTemplates: CLASSIFICATION_TEMPLATES.filter((t) =>
      ['swim_time', 'fip_groups'].includes(t.code),
    ).map((t) => ({
      code: `u${tag}_${t.code}`,
      name: t.name,
      versions: [{ spec: t.spec, basis: t.basis }],
    })),
  });
  expect(report.conflicts).toEqual([]);
  const listed = await new CompetitionReader(db).catalog();
  for (const d of listed.disciplineVersions)
    if (d.discipline.code === `w${tag}.pool`) v['pool'] = d.disciplineVersionId;
  for (const f of listed.formatVersions)
    if (f.format.code === `heats-${tag}`) v['heats'] = f.formatVersionId;
  for (const r of listed.rulesetVersions)
    if (r.code.startsWith(`q${tag}-`)) v[r.code.slice(`q${tag}-`.length)] = r.versionId;
  for (const t of listed.classificationTemplateVersions)
    if (t.code.startsWith(`u${tag}_`)) v[t.code.slice(`u${tag}_`.length)] = t.versionId;
  const pool = listed.disciplineVersions.find((d) => d.disciplineVersionId === v['pool']);
  expect(pool?.compatibleRulesetVersionIds).toContain(v['swim-hundredths']);
  expect(pool?.compatibleRulesetVersionIds).not.toContain(v['sets-bo3-tiebreak']);

  owner = await person('o5c-owner');
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...owner.h, ...idem() },
    { orgType: 'CLUB', slug: uniqueSlug('o5c'), profile: { displayName: 'ONCF-05C club' } },
  );
  const slug = uniqueSlug('meet');
  const c = await call(
    'POST',
    '/v1/competitions',
    { ...owner.h, ...idem() },
    {
      organizerOrganizationId: org.body?.organizationId,
      slug,
      profile: { name: 'ONCF-05C Meet', timezone: 'America/Costa_Rica' },
    },
  );
  comp = { id: c.body?.competitionId as string, slug };
  expect((await call('POST', `/v1/competitions/${comp.id}/publish`, owner.h)).status).toBe(200);
  expect((await call('POST', `/v1/competitions/${comp.id}/activate`, owner.h)).status).toBe(200);
}, 240_000);

describe('scoring over the API (COMP_STAFF only)', () => {
  it('pins, validates and classifies; refuses strangers, incompatible versions and late changes', async () => {
    const ev = await call(
      'POST',
      `/v1/competitions/${comp.id}/events`,
      { ...owner.h, ...idem() },
      {
        slug: 'free-50',
        disciplineVersionId: v['pool'],
        formatVersionId: v['heats'],
        formatConfig: { qualifyByTime: 8 },
        settings: { name: '50 free', category: { genderCategory: 'OPEN' } },
      },
    );
    expect(ev.status, ev.text).toBe(201);
    const eventId = ev.body?.eventId as string;
    const stranger = await person('stranger');
    const pin = (h: Record<string, string>, body: unknown) =>
      call('PUT', `/v1/events/${eventId}/scoring`, { ...h, ...idem() }, body);
    expect((await pin(stranger.h, { rulesetVersionId: v['swim-hundredths'] })).status).toBe(403);
    expect((await pin(owner.h, { rulesetVersionId: v['sets-bo3-tiebreak'] })).status).toBe(400);
    expect(
      (
        await pin(owner.h, {
          rulesetVersionId: v['swim-hundredths'],
          classificationTemplateVersionId: v['fip_groups'],
        })
      ).status,
    ).toBe(400);
    const ok = await pin(owner.h, {
      rulesetVersionId: v['swim-hundredths'],
      classificationTemplateVersionId: v['swim_time'],
    });
    expect(ok.status, ok.text).toBe(200);
    const read = await call('GET', `/v1/events/${eventId}/scoring`, owner.h);
    expect(read.body).toMatchObject({
      pinned: true,
      frozen: false,
      ruleset: { family: 'ELAPSED_TIME' },
      classificationTemplate: { family: 'METRIC' },
    });
    expect((await call('GET', `/v1/events/${eventId}/scoring`, stranger.h)).status).toBe(403);

    expect((await call('POST', `/v1/events/${eventId}/open-registration`, owner.h)).status).toBe(
      200,
    );
    for (let i = 0; i < 10; i++) {
      const a = await athlete(`sw${i}`);
      expect(
        (
          await call(
            'POST',
            `/v1/events/${eventId}/registrations`,
            { ...a.h, ...idem() },
            { athleteId: a.athleteId, eligibilityDeclared: true },
          )
        ).status,
      ).toBe(201);
    }
    expect((await call('POST', `/v1/events/${eventId}/close-registration`, owner.h)).status).toBe(
      200,
    );
    expect(
      (await call('POST', `/v1/events/${eventId}/lock-field`, { ...owner.h, ...idem() })).status,
    ).toBe(200);
    expect((await pin(owner.h, { rulesetVersionId: v['swim-hundredths'] })).status).toBe(409);
    expect(
      (
        await call(
          'POST',
          `/v1/events/${eventId}/seed`,
          { ...owner.h, ...idem() },
          { method: 'DETERMINISTIC_DRAW' },
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('POST', `/v1/events/${eventId}/generate-plan`, { ...owner.h, ...idem() })).status,
    ).toBe(200);
    const ready = await call('GET', `/v1/events/${eventId}/readiness`, owner.h);
    expect(ready.body?.stageList?.map((s: Json) => s.key)).toEqual(['s1', 's2']);

    const bracket = await call('GET', `/v1/competitions/${comp.slug}/events/free-50/bracket`);
    const heat = bracket.body?.rounds.find((r: Json) => r.roundType === 'HEAT')?.contests[0];
    const lanes = heat.slots.map((s: Json) => s.participantId);
    const sheet = {
      family: 'ELAPSED_TIME',
      entries: lanes.map((participantId: string, i: number) => ({
        participantId,
        status: 'FINISHED',
        timeMs: 26_000 + i * 120,
      })),
    };
    const valid = await call(
      'POST',
      `/v1/contests/${heat.contestId}/score-sheets/validate`,
      owner.h,
      { sheet },
    );
    expect(valid.status, valid.text).toBe(200);
    expect(valid.body).toMatchObject({ ok: true, contentHash: expect.stringMatching(/^sha256:/) });
    const invalid = await call(
      'POST',
      `/v1/contests/${heat.contestId}/score-sheets/validate`,
      owner.h,
      {
        sheet: { ...sheet, entries: sheet.entries.map((e: Json) => ({ ...e, timeMs: -1 })) },
      },
    );
    expect(invalid.body).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'TIME_REQUIRED' })]),
    });
    expect(
      (
        await call('POST', `/v1/contests/${heat.contestId}/score-sheets/validate`, stranger.h, {
          sheet,
        })
      ).status,
    ).toBe(403);

    // No result is submitted yet: the classification is a pending proposal, never a fabricated order.
    const cls = await call('GET', `/v1/events/${eventId}/stages/s1/classification`, owner.h);
    expect(cls.status, cls.text).toBe(200);
    expect(cls.body?.document.complete).toBe(false);
    expect(cls.body?.document.entries.every((e: Json) => e.status === 'PENDING')).toBe(true);
    expect(
      (await call('GET', `/v1/events/${eventId}/stages/s1/classification`, stranger.h)).status,
    ).toBe(403);
  }, 300_000);
});
