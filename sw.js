// Service worker — v0.4: versioned shell cache + auto-update.
//
// Strategy:
//   - Install: precache the static shell so the PWA loads offline / fast.
//   - Activate: claim all clients + delete old version caches so the next
//     reload picks up the new files without manual hard-refresh.
//   - Fetch: network-first for HTML (always fresh control flow), cache-
//     first for JS/CSS/icons (matches what was precached).
//
// Bump CACHE_VERSION on every deploy that changes shipped files. The
// `update()` call in app.js triggers the SW to recheck this script on
// each page load — when the bytes differ, browsers install the new SW
// and fire `activate` (where we drop the old cache).

const CACHE_VERSION = "find-my-ha-v0.5";
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
  // Only intercept same-origin (PWA shell). Let third-party requests
  // (HA WebSocket goes through wss:// anyway) hit the network directly.
  if (url.origin !== location.origin) return;

  const isHtml = req.mode === "navigate"
    || (req.headers.get("accept") || "").includes("text/html");

  if (isHtml) {
    // Network-first for navigations so a deploy is visible instantly.
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./index.html"))),
    );
    return;
  }

  // Cache-first for JS/CSS/icons.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return resp;
      });
    }),
  );
});
