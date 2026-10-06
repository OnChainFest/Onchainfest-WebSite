import { newId } from '@br/domain';
import { ROLE_PERMISSIONS } from '@br/identity';
import type { IdentityStore } from '@br/persistence';
import { apiDb, uniqueSlug } from '@br/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

// ONCF-02: organization administration on the canonical organization / membership / invitation /
// permission model. Every boundary below is enforced by the API, not by the web UI.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;

const SECRET = 'oncf02-org-admin-int-secret-0123456789abcdefghij';
const db = apiDb();
const app = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
});
afterAll(async () => {
  await app.close();
  await db.destroy();
});

const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const auth = (subject: string) => ({
  authorization: `Bearer ${mintDevToken(subject, { secret: SECRET })}`,
});

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

async function athlete(label: string, profileVisibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const u = await person(label);
  const slug = uniqueSlug(label);
  const r = await call(
    'POST',
    '/v1/athletes',
    { ...u.h, ...idem() },
    { personId: u.personId, slug, profile: { displayName: `Athlete ${label}`, profileVisibility } },
  );
  expect(r.status).toBe(201);
  return { ...u, slug };
}

async function organization() {
  const owner = await person('owner');
  const slug = uniqueSlug('club');
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...owner.h, ...idem() },
    { orgType: 'CLUB', slug, profile: { displayName: 'ONCF Admin Club' } },
  );
  expect(org.status).toBe(201);
  return { owner, slug, id: org.body?.organizationId as string };
}

async function invite(
  org: { id: string },
  by: Record<string, string>,
  body: Record<string, unknown>,
) {
  return call(
    'POST',
    `/v1/organizations/${org.id}/invitations`,
    { ...by, ...idem() },
    {
      role: 'ATHLETE',
      visibility: 'PUBLIC',
      ...body,
    },
  );
}

/** An athlete invited by profile address who accepts. */
async function memberOf(org: { id: string; owner: { h: Record<string, string> } }, label: string) {
  const a = await athlete(label);
  const inv = await invite(org, org.owner.h, { athleteSlug: a.slug });
  expect(inv.status).toBe(201);
  const ok = await call('POST', '/v1/invitations/accept', a.h, { token: inv.body?.token });
  expect(ok.status).toBe(200);
  return a;
}

describe('canonical roles and permissions', () => {
  it('GET /v1/organization-roles mirrors ROLE_PERMISSIONS exactly (no invented names)', async () => {
    const r = await call('GET', '/v1/organization-roles');
    expect(r.status).toBe(200);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(r.body?.roles).toContainEqual({ role, permissions: [...perms].sort() });
    }
    expect(r.body?.roles).toHaveLength(Object.keys(ROLE_PERMISSIONS).length);
  });
});

describe('organization creation and access', () => {
  it('the creator is OWNER with every permission; the org appears in their account', async () => {
    const org = await organization();
    const perms = await call('GET', `/v1/organizations/${org.id}/permissions`, org.owner.h);
    expect(perms.body?.roles).toEqual(['OWNER']);
    expect(perms.body?.permissions).toEqual([...ROLE_PERMISSIONS.OWNER].sort());
    const mine = await call('GET', '/v1/me/organizations', org.owner.h);
    expect(mine.body?.items).toEqual([expect.objectContaining({ slug: org.slug, role: 'OWNER' })]);
  });

  it('a stranger has no roles and cannot read the roster', async () => {
    const org = await organization();
    const stranger = await person('stranger');
    const perms = await call('GET', `/v1/organizations/${org.id}/permissions`, stranger.h);
    expect(perms.body).toEqual({ roles: [], permissions: [] });
    expect((await call('GET', `/v1/organizations/${org.id}/members`, stranger.h)).status).toBe(403);
  });
});

describe('organization profile and branding', () => {
  it('an admin updates branding; the public page serves it', async () => {
    const org = await organization();
    const patch = {
      description: 'Padel and tennis since 2026.',
      website: 'https://club.example',
      publicContact: 'hola@club.example',
      logoUrl: 'https://cdn.example/logo.png',
      accentColor: '#ff2da4',
      sports: ['Padel', 'Tennis'],
    };
    const r = await call('PATCH', `/v1/organizations/${org.id}/profile`, org.owner.h, patch);
    expect(r.status).toBe(200);
    const pub = await call('GET', `/v1/organizations/${org.slug}`);
    expect(pub.body?.organization.profile).toMatchObject(patch);
  });

  it.each([
    ['logoUrl', 'http://insecure.example/logo.png'],
    ['logoUrl', 'javascript:alert(1)'],
    ['accentColor', 'red'],
    ['accentColor', '#FF2DA4'],
    ['sports', ['Padel', 'padel']],
  ])('rejects invalid %s %j', async (field, value) => {
    const org = await organization();
    const r = await call('PATCH', `/v1/organizations/${org.id}/profile`, org.owner.h, {
      [field]: value,
    });
    expect(r.status).toBe(400);
  });

  it('an ordinary member and a stranger cannot modify the profile or the page address', async () => {
    const org = await organization();
    const member = await memberOf(org, 'plainmember');
    const stranger = await person('stranger2');
    for (const h of [member.h, stranger.h]) {
      expect(
        (await call('PATCH', `/v1/organizations/${org.id}/profile`, h, { displayName: 'Hijack' }))
          .status,
      ).toBe(403);
      expect(
        (await call('PUT', `/v1/organizations/${org.id}/slug`, h, { slug: uniqueSlug('x') }))
          .status,
      ).toBe(403);
    }
    const pub = await call('GET', `/v1/organizations/${org.slug}`);
    expect(pub.body?.organization.profile.displayName).toBe('ONCF Admin Club');
  });

  it('changing the page address keeps the old one redirecting', async () => {
    const org = await organization();
    const next = uniqueSlug('renamed');
    const r = await call('PUT', `/v1/organizations/${org.id}/slug`, org.owner.h, { slug: next });
    expect(r.body).toEqual({ slug: next });
    const old = await call('GET', `/v1/organizations/${org.slug}`);
    expect(old.body?.canonicalSlug).toBe(next);
    expect(old.body?.redirected).toBe(true);
  });
});

describe('invitations (existing token flow)', () => {
  it('invite by athlete address → preview → accept → membership in the invitee account', async () => {
    const org = await organization();
    const a = await athlete('invitee');
    const inv = await invite(org, org.owner.h, { athleteSlug: a.slug });
    expect(inv.status).toBe(201);
    expect(inv.body?.token).toEqual(expect.any(String));

    const preview = await call('POST', '/v1/invitations/inspect', a.h, { token: inv.body?.token });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      role: 'ATHLETE',
      organization: { slug: org.slug, displayName: 'ONCF Admin Club', orgType: 'CLUB' },
    });

    const ok = await call('POST', '/v1/invitations/accept', a.h, { token: inv.body?.token });
    expect(ok.body).toMatchObject({ status: 'ACTIVE' });
    const mine = await call('GET', '/v1/me/organizations', a.h);
    expect(mine.body?.items).toEqual([
      expect.objectContaining({ slug: org.slug, role: 'ATHLETE' }),
    ]);
    // Used tokens can no longer be previewed.
    expect(
      (await call('POST', '/v1/invitations/inspect', a.h, { token: inv.body?.token })).status,
    ).toBe(422);
  });

  it('decline ends the invitation without a membership', async () => {
    const org = await organization();
    const a = await athlete('decliner');
    const inv = await invite(org, org.owner.h, { athleteSlug: a.slug });
    const no = await call('POST', '/v1/invitations/decline', a.h, { token: inv.body?.token });
    expect(no.body).toMatchObject({ status: 'DECLINED' });
    expect((await call('GET', '/v1/me/organizations', a.h)).body?.items).toEqual([]);
  });

  it('only the invitee can preview or answer; others get the same invalid answer', async () => {
    const org = await organization();
    const a = await athlete('target');
    const other = await person('interloper');
    const inv = await invite(org, org.owner.h, { athleteSlug: a.slug });
    const token = inv.body?.token as string;
    const foreign = await call('POST', '/v1/invitations/inspect', other.h, { token });
    const unknown = await call('POST', '/v1/invitations/inspect', other.h, {
      token: 'x'.repeat(43),
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body).toEqual(unknown.body);
    expect((await call('POST', '/v1/invitations/accept', other.h, { token })).status).not.toBe(200);
  });

  it('a revoked (ended) invitation cannot be accepted', async () => {
    const org = await organization();
    const a = await athlete('revoked');
    const inv = await invite(org, org.owner.h, { athleteSlug: a.slug });
    const revoke = await call(
      'PUT',
      `/v1/memberships/${inv.body?.membershipId}/status`,
      org.owner.h,
      { status: 'ENDED' },
    );
    expect(revoke.status).toBe(200);
    expect(
      (await call('POST', '/v1/invitations/accept', a.h, { token: inv.body?.token })).status,
    ).toBe(422);
  });

  it('members without ORG_INVITE_MEMBER cannot invite, and the address lookup is no oracle', async () => {
    const org = await organization();
    const member = await memberOf(org, 'noinvite');
    const target = await athlete('target2');
    const known = await invite(org, member.h, { athleteSlug: target.slug });
    const unknownSlug = await invite(org, member.h, { athleteSlug: uniqueSlug('nobody') });
    expect(known.status).toBe(403);
    expect(unknownSlug.status).toBe(403);
  });

  it('private athlete profiles and unknown addresses do not resolve', async () => {
    const org = await organization();
    const hidden = await athlete('hidden', 'PRIVATE');
    expect((await invite(org, org.owner.h, { athleteSlug: hidden.slug })).status).toBe(404);
    expect((await invite(org, org.owner.h, { athleteSlug: uniqueSlug('none') })).status).toBe(404);
    expect((await invite(org, org.owner.h, {})).status).toBe(400);
  });
});

describe('members, roles and data boundaries', () => {
  it('the roster names members only through public athlete profiles — no PII', async () => {
    const org = await organization();
    const visible = await memberOf(org, 'visible');
    const roster = await call('GET', `/v1/organizations/${org.id}/members`, org.owner.h);
    expect(roster.status).toBe(200);
    const row = (roster.body?.items as Json[]).find((m) => m.personId === visible.personId);
    expect(row).toMatchObject({
      role: 'ATHLETE',
      status: 'ACTIVE',
      athlete: { slug: visible.slug, displayName: 'Athlete visible' },
      invitationExpiresAt: null,
    });
    const owner = (roster.body?.items as Json[]).find((m) => m.role === 'OWNER');
    expect(owner?.athlete).toBeNull();
    for (const k of ['email', 'legalName', 'dateOfBirth', 'phone'])
      expect(roster.text).not.toContain(k);
  });

  it('pending invitations are visible to admins (with expiry) but not to plain members', async () => {
    const org = await organization();
    const member = await memberOf(org, 'viewer');
    const pending = await athlete('pending');
    await invite(org, org.owner.h, { athleteSlug: pending.slug });
    const adminView = await call('GET', `/v1/organizations/${org.id}/members`, org.owner.h);
    const invited = (adminView.body?.items as Json[]).filter((m) => m.status === 'INVITED');
    expect(invited).toHaveLength(1);
    expect(invited[0]?.invitationExpiresAt).toEqual(expect.any(String));
    const memberView = await call('GET', `/v1/organizations/${org.id}/members`, member.h);
    expect((memberView.body?.items as Json[]).some((m) => m.status === 'INVITED')).toBe(false);
  });

  it('role changes need ORG_MANAGE_ROLES; only an OWNER can grant OWNER', async () => {
    const org = await organization();
    const m1 = await memberOf(org, 'promote');
    const m2 = await memberOf(org, 'peer');
    const roster = await call('GET', `/v1/organizations/${org.id}/members`, org.owner.h);
    const idOf = (personId: string) =>
      (roster.body?.items as Json[]).find((m) => m.personId === personId)?.membershipId as string;

    // A plain member cannot change anyone's role.
    expect(
      (
        await call(
          'POST',
          `/v1/memberships/${idOf(m2.personId)}/role`,
          { ...m1.h, ...idem() },
          {
            role: 'ADMIN',
          },
        )
      ).status,
    ).toBe(403);
    // The owner promotes m1 to ADMIN.
    const promoted = await call(
      'POST',
      `/v1/memberships/${idOf(m1.personId)}/role`,
      { ...org.owner.h, ...idem() },
      { role: 'ADMIN' },
    );
    expect(promoted.status).toBe(200);
    // An ADMIN still cannot make someone OWNER.
    expect(
      (
        await call(
          'POST',
          `/v1/memberships/${idOf(m2.personId)}/role`,
          { ...m1.h, ...idem() },
          {
            role: 'OWNER',
          },
        )
      ).status,
    ).toBe(403);
  });

  it('plain members cannot suspend or remove others, but can leave', async () => {
    const org = await organization();
    const m1 = await memberOf(org, 'leaver');
    const m2 = await memberOf(org, 'other');
    const roster = await call('GET', `/v1/organizations/${org.id}/members`, org.owner.h);
    const idOf = (personId: string) =>
      (roster.body?.items as Json[]).find((m) => m.personId === personId)?.membershipId as string;
    expect(
      (
        await call('PUT', `/v1/memberships/${idOf(m2.personId)}/status`, m1.h, {
          status: 'SUSPENDED',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('PUT', `/v1/memberships/${idOf(m1.personId)}/status`, m1.h, { status: 'ENDED' }))
        .status,
    ).toBe(200);
    expect((await call('GET', '/v1/me/organizations', m1.h)).body?.items).toEqual([]);
  });

  it('the last owner cannot be removed', async () => {
    const org = await organization();
    const roster = await call('GET', `/v1/organizations/${org.id}/members`, org.owner.h);
    const ownerId = (roster.body?.items as Json[]).find((m) => m.role === 'OWNER')
      ?.membershipId as string;
    expect(
      (await call('PUT', `/v1/memberships/${ownerId}/status`, org.owner.h, { status: 'ENDED' }))
        .status,
    ).toBe(409);
  });
});

describe('public organization data', () => {
  it('serves only public profile data and published competitions', async () => {
    const org = await organization();
    await memberOf(org, 'publicmember');
    const pub = await call('GET', `/v1/organizations/${org.slug}`);
    expect(pub.status).toBe(200);
    expect(Object.keys(pub.body?.organization.profile).sort()).toEqual(
      [
        'accentColor',
        'country',
        'description',
        'displayName',
        'logoUrl',
        'provenance',
        'publicContact',
        'region',
        'sports',
        'website',
      ].sort(),
    );
    expect(pub.text).not.toContain('personId');
    expect(pub.text).not.toContain('membershipId');
    const comps = await call('GET', `/v1/organizations/${org.slug}/competitions`);
    expect(comps.body).toEqual({ items: [] });
    expect(
      (await call('GET', `/v1/organizations/${uniqueSlug('ghost')}/competitions`)).status,
    ).toBe(404);
  });
});
