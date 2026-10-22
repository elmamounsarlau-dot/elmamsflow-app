import type { NextConfig } from 'next';

const security = [
  // Never shown inside another site's frame (stops click-jacking on forms and buttons).
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Links to other sites (17TRACK, Shopify…) never receive our page addresses.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: security }];
  },
};

export default nextConfig;
