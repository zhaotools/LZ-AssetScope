const CACHE = "lz-assetscope-v0.5.1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=0.5.1",
  "./app.js?v=0.5.1",
  "./vendor-lightweight-charts.js?v=0.5.1",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function navigationFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
  } catch (error) {
    // Fall through to the cached application shell while offline.
  }
  return caches.match(new URL("./index.html", self.registration.scope));
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigationFirst(event.request));
    return;
  }
  if (url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
