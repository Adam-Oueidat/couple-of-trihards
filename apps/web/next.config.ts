import type { NextConfig } from "next";

// Defense-in-depth response headers applied to every route. We deliberately
// scope CSP to frame-ancestors (clickjacking) here rather than a full
// script-src policy, which would require nonce-wiring around Next's inline
// hydration scripts and the inline theme script in layout.tsx.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@trihards/core", "@trihards/db"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
