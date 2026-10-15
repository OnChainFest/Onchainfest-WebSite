import type { NextConfig } from 'next';
import { securityHeaders } from './app/_lib/security-headers';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // LAUNCH-02: baseline security headers on every route (CSP, anti-framing, HSTS in production).
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders(process.env.NODE_ENV === 'production') }];
  },
};

export default config;
