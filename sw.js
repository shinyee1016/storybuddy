/* StoryBuddy Service Worker — 离线快取 app shell；后端 /api 永远走网络 */
const CACHE = "storybuddy-v1";
const SHELL = [
  "/", "/index.html", "/manifest.json",
  "/icon-192.png", "/icon-512.png", "/apple-touch-icon-180.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;          // 生成请求(POST)直接走网络
  if (url.pathname.startsWith("/api/")) return;     // 后端不缓存

  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    try {
      const res = await fetch(e.request);
      if (res.ok && url.origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    } catch (err) {
      // 离线且未快取：导航请求回退到首页
      if (e.request.mode === "navigate") {
        const home = await caches.match("/index.html");
        if (home) return home;
      }
      return Response.error();
    }
  })());
});
