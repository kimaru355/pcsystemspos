import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server for the Docker image (see Dockerfile and docs/deploy.md).
  output: 'standalone',
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // The CSV import posts a file of up to 2 MB, then its text again to confirm (default limit: 1 MB).
    serverActions: { bodySizeLimit: '3mb' },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
