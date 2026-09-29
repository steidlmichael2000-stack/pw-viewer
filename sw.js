/* ═══════════════════════════════════════════════════════════════════════
   SERVICE WORKER — PW-VIEWER

   AUFGABE
   -------
   Nur die Huelle der App (Uebersichtsseite, Icons, Manifest) offline
   halten, damit sich die App installieren laesst und ohne Netz wenigstens
   startet. Die eigentlichen Daten liegen woanders und werden bewusst
   NICHT angefasst:

     - Punktwolken und Modelle kommen vom R2-Bucket (fremde Herkunft,
       faellt schon durch die Origin-Pruefung unten raus),
     - `build/` und `libs/` sind die Potree-Distribution mit rund 50 MB;
       die wuerde der Cache nur unnoetig aufblaehen.

   STRATEGIE
   ---------
   Erst Netz, dann Cache. Eine neue Fassung soll sofort ankommen — das
   passt zu den no-cache-Angaben in den Seiten. Der Cache ist reiner
   Rueckfall fuer den Offline-Start.

   WICHTIG: `caches.delete()` arbeitet origin-weit. Beim Aufraeumen werden
   deshalb nur die eigenen Caches (Praefix `pwviewer-`) angefasst, sonst
   wuerden die Nachbar-Apps auf derselben Domain ihren Bestand verlieren.
   ═══════════════════════════════════════════════════════════════════════ */

const VERSION = 'v3';
const CACHE = `pwviewer-${VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'logo.svg',
  'icon-192.png',
  'icon-512.png'
];

// Schwergewichte und Fremdbestand — hier nicht anfassen.
const BYPASS = ['/pw-viewer/build/', '/pw-viewer/libs/', '/pw-viewer/p/'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Einzeln, damit eine fehlende Datei nicht die ganze Installation kippt.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith('pwviewer-') && key !== CACHE)
          .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (BYPASS.some((prefix) => url.pathname.startsWith(prefix))) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      // Ohne Suchteil ablegen: pointclouds.json?nocache=<Zeit> und view.html?p=…
      // legten sonst bei jedem Aufruf einen neuen Eintrag an.
      if (response && response.ok) cache.put(url.origin + url.pathname, response.clone());
      return response;
    } catch (e) {
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      // Der Start aus der installierten App kommt als "./" herein –
      // beim Nachschlagen die Suchparameter ignorieren.
      if (request.mode === 'navigate') {
        const page = await cache.match('./', { ignoreSearch: true })
          || await cache.match('index.html');
        if (page) return page;
      }
      throw e;
    }
  })());
});
