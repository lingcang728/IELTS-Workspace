/* IELTS Workspace service worker。
 *
 * 策略：
 *   - install 预缓存应用壳（/、index.html、manifest、logo）；
 *   - /content/** 题库 JSON 与图片按发布版本不可变 → 缓存优先；
 *   - 其余同源 GET → stale-while-revalidate（先回缓存，后台刷新）；
 *   - blob: / data: / 跨域 / Range 请求一律不接管（听力音频在 IndexedDB，
 *     走 objectURL，本就不经过这里）；
 *   - 导航请求离线兜底回缓存的 index.html。
 *
 * 发新版时把 CACHE_NAME 里的版本号 +1，activate 会清掉旧缓存。
 */
const CACHE_NAME = "ielts-workspace-v1";
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/logo.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 非同源（含 blob:/data:，它们 origin 为 null 或 "blob:…"）不接管
  if (url.origin !== self.location.origin) return;
  // 大文件分段请求不进缓存
  if (req.headers.has("range")) return;

  if (url.pathname.startsWith("/content/")) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) void cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await fresh;
  if (res) return res;
  if (req.mode === "navigate") {
    const fallback = await cache.match("/index.html");
    if (fallback) return fallback;
  }
  return Response.error();
}
