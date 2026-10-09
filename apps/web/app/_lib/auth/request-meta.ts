import { createHash } from 'node:crypto';
import { headers } from 'next/headers';

/** Client IP as reported by the platform edge (first X-Forwarded-For hop), for rate limiting only. */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded !== undefined && forwarded !== ''
    ? forwarded
    : (h.get('x-real-ip') ?? 'unknown');
}

/** Rate-limit key material for an email without keeping the address in memory. */
export function emailKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('base64url').slice(0, 22);
}

/**
 * Absolute base URL used in auth emails. It is configuration, never the request Host header
 * (host-header injection would let an attacker point reset links elsewhere). Production requires
 * NEXT_PUBLIC_SITE_URL; development falls back to the local dev server.
 */
export function siteUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured !== undefined && configured !== '') {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  return process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000';
}
