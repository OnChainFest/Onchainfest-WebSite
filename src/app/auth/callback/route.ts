import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { onboardingRoute, parseAccountType } from "@/lib/auth/account-type";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const hintedType = parseAccountType(url.searchParams.get("type"));

  if (!code) return NextResponse.redirect(new URL("/signin?error=Missing+authentication+code", request.url));

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    const type = parseAccountType(data.user?.user_metadata?.account_type) ?? hintedType ?? "athlete";
    return NextResponse.redirect(new URL(onboardingRoute(type), request.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to complete sign in";
    return NextResponse.redirect(new URL(`/signin?error=${encodeURIComponent(message)}`, request.url));
  }
}
