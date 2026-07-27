/* PRESSURE — service worker
   Three jobs:
   1. Make the app installable. Chrome and Brave only offer a real PWA install
      (and therefore only use manifest icons) when a service worker with a
      fetch handler is registered. Without this file you get a bookmark
      shortcut with a generic letter icon.
   2. Cache the shell so a cold open paints instantly instead of waiting on
      the network.
   3. Best-effort background refresh via Periodic Background Sync.
*/
const SHELL = 'pressure-shell-v7';
const DATA  = 'pressure-data-v7';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(k => Promise.all(k.filter(n => n !== SHELL && n !== DATA).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Shell: cache first, revalidate in background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(r => {
          if (r && r.ok) caches.open(SHELL).then(c => c.put(req, r.clone()));
          return r;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Feed data: network first, fall back to the last good copy.
  // This is what makes a cold start paint immediately when relays are slow.
  if (/allorigins|codetabs|corsproxy|cors\.lol|r\.jina\.ai|gdeltproject|federalregister|reddit\.com|truthsocial/.test(url.hostname)) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(DATA).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => caches.match(req))
    );
  }
});

// Best-effort background refresh. The browser decides whether and how often
// this actually runs — typically only for installed apps with real usage.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'pressure-refresh') e.waitUntil(warm());
});
self.addEventListener('sync', e => {
  if (e.tag === 'pressure-refresh') e.waitUntil(warm());
});

async function warm() {
  const c = await caches.open(DATA);
  const keys = await c.keys();
  await Promise.allSettled(keys.slice(0, 12).map(async k => {
    try {
      const r = await fetch(k, { cache: 'no-store' });
      if (r && r.ok) await c.put(k, r.clone());
    } catch (_) {}
  }));
}

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
