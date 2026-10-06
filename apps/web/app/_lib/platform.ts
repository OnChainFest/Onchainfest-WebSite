import { API_BASE } from './api';
import type { OnboardingFacts } from './auth/onboarding';

/**
 * Platform API client for authenticated server code (ONCF-01, ADR-0052). Identity, persons,
 * athletes, organizations and memberships come only from the API, which verifies the forwarded
 * Supabase access token. Nothing here decides permissions.
 */
export interface MeResponse {
  accountId: string;
  accountActive: boolean;
  selfPersonId: string | null;
  athletes: { athleteId: string; personId: string; slug: string }[];
  guardianRelationships: { id: string; dependentPersonId: string; status: string }[];
}

export interface MyOrganization {
  membershipId: string;
  organizationId: string;
  role: string;
  orgType: string;
  slug: string;
  displayName: string;
}

export type ApiResult<T> =
  | { kind: 'ok'; status: number; data: T }
  | { kind: 'error'; status: number; code: string | null }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' };

export async function apiRequest<T>(
  token: string,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      cache: 'no-store',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (res.status === 401) return { kind: 'unauthenticated' };
  if (res.status >= 500) return { kind: 'unavailable' };
  if (!res.ok) {
    let code: string | null;
    try {
      const body = (await res.json()) as { error?: { code?: unknown } };
      code = typeof body.error?.code === 'string' ? body.error.code : null;
    } catch {
      code = null;
    }
    return { kind: 'error', status: res.status, code };
  }
  try {
    return { kind: 'ok', status: res.status, data: (await res.json()) as T };
  } catch {
    return { kind: 'unavailable' };
  }
}

export interface AccountState {
  readonly me: MeResponse;
  readonly organizations: MyOrganization[];
  readonly facts: OnboardingFacts;
}

export type AccountStateResult =
  { kind: 'ok'; state: AccountState } | { kind: 'unauthenticated' } | { kind: 'unavailable' };

/** Onboarding facts and navigation data, derived from platform rows only. */
export async function loadAccountState(token: string): Promise<AccountStateResult> {
  const [me, orgs] = await Promise.all([
    apiRequest<MeResponse>(token, 'GET', '/v1/me'),
    apiRequest<{ items: MyOrganization[] }>(token, 'GET', '/v1/me/organizations'),
  ]);
  if (me.kind === 'unauthenticated' || orgs.kind === 'unauthenticated')
    return { kind: 'unauthenticated' };
  if (me.kind !== 'ok' || orgs.kind !== 'ok') return { kind: 'unavailable' };
  return {
    kind: 'ok',
    state: {
      me: me.data,
      organizations: orgs.data.items,
      facts: {
        selfPersonId: me.data.selfPersonId,
        athleteCount: me.data.athletes.length,
        membershipCount: orgs.data.items.length,
      },
    },
  };
}
