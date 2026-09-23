// 讓 Chrome / Edge 把模擬器當成可以「安裝」的 App。
// 不做離線快取:模擬器本來就要電腦上的 LEO 模擬器開著才能用,快取反而會拿到舊版網頁。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
