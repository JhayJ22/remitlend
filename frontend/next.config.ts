import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./i18n.config.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
});

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    // Serve modern formats automatically (WebP, then AVIF for further savings)
    formats: ["image/avif", "image/webp"],
    // Common responsive breakpoints covering mobile → 4 K displays
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    // Icon / thumbnail sizes used in the app
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // Remote patterns: allow the OG image host and the Stellar Horizon CDN
    remotePatterns: [
      {
        // Allow images served from the same configured app URL (e.g. Vercel preview URLs)
        protocol: "https",
        hostname: "remitlend.com",
      },
      {
        // Stellar Expert uses this host for account/asset icons
        protocol: "https",
        hostname: "**.stellar.expert",
      },
    ],
    // Minimum cache TTL for optimized images: 7 days
    minimumCacheTTL: 60 * 60 * 24 * 7,
  },
};

const config = withSerwist(nextConfig);

export default withNextIntl(
  withSentryConfig(config, {
    silent: !process.env.CI,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    sourcemaps: {
      disable: !process.env.SENTRY_AUTH_TOKEN,
    },
    autoInstrumentServerFunctions: true,
  }),
);
