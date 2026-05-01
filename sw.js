/* =====================================================
   SERVICE WORKER — Terceiro INFO PWA  v2
   - Cache offline
   - Notification Triggers API: notificações agendadas
     pelo sistema operacional — disparam com app fechado
     e sem internet, pois são registradas no próprio SO.
   ===================================================== */

const CACHE_NAME = 'terceiro-info-v2';
const OFFLINE_URL = './index.html';

const PRECACHE_ASSETS = [
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@300;400;500;600;700&display=swap',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => rescheduleAll())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.url.startsWith('chrome-extension')) return;
  if (req.url.includes('firestore.googleapis.com') ||
      req.url.includes('firebase') ||
      req.url.includes('googleapis.com/identitytoolkit')) return;

  event.respondWith(
    fetch(req)
      .then(response => {
        if (response && response.status === 200) {
          const url = req.url;
          if (url.startsWith(self.location.origin) ||
              url.includes('fonts.googleapis.com') ||
              url.includes('fonts.gstatic.com') ||
              url.includes('gstatic.com/firebasejs')) {
            caches.open(CACHE_NAME).then(cache => cache.put(req, response.clone()));
          }
        }
        return response;
      })
      .catch(() =>
        caches.match(req).then(cached => {
          if (cached) return cached;
          if (req.destination === 'document') return caches.match(OFFLINE_URL);
          if (req.destination === 'image') {
            return new Response(OFFLINE_SVG, { headers: { 'Content-Type': 'image/svg+xml' } });
          }
        })
      )
  );
});

const OFFLINE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
  <rect width="480" height="300" fill="#111118" rx="8"/>
  <text x="240" y="120" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#5c2d91">📵</text>
  <text x="240" y="168" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="bold" fill="#eeeef8">Você está offline!</text>
  <text x="240" y="195" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#8888aa">Algumas funções do app podem não</text>
  <text x="240" y="215" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#8888aa">funcionar por conta disso.</text>
</svg>`;

/* =====================================================
   NOTIFICATION TRIGGERS API
   O TimestampTrigger registra a notificação diretamente
   no sistema operacional Android. Ela dispara na hora
   certa mesmo com app fechado e sem internet.
   Fallback via setInterval para browsers sem suporte.
===================================================== */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('terceiro-info-notif', 2);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notifications'))
        db.createObjectStore('notifications', { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject();
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction('notifications', 'readonly');
    const req = tx.objectStore('notifications').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function dbPut(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    tx.objectStore('notifications').put(item);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    tx.objectStore('notifications').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    tx.objectStore('notifications').clear();
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function scheduleWithTrigger(notif) {
  if (notif.fireAt <= Date.now()) return false;
  try {
    await self.registration.showNotification(notif.title, {
      body: notif.body,
      icon: 'https://i.imgur.com/7sHCoxx.png',
      badge: 'https://i.imgur.com/7sHCoxx.png',
      tag: 'notif-' + notif.id,
      data: { notifId: notif.id, eventId: notif.eventId || null },
      showTrigger: new TimestampTrigger(notif.fireAt),
      vibrate: [200, 100, 200],
      requireInteraction: false
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function cancelTrigger(notifId) {
  try {
    const list = await self.registration.getNotifications({ includeTriggered: true });
    list.filter(n => n.tag === 'notif-' + notifId).forEach(n => n.close());
  } catch (e) {}
}

async function rescheduleAll() {
  const all = await dbGetAll();
  for (const notif of all) {
    if (notif.fireAt > Date.now()) {
      const ok = await scheduleWithTrigger(notif);
      if (!ok) return; // sem suporte — usa fallback
    }
  }
}

/* Fallback para browsers sem TimestampTrigger */
async function checkFallback() {
  const now = Date.now();
  const all = await dbGetAll();
  for (const notif of all) {
    if (notif.fireAt <= now && notif.fireAt > now - 10 * 60 * 1000) {
      try {
        await self.registration.showNotification(notif.title, {
          body: notif.body,
          icon: 'https://i.imgur.com/7sHCoxx.png',
          badge: 'https://i.imgur.com/7sHCoxx.png',
          tag: 'notif-' + notif.id,
          vibrate: [200, 100, 200]
        });
      } catch (e) {}
      await dbDelete(notif.id);
    }
  }
}
setInterval(checkFallback, 60 * 1000);
checkFallback();

self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};
  const reply = msg => event.source && event.source.postMessage(msg);

  switch (type) {
    case 'SCHEDULE_NOTIFICATIONS':
      await dbClear();
      const prev = await self.registration.getNotifications({ includeTriggered: true }).catch(() => []);
      prev.forEach(n => n.close());
      if (Array.isArray(payload)) {
        for (const n of payload) { await dbPut(n); await scheduleWithTrigger(n); }
      }
      reply({ type: 'SCHEDULE_OK', count: payload?.length || 0 });
      break;

    case 'UPSERT_NOTIFICATION':
      if (payload) {
        await cancelTrigger(payload.id);
        await dbPut(payload);
        await scheduleWithTrigger(payload);
        reply({ type: 'UPSERT_OK', id: payload.id });
      }
      break;

    case 'DELETE_NOTIFICATION':
      if (payload?.id) {
        await cancelTrigger(payload.id);
        await dbDelete(payload.id);
        reply({ type: 'DELETE_OK', id: payload.id });
      }
      break;

    case 'GET_NOTIFICATIONS':
      reply({ type: 'NOTIFICATIONS_LIST', data: await dbGetAll() });
      break;

    case 'TEST_NOTIFICATION':
      await self.registration.showNotification('🔔 Terceiro INFO', {
        body: 'Notificações funcionando! Você receberá avisos dos eventos.',
        icon: 'https://i.imgur.com/7sHCoxx.png',
        badge: 'https://i.imgur.com/7sHCoxx.png',
        vibrate: [200, 100, 200]
      });
      break;

    case 'CHECK_TRIGGER_SUPPORT':
      let supported = false;
      try { supported = typeof TimestampTrigger !== 'undefined'; } catch(e) {}
      reply({ type: 'TRIGGER_SUPPORT', supported });
      break;
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) if ('focus' in c) return c.focus();
      return clients.openWindow('./index.html');
    })
  );
});
