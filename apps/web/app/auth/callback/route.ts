import { createSupabaseServerClient } from '../../_lib/auth/supabase-server';
import {
  failureRedirect,
  linkErrorCode,
  linkFlow,
  providerFailure,
  successRedirect,
} from '../../_lib/auth/link-landing';

/** Email links using the PKCE code flow (sign-up confirmation, password recovery, OAuth). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const flow = linkFlow(url.searchParams.get('flow'));
  const failure = providerFailure(url);
  if (failure !== null) return failureRedirect(request, flow, failure);
  const code = url.searchParams.get('code');
  if (code === null || code === '' || code.length > 512)
    return failureRedirect(request, flow, 'link_invalid');

  const supabase = await createSupabaseServerClient();
  if (supabase === null) return failureRedirect(request, flow, 'not_configured');
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error !== null || data.session === null)
      return failureRedirect(request, flow, linkErrorCode(error));
    return await successRedirect(request, url, flow, data.session.access_token);
  } catch (err) {
    return failureRedirect(request, flow, linkErrorCode(err));
  }
}
