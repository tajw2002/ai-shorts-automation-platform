import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard is a thin client over the API.
 *
 * `standalone` output is what makes the container image small: Next traces the
 * files actually needed and the runtime layer copies only those.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  // The workspace package ships CommonJS; Next needs to transpile it for the
  // server components that import shared types and enums.
  transpilePackages: ['@shorts/contracts'],
  reactStrictMode: true,
  poweredByHeader: false,
  // The monorepo root, so file tracing does not walk out of the workspace.
  outputFileTracingRoot: join(here, '../../'),
  eslint: {
    // Linting is a separate, explicit step (`npm run lint`) rather than something
    // that silently fails a production build.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
