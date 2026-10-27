/* Service worker de Foco: la app abre sin conexión y recibe avisos de recordatorios (Web Push). */
const V = 'foco-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'merge.js', 'gcal.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // la API y Google nunca se cachean
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(V).then(c => c.put('index.html', copy)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  // Primero la red (así siempre corre el código más nuevo); sin conexión, lo guardado.
  e.respondWith(caches.open(V).then(async c => {
    try { const r = await fetch(req); if (r && r.ok) c.put(req, r.clone()); return r; }
    catch (err) { const hit = await c.match(req); if (hit) return hit; throw err; }
  }));
});

/* Aviso de recordatorio. Siempre se muestra (los navegadores lo exigen); si la app está abierta, además se le avisa. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) { d = { title: 'Foco', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    cs.forEach(c => { if (d.id) c.postMessage({ type: 'reminder', id: d.id, r: d.r }); });
    await self.registration.showNotification(String(d.title || 'Foco').slice(0, 120), {
      body: String(d.body || '').slice(0, 200), tag: d.tag || 'foco', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || '/', id: d.id || '' }
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {}, url = new URL(data.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { await c.focus(); if (data.id) c.postMessage({ type: 'open', id: data.id }); return; } }
    await self.clients.openWindow(url);
  })());
});
