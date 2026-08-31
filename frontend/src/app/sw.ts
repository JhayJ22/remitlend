import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry } from "@serwist/precaching";
import { ExpirationPlugin, NetworkFirst, Serwist, type RuntimeCaching } from "serwist";

declare const self: WorkerGlobalScope & {
  __SW_MANIFEST: PrecacheEntry[];
};

/**
 * Cache successful GET responses from our own API with a NetworkFirst strategy:
 * always try the network, fall back to the last good response when offline so
 * dashboards, loan lists and remittance history still render after the first
 * visit. Mutations (POST/PUT/PATCH/DELETE) and streaming endpoints are never
 * cached — those are handled by the in-app offline action queue.
 */
const apiRuntimeCaching: RuntimeCaching[] = [
  {
    matcher: ({ request, url, sameOrigin }) =>
      sameOrigin &&
      request.method === "GET" &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/sse/"),
    handler: new NetworkFirst({
      cacheName: "remitlend-api",
      networkTimeoutSeconds: 5,
      plugins: [
        new ExpirationPlugin({
          maxEntries: 64,
          maxAgeSeconds: 60 * 60 * 24, // 1 day
        }),
      ],
    }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [...apiRuntimeCaching, ...defaultCache],
  bypassCdn: ({ request }: { request: Request }) => {
    if (
      request.url.includes("/api/") ||
      request.url.includes("/sse/") ||
      request.url.includes("/_next/")
    ) {
      return true;
    }
    return false;
  },
} as ConstructorParameters<typeof Serwist>[0] & {
  bypassCdn: (context: { request: Request }) => boolean;
});

serwist.addEventListeners();
