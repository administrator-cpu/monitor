const apiBase = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000').replace(/\/$/, '');
const wsBase = apiBase.replace(/^http/, 'ws');
const isProd = process.env.NODE_ENV === 'production';

// connect-src is limited to this app and the API origin (TRD section 4.11 / PRD 3).
// script-src keeps 'unsafe-inline' because Next.js emits inline bootstrap scripts;
// nothing on this origin ever renders user-supplied HTML.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${apiBase} ${wsBase}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@cc/shared'],
  async headers() {
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ];
    return [
      {
        source: '/:path*',
        headers: isProd ? [...common, { key: 'Content-Security-Policy', value: csp }] : common,
      },
    ];
  },
};

export default nextConfig;
