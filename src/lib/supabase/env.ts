const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseEnv = Boolean(url && anonKey);

export function getSupabaseEnv() {
  if (!url || !anonKey) throw new Error("Supabase is not configured for OnChainFest yet.");
  return { url, anonKey };
}
