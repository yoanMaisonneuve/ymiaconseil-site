// sw.js — l'app doit s'ouvrir sur un chantier sans réseau.
//
// Deux rôles :
//   1. garder la coquille de l'app (pages, scripts, pdf.js) pour l'ouvrir hors ligne ;
//   2. recevoir un PDF envoyé par « Partager → Plans » depuis Android, et le remettre à l'app.
//
// Les plans eux-mêmes ne passent jamais par ici vers le réseau : ils vivent dans IndexedDB.

const VERSION = 'plans-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'detect.js', 'extract.js', 'store.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== VERSION && k !== 'plans-partage') await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('plan');
    if (file && file.size) {
      const cache = await caches.open('plans-partage');
      for (const k of await cache.keys()) await cache.delete(k);
      await cache.put(`partage-${Date.now()}`, new Response(file, {
        headers: { 'content-type': 'application/pdf', 'x-nom': encodeURIComponent(file.name || 'plan.pdf') },
      }));
    }
  } catch { /* partage illisible : l'app s'ouvre simplement sur l'accueil */ }
  return Response.redirect('./?partage=1', 303);
}

// Servir le cache tout de suite, rafraîchir en arrière-plan : rapide sur mauvais réseau,
// à jour au lancement suivant.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(VERSION);
  const key = request.mode === 'navigate' ? 'index.html' : request;
  const cached = await cache.match(key, { ignoreSearch: true });
  const fresh = fetch(request).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  if (cached) { fresh.catch(() => {}); return cached; }
  const res = await fresh;
  return res || new Response('Hors ligne, et cette ressource n\'est pas encore en cache.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  if (e.request.method === 'POST' && url.pathname.endsWith('/partage')) { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET') return;
  e.respondWith(staleWhileRevalidate(e.request));
});
