import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '../../_lib/auth/supabase-server';
import {
  failureRedirect,
  linkErrorCode,
  providerFailure,
  successRedirect,
  type LinkFlow,
} from '../../_lib/auth/link-landing';

/**
 * Email links using a token hash (works when the link is opened in a different browser than the
 * one that started the flow). Supabase email templates link here as
 * `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<signup|recovery|email>`.
 */
const TYPES: Readonly<Record<string, { otp: EmailOtpType; flow: LinkFlow }>> = {
  signup: { otp: 'signup', flow: 'signup' },
  email: { otp: 'email', flow: 'signup' },
  recovery: { otp: 'recovery', flow: 'recovery' },
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const type = TYPES[url.searchParams.get('type') ?? ''];
  const flow = type?.flow ?? 'other';
  const failure = providerFailure(url);
  if (failure !== null) return failureRedirect(request, flow, failure);
  const tokenHash = url.searchParams.get('token_hash');
  if (type === undefined || tokenHash === null || tokenHash === '' || tokenHash.length > 512)
    return failureRedirect(request, flow, 'link_invalid');

  const supabase = await createSupabaseServerClient();
  if (supabase === null) return failureRedirect(request, flow, 'not_configured');
  try {
    const { data, error } = await supabase.auth.verifyOtp({
      type: type.otp,
      token_hash: tokenHash,
    });
    if (error !== null || data.session === null)
      return failureRedirect(request, flow, linkErrorCode(error));
    return await successRedirect(request, url, flow, data.session.access_token);
  } catch (err) {
    return failureRedirect(request, flow, linkErrorCode(err));
  }
}
