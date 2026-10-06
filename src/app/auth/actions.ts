"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { onboardingRoute, parseAccountType, type AccountType } from "@/lib/auth/account-type";
import { isSafeContinuationRoute } from "@/lib/auth/safe-redirect";

function authPath(type: AccountType) {
  return type === "organization" ? "/signup/organization" : "/signup/athlete";
}

export async function signupAction(formData: FormData) {
  const accountType = parseAccountType(formData.get("accountType"));
  if (!accountType) redirect("/signup?error=Choose+an+account+type");

  const fullName = String(formData.get("fullName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const organizationName = String(formData.get("organizationName") ?? "").trim();

  if (!fullName || !email || !password || (accountType === "organization" && !organizationName)) {
    redirect(`${authPath(accountType)}?error=Please+complete+all+required+fields`);
  }

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    redirect(`${authPath(accountType)}?error=Auth+backend+is+not+configured+yet`);
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${siteUrl}/auth/callback?type=${accountType}`,
      data: {
        full_name: fullName,
        account_type: accountType,
        organization_name: accountType === "organization" ? organizationName : null,
      },
    },
  });

  if (error) redirect(`${authPath(accountType)}?error=${encodeURIComponent(error.message)}`);
  if (!data.session) {
    redirect(`/signup/confirm-email?email=${encodeURIComponent(email)}&type=${accountType}`);
  }
  redirect(onboardingRoute(accountType));
}

export async function signinAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const requestedRoute = String(formData.get("next") ?? "").trim() || null;

  if (!email || !password) redirect("/signin?error=Email+and+password+are+required");

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    redirect("/signin?error=Auth+backend+is+not+configured+yet");
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/signin?error=${encodeURIComponent(error.message)}`);

  if (requestedRoute && isSafeContinuationRoute(requestedRoute)) redirect(requestedRoute);

  const type = parseAccountType(data.user?.user_metadata?.account_type) ?? "athlete";
  redirect(onboardingRoute(type));
}
