import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { routeAccess, signInRedirectPath } from './route-policy';
import { readSupabaseWebEnv } from './supabase-env';

/**
 * Session refresh + protected-route gate for `/app/**` (PMFreak proxy pattern, ADR-0052).
 *
 * - The session is verified with `getClaims()` (JWT signature checked against the project JWKS).
 *   Any error — including an unreachable Supabase — is treated as signed out: there is no fallback
 *   to an unverified cookie session.
 * - Refreshed auth cookies (and Supabase's cache headers) are copied onto redirects, so a rotated
 *   refresh token is never lost ("Invalid Refresh Token: Already Used").
 * - Missing Supabase configuration fails closed.
 */
export async function gateRequest(request: NextRequest): Promise<NextResponse> {
  if (routeAccess(request.nextUrl.pathname) !== 'protected') return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const env = readSupabaseWebEnv();
  let authenticated = false;
  if (env !== null) {
    const supabase = createServerClient(env.url, env.anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet)
            response.cookies.set(name, value, options);
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    });
    try {
      const { data, error } = await supabase.auth.getClaims();
      const claims = data?.claims;
      authenticated =
        error === null &&
        claims !== undefined &&
        claims.role === 'authenticated' &&
        claims.is_anonymous !== true;
    } catch {
      authenticated = false;
    }
  }
  if (authenticated) return response;

  const target = new URL(
    signInRedirectPath(request.nextUrl.pathname, request.nextUrl.search),
    request.url,
  );
  const redirect = NextResponse.redirect(target);
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  for (const key of ['cache-control', 'expires', 'pragma']) {
    const value = response.headers.get(key);
    if (value !== null) redirect.headers.set(key, value);
  }
  return redirect;
}
