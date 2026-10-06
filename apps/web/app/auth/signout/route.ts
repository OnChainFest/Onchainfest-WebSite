import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../_lib/auth/supabase-server';

/** Supabase SSR session cookies (possibly chunked: `.0`, `.1`, …) and the PKCE verifier. */
const AUTH_COOKIE = /^sb-[a-z0-9-]+-auth-token(?:-code-verifier)?(?:\.\d+)?$/;

/**
 * Sign-out is POST-only (ONCF-01): link prefetching or a cross-site GET can never end a session.
 * Cross-origin POSTs are refused. The local session is cleared even if Supabase is unreachable.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new NextResponse(null, { status: 403 });
  }
  const supabase = await createSupabaseServerClient();
  if (supabase !== null) {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Supabase unreachable: the auth cookies are still removed below.
    }
  }
  const response = NextResponse.redirect(new URL('/signin?notice=signed_out', request.url), 303);
  for (const { name } of (await cookies()).getAll()) {
    if (AUTH_COOKIE.test(name)) response.cookies.set(name, '', { maxAge: 0, path: '/' });
  }
  response.headers.set('cache-control', 'no-store');
  return response;
}

const methodNotAllowed = () =>
  new NextResponse(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
