/**
 * Route policy for the web app (ADR-0052). `/app/**` is the authenticated application surface and
 * is protected by default: there is no per-page opt-out. Auth screens are public. Every other route
 * is the existing public read surface (passport, organizations, competitions, rankings, …).
 * The marketing site is a separate deployment and never routes through here.
 */
export type RouteAccess = 'protected' | 'auth' | 'public';

export const APP_PREFIX = '/app';
export const SIGN_IN_PATH = '/signin';
const AUTH_PREFIXES = ['/signin', '/signup', '/auth'] as const;

const hasPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export function routeAccess(pathname: string): RouteAccess {
  if (hasPrefix(pathname, APP_PREFIX)) return 'protected';
  if (AUTH_PREFIXES.some((p) => hasPrefix(pathname, p))) return 'auth';
  return 'public';
}

/** `/signin?next=<path>` for an unauthenticated request to a protected route. */
export function signInRedirectPath(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  return `${SIGN_IN_PATH}?${new URLSearchParams({ next }).toString()}`;
}
