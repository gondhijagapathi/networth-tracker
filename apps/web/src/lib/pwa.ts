/**
 * Service worker registration.
 *
 * Production only. In development Vite serves modules unbundled and rewrites them on every
 * save, and a worker caching that would produce the single most confusing bug in front-end
 * work — an edit that does not appear, intermittently.
 *
 * Registration failing is not an error worth showing anybody: it means the browser does not
 * support service workers, or the page is on plain HTTP, and in both cases the application
 * works exactly as it did before. The only cost is that it will not launch offline.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Deliberately silent. See above.
    });
  });
}

/**
 * Drop the cached shell, on sign-out.
 *
 * The cache holds no financial data — `sw.js` refuses to store an API response — so this is
 * tidiness rather than a security control, and it is written down that way so nobody later
 * mistakes it for one.
 */
export function clearOfflineCache(): void {
  navigator.serviceWorker?.controller?.postMessage('clear-cache');
}
