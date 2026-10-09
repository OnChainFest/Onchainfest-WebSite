import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { readSupabaseWebEnv } from './supabase-env';

/**
 * Supabase client for Server Components, Server Actions and Route Handlers (cookie session).
 * Returns null when Supabase is not configured, so callers fail closed instead of throwing.
 * Identity for platform data is NOT taken from this client: the access token is forwarded to the
 * platform API, which verifies it and resolves the platform account (see ../platform.ts and ./session.ts).
 */
export async function createSupabaseServerClient() {
  const env = readSupabaseWebEnv();
  if (env === null) return null;
  const cookieStore = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet)
            cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}
