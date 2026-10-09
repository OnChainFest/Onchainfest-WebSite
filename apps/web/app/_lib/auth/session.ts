import { createSupabaseServerClient } from './supabase-server';

/**
 * The current verified session for server code: claims come from getClaims() (signature checked
 * against the project JWKS), never from an unverified cookie read. The access token is what the
 * platform API receives and verifies again.
 */
export interface VerifiedSession {
  readonly accessToken: string;
  readonly claims: { readonly sub: string; readonly email?: string } & Record<string, unknown>;
}

export async function verifiedSession(): Promise<VerifiedSession | null> {
  const supabase = await createSupabaseServerClient();
  if (supabase === null) return null;
  try {
    const { data, error } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (error !== null || claims === undefined) return null;
    if (claims.role !== 'authenticated' || claims.is_anonymous === true) return null;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (accessToken === undefined) return null;
    return { accessToken, claims: claims as VerifiedSession['claims'] };
  } catch {
    return null;
  }
}
