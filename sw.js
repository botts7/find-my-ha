// Service worker — v0.5.6: NETWORK-FIRST for everything.
//
// History:
//   v0.4: cache-first for JS, network-first for HTML.
//   v0.5.2: added controllerchange auto-reload to bust stale clients.
//   v0.5.6: network-first for ALL same-origin GETs. Cache is fallback
//     only — used when network fetch fails (offline). This trades a
//     tiny amount of repeat-load latency for zero stale-JS bugs.
//
// Why the change: cache-first served stale JS even after deploys,
// even on cache-bumped SW versions, because activation timing left
// browser tabs running pre-update code. The "stale JS + fresh HTML"
// combo presented as a blank page below the step bar with no errors.
// Network-first sidesteps the entire class of problems — the page
// gets fresh code every load when online, falls back to cache when
// offline. GitHub Pages is fast; ~50-200 ms latency is acceptable.

const CACHE_VERSION = "find-my-ha-v0.5.6";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./app.js",
  "./ws_client.js",
  "./entity_picker.js",
  "./streamer.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith("find-my-ha-") && n !== CACHE_VERSION)
        .map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;  // HA WS etc. — pass through

  // Network-first for everything. On success, refresh cache. On
  // failure, fall back to cache so PWA still works offline.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: "no-cache" });
      const copy = fresh.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      return fresh;
    } catch (_) {
      const cached = await caches.match(req);
      if (cached) return cached;
      // For navigations, fall back to cached index.html.
      if (req.mode === "navigate") {
        const indexHit = await caches.match("./index.html");
        if (indexHit) return indexHit;
      }
      throw _;
    }
  })());
});
