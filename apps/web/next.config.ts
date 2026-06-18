import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@trihards/core", "@trihards/db"],
};

export default nextConfig;
