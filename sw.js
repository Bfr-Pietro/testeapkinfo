/* =====================================================
   SERVICE WORKER — Terceiro INFO PWA
   - Cache offline de todas as páginas/assets do app
   - Notificações locais agendadas (disparadas mesmo offline)
   - Sincronização de eventos do Firestore via postMessage
   ===================================================== */

const CACHE_NAME = 'terceiro-info-v1';
const OFFLINE_URL = './index.html';

/* Assets que sempre ficam em cache */
const PRECACHE_ASSETS = [
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@300;400;500;600;700&display=swap',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js'
];

/* ── INSTALL: pré-cacheia assets essenciais ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Falha silenciosa em assets externos (fontes etc.)
      });
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: remove caches antigos ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH: Estratégia Network-first com fallback para cache ── */
self.addEventListener('fetch', event => {
  const req = event.request;

  // Ignora requisições não-GET e extensões do Chrome
  if (req.method !== 'GET') return;
  if (req.url.startsWith('chrome-extension')) return;

  // Requisições ao Firebase/Firestore: deixa passar normalmente
  if (req.url.includes('firestore.googleapis.com') ||
      req.url.includes('firebase') ||
      req.url.includes('googleapis.com/identitytoolkit')) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then(response => {
        // Cacheia resposta bem-sucedida (apenas mesma origem + CDNs conhecidos)
        if (response && response.status === 200) {
          const url = req.url;
          const shouldCache =
            url.startsWith(self.location.origin) ||
            url.includes('fonts.googleapis.com') ||
            url.includes('fonts.gstatic.com') ||
            url.includes('gstatic.com/firebasejs');

          if (shouldCache) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
        }
        return response;
      })
      .catch(() => {
        // Offline: tenta servir do cache
        return caches.match(req).then(cached => {
          if (cached) return cached;

          // Se for navegação (HTML), retorna o app offline
          if (req.destination === 'document') {
            return caches.match(OFFLINE_URL);
          }

          // Para imagens externas (imgur, etc): retorna SVG de aviso offline
          if (req.destination === 'image') {
            return new Response(OFFLINE_IMAGE_SVG, {
              headers: { 'Content-Type': 'image/svg+xml' }
            });
          }
        });
      })
  );
});

/* ── SVG mostrado no lugar de imagens quando offline ── */
const OFFLINE_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
  <rect width="480" height="300" fill="#111118" rx="8"/>
  <text x="240" y="120" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#5c2d91">📵</text>
  <text x="240" y="168" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="bold" fill="#eeeef8">Você está offline!</text>
  <text x="240" y="195" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#8888aa">Algumas funções do app podem não</text>
  <text x="240" y="215" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#8888aa">funcionar por conta disso.</text>
</svg>`;

/* =====================================================
   SISTEMA DE NOTIFICAÇÕES LOCAIS AGENDADAS
   =====================================================
   O app envia eventos ao SW via postMessage.
   O SW armazena no IndexedDB e usa um alarme periódico
   (via setInterval ao ser ativado) para checar e disparar.
*/

/* ── Banco simples em memória (persistido via IndexedDB) ── */
let scheduledNotifications = [];

/* ── Abre/cria IndexedDB ── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('terceiro-info-notif', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('notifications')) {
        db.createObjectStore('notifications', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function getAllNotifications() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readonly');
    const store = tx.objectStore('notifications');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function saveNotification(notif) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    store.put(notif);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject();
  });
}

async function deleteNotification(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject();
  });
}

async function clearAllNotifications() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject();
  });
}

/* ── Verifica e dispara notificações pendentes ── */
async function checkAndFireNotifications() {
  const now = Date.now();
  const all = await getAllNotifications();

  for (const notif of all) {
    // Notificações com fireAt no passado (até 10 minutos atrás) ou agora
    if (notif.fireAt <= now && notif.fireAt > now - 10 * 60 * 1000) {
      await self.registration.showNotification(notif.title, {
        body: notif.body,
        icon: 'https://i.imgur.com/7sHCoxx.png',
        badge: 'https://i.imgur.com/7sHCoxx.png',
        tag: notif.id,
        data: { eventId: notif.eventId },
        vibrate: [200, 100, 200],
        requireInteraction: false
      });
      // Remove após disparar
      await deleteNotification(notif.id);
    }
  }
}

/* Inicia verificação periódica a cada 1 minuto */
setInterval(checkAndFireNotifications, 60 * 1000);
// Verifica imediatamente ao ativar
checkAndFireNotifications();

/* ── Recebe mensagens do app principal ── */
self.addEventListener('message', async event => {
  const { type, payload } = event.data || {};

  switch (type) {

    /* Recebe lista completa de notificações agendadas */
    case 'SCHEDULE_NOTIFICATIONS':
      await clearAllNotifications();
      if (Array.isArray(payload)) {
        for (const n of payload) {
          await saveNotification(n);
        }
      }
      event.source && event.source.postMessage({ type: 'SCHEDULE_OK', count: payload?.length || 0 });
      break;

    /* Adiciona ou atualiza uma notificação */
    case 'UPSERT_NOTIFICATION':
      if (payload) {
        await saveNotification(payload);
        event.source && event.source.postMessage({ type: 'UPSERT_OK', id: payload.id });
      }
      break;

    /* Remove uma notificação pelo id */
    case 'DELETE_NOTIFICATION':
      if (payload?.id) {
        await deleteNotification(payload.id);
        event.source && event.source.postMessage({ type: 'DELETE_OK', id: payload.id });
      }
      break;

    /* Retorna lista atual de notificações */
    case 'GET_NOTIFICATIONS':
      const all = await getAllNotifications();
      event.source && event.source.postMessage({ type: 'NOTIFICATIONS_LIST', data: all });
      break;

    /* Teste imediato */
    case 'TEST_NOTIFICATION':
      await self.registration.showNotification('🔔 Terceiro INFO', {
        body: 'Notificações funcionando! Você receberá avisos dos eventos.',
        icon: 'https://i.imgur.com/7sHCoxx.png',
        badge: 'https://i.imgur.com/7sHCoxx.png',
        vibrate: [200, 100, 200]
      });
      break;
  }
});

/* ── Clique na notificação: abre o app ── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow('./index.html');
    })
  );
});
