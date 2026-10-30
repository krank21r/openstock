import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is only used for self-hosting (sandbox/Docker).
  // On Vercel, the platform manages the output — keep the default.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
