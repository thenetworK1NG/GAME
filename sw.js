/**
 * Offline shell for Plushie Walk.
 *
 * Strategy is cache-first for our own assets and stale-while-revalidate for the
 * Three.js CDN modules. That split matters:
 *   - game code changing under a stale cache is confusing, and the files are
 *     small, so serve them from cache and refresh in the background.
 *   - The CDN modules are large, cross-origin and version-pinned by URL, so they
 *     can never go stale; serving them cache-first means an offline launch still
 *     starts the game rather than hanging on a failed fetch.
 *
 * Bump CACHE_VERSION to invalidate everything on the next load.
 */

const CACHE_VERSION = 'plushie-v1';

// Cross-origin URLs the importmap points at. Requested at install time so the
// first offline launch has them without waiting on a fetch.
const CDN_URLS = [
  'https://unpkg.com/three@0.186.1/build/three.module.js',
  'https://unpkg.com/three@0.186.1/build/three.core.js',
  'https://unpkg.com/three@0.186.1/examples/jsm/loaders/GLTFLoader.js',
];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './js/game.js',
  './js/house.js',
  './js/furniture.js',
  './js/player.js',
  './js/joystick.js',
  './js/sound.js',
  './models/plushie.glb',
  './art/LUB.png',
  './sound/pickup_place.mp3',
  ...CDN_URLS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Individually, so one missing optional file cannot fail the whole
      // install and leave the app with no worker at all.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            // Non-fatal: the runtime fetch handler will pick it up on demand.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept the devtools-driven request for the worker itself, or
  // anything that is plainly not a navigation or asset.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          // Opaque responses (no-cors CDN hits) are cached but not readable; a
          // response we cannot inspect is not worth trusting over the network.
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        // Refresh the entry in the background for the next launch.
        event.waitUntil(network);
        return cached;
      }

      const fresh = await network;
      if (fresh) return fresh;

      // Offline and uncached. For a page navigation, hand back the shell so the
      // app still opens rather than showing the browser's offline error.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline and not cached.', {
        status: 504,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain' },
      });
    })()
  );
});