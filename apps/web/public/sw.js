/*
 * The offline shell.
 *
 * What this caches, and what it very deliberately does not:
 *
 *   - **The shell** — the HTML document and the hashed JS and CSS Vite emits. These are
 *     immutable by filename, so a cache-first strategy is exactly right and a new deploy
 *     invalidates itself by producing new names.
 *   - **Never `/api`.** Not one response. Every API response is somebody's financial
 *     position, and a cached copy of it would sit in the browser's storage after they signed
 *     out, survive a session revocation, and be served to whoever opened the laptop next.
 *     A stale net worth is also simply wrong in a way a stale stylesheet is not.
 *
 * So this makes the app *launch* without a network. It does not make it *work* without one:
 * with no connection the shell loads and every screen reports that it could not reach the
 * server, which is honest. Genuine offline reads would need an encrypted local store and a
 * sync story, and both are a larger feature than the one this file is.
 *
 * Written as a plain service worker rather than through a build plugin: there are three
 * rules here, and a generated one would be four hundred lines to express the same three.
 */

const CACHE = 'networth-shell-v1';

/** The document itself. Everything else is discovered and cached as it is requested. */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `reload` so an install never picks the shell up out of the HTTP cache, which is how
      // a service worker ends up permanently serving the version before last.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The rule that matters. See the note at the top of this file.
  if (url.pathname.startsWith('/api/')) return;

  // A navigation: try the network so a new deploy is picked up, and fall back to the cached
  // document so the app still opens on a train.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html').then((hit) => hit ?? Response.error()),
      ),
    );
    return;
  }

  // Assets: cache first. Vite's filenames carry a content hash, so a hit is never stale.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

/**
 * Wipe the cache on demand.
 *
 * Sent by the client on sign-out. Nothing here holds financial data, but the shell of an
 * application somebody has stopped using should not linger on a shared machine either, and
 * this is one line on both sides.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'clear-cache') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
  }
});
