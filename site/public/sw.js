/* IELTS Workspace service worker。
 *
 * 策略（v2）：
 *   - 导航请求与 /content/index.json → 网络优先，离线回缓存。
 *     （这两类是"版本入口"：若缓存优先，老用户会一直停留在旧壳/旧索引上，
 *       新版部署后永远看不到——v1 的 stale-while-revalidate + 预缓存
 *       index.html 就踩了这个坑。）
 *   - /content/** 试卷/转录/音频/图片 → 缓存优先（内容按路径不可变）。
 *   - 其余同源 GET → stale-while-revalidate。
 *   - blob: / data: / 跨域 / Range 请求一律不接管（听力音频的远端兜底
 *     在 github.com，本来也不经过这里）。
 */
const CACHE_NAME = "ielts-workspace-v2";
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

  if (req.mode === "navigate" || url.pathname === "/content/index.json") {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.pathname.startsWith("/content/")) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req, res.clone());
      return res;
    }
  } catch {
    /* 离线，走缓存 */
  }
  const hit = await cache.match(req);
  if (hit) return hit;
  if (req.mode === "navigate") {
    const fallback = await cache.match("/index.html");
    if (fallback) return fallback;
  }
  return Response.error();
}

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
