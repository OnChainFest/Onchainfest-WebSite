/**
 * LAUNCH-02 · Response security headers for apps/web (applied by next.config.ts to every route).
 *
 * The browser talks only to this origin: pages, server actions and the auth flows are same-origin,
 * and Supabase and the platform API are called server-side only. So `connect-src` and `form-action`
 * stay 'self'. Next's App Router inlines its bootstrap scripts, and without per-request nonces that
 * needs `'unsafe-inline'` for scripts. Development also needs `'unsafe-eval'` for React refresh;
 * production never gets it. Organization logos are arbitrary https images (img-src https:).
 */
export function contentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    `connect-src 'self'${production ? '' : ' ws:'}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders(production: boolean): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(production) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ...(production
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
      : []),
  ];
}
