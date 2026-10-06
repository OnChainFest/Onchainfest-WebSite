import type { NextRequest } from 'next/server';
import { gateRequest } from './app/_lib/auth/proxy-session';

/** Next.js proxy: only the authenticated application surface (`/app/**`) is gated (ADR-0052). */
export function proxy(request: NextRequest) {
  return gateRequest(request);
}

export const config = { matcher: ['/app', '/app/:path*'] };
