const CACHE = 'ledger-pwa-v15';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

// 安裝時預先快取；有舊版在運作時先等待，由頁面提示使用者按「更新」才切換（避免操作到一半被重新整理）
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

/* ---- 每日記帳提醒（Android 安裝版：Periodic Background Sync，由瀏覽器決定實際觸發時間） ---- */
const idb = () => new Promise((ok, bad) => { const r = indexedDB.open('ledger-db'); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
const idbReq = r => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
async function remind() {
  const db = await idb();
  if (!db.objectStoreNames.contains('meta')) return;
  const cfg = await idbReq(db.transaction('meta').objectStore('meta').get('reminder'));
  const d = new Date(), pad = n => String(n).padStart(2, '0'), today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!cfg || !cfg.enabled || `${pad(d.getHours())}:${pad(d.getMinutes())}` < cfg.time || cfg.lastNotified === today) return;
  const entries = await idbReq(db.transaction('entries').objectStore('entries').getAll());
  if (entries.some(x => x.date === today && !x.deleted)) return;
  await self.registration.showNotification('今天還沒記帳', { body: '花 10 秒記下今天的收支吧', icon: './icon-192.png', tag: 'daily-reminder' });
  await idbReq(db.transaction('meta', 'readwrite').objectStore('meta').put({ ...cfg, lastNotified: today }));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'daily-reminder') e.waitUntil(remind().catch(() => {})); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(l => l[0] ? l[0].focus() : self.clients.openWindow('./?add=expense')));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // 只處理同源 GET；Apps Script 同步用的 iframe 等跨網域請求完全不攔截
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    // Stale-while-revalidate：先給快取（秒開、可離線），背景更新給下次用
    const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  })());
});
