/**
 * Public Supabase project configuration for the web app (browser-safe values only). The
 * service-role key is never read by the web app: all privileged work goes through the platform API.
 */
export interface SupabaseWebEnv {
  readonly url: string;
  readonly anonKey: string;
}

export function readSupabaseWebEnv(): SupabaseWebEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') return null;
  return { url, anonKey };
}
