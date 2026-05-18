// Service worker stub — enables installable PWA. v0.1 has no offline
// caching (the whole app is 3 files); future versions will add
// cache-first for the static assets.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch. No offline mode yet; the user needs network to
// reach their HA instance anyway, so caching the shell doesn't buy
// much. Add when we want PWA install criteria to flag this as a
// "real" PWA (cached shell is one of the install-prompt heuristics
// on Chrome).
self.addEventListener("fetch", (event) => {
  // No-op — let the browser handle it normally.
});
