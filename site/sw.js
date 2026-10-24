// The site's service worker: lets it be installed as an app and keeps games you've opened working offline (solo and
// one-phone play; online play needs the network anyway). Registered by every page (scripts/build.mjs adds it).
//   Pages and other files: the network first, so you always get the newest site; this copy only when offline.
//   Versioned files (?v=hash, stamped by the build): this copy first, since a name never changes its content; only
//   their newest version is kept.
//   Other sites (Firebase, the game server): never touched.
const CACHE = "reclaude-2"; // a new name drops every older copy on the next visit

// Kept from the start: the home page (the app's start), the games page, the manifest and icons. The page that registered this
// worker loaded before it was there, so it's fetched again and kept too (and any other open tab of the site).
const CORE = ["./", "games/", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(CORE.map((u) => cache.add(new URL(u, self.registration.scope)).catch(() => {})));
  await self.skipWaiting();
})()));
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
  const cache = await caches.open(CACHE);
  for (const c of await self.clients.matchAll({ type: "window" })) {
    const u = new URL(c.url);
    if (u.origin === location.origin) await cache.add(u.origin + u.pathname).catch(() => {});
  }
})()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const versioned = url.searchParams.has("v");
    if (versioned) { const hit = await cache.match(req); if (hit) return hit; }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        if (versioned) for (const old of await cache.keys()) { const o = new URL(old.url); if (o.pathname === url.pathname && o.search !== url.search) cache.delete(old); }
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // Offline: the page as last seen (a shared link's ?room=… opens the same page).
      const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
      if (hit) return hit;
      throw err;
    }
  })());
});
