/* PRESSURE — service worker
 *
 * Trois rôles, inchangés :
 *   1. Rendre l'application installable (Chrome et Brave n'offrent une vraie
 *      installation PWA qu'avec un service worker doté d'un gestionnaire fetch).
 *   2. Servir la coquille hors ligne.
 *   3. Signaler qu'une nouvelle version est active.
 *
 * Ce qui a changé, et pourquoi :
 *
 * A. La coquille passait en cache-first ("return hit || net"). La page mise en
 *    cache était renvoyée immédiatement et la nouvelle version n'était écrite
 *    qu'en arrière-plan : après un push, la première ouverture affichait encore
 *    l'ancienne application. C'est ce qui donnait l'impression que les
 *    correctifs n'étaient pas appliqués. C'est désormais network-first avec un
 *    court délai, et repli sur le cache seulement si le réseau ne répond pas.
 *
 * B. Le worker interceptait les requêtes de flux et, en cas d'échec réseau,
 *    renvoyait une copie du cache DATA. L'application recevait alors un 200
 *    avec des données périmées et affichait la source en « live ». L'indicateur
 *    live / cached / down mentait, et cela court-circuitait le cache visible de
 *    l'application (pa_cache, avec l'âge affiché). Cette interception est
 *    supprimée : les flux ne passent plus par le worker.
 *
 * C. warm() relançait jusqu'à douze requêtes en parallèle vers les hôtes qui
 *    limitent au débit — exactement la rafale qui provoquait les 429 et les
 *    sources en « down ». Supprimée. Un service worker ne peut de toute façon
 *    pas écrire dans localStorage, où l'application range ses données : cette
 *    fonction ne réchauffait qu'un cache devenu inutile.
 */

const SHELL = 'pressure-shell-v8';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
const NET_TIMEOUT = 2500;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    /* addAll est atomique : un seul 404 faisait échouer toute l'installation et
       le worker ne s'installait jamais. On ajoute pièce par pièce. */
    await Promise.allSettled(ASSETS.map(a => c.add(new Request(a, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(n => n !== SHELL).map(n => caches.delete(n)));
    await self.clients.claim();
    /* Prévient les onglets ouverts qu'une nouvelle version tourne, pour qu'ils
       puissent se recharger au lieu de rester sur l'ancienne. */
    const cl = await self.clients.matchAll({ type: 'window' });
    for (const c of cl) c.postMessage({ type: 'sw-activated', version: SHELL });
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Tout ce qui n'est pas la coquille est laissé au réseau. Les flux, les
     passerelles et le proxy personnel ne doivent pas être mis en cache ici :
     l'application gère elle-même sa fraîcheur et affiche l'âge de ses copies. */
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    try {
      /* Network-first borné : en ligne on a toujours la dernière version, hors
         ligne ou sur réseau lent on bascule sur le cache sans faire attendre. */
      const net = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NET_TIMEOUT))
      ]);
      if (net && net.ok && net.type !== 'opaque') cache.put(req, net.clone());
      return net;
    } catch (err) {
      const hit = await cache.match(req);
      if (hit) return hit;
      /* Navigation hors ligne vers une URL jamais visitée : on sert la coquille. */
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/* Le rafraîchissement de fond reste déclaré : c'est ce qui permet à Chrome de
   proposer Periodic Background Sync, et l'écran Info le signale. Il se contente
   de réveiller les fenêtres ouvertes — un worker ne peut pas alimenter le
   localStorage de l'application, et relancer les flux ici ne ferait que
   consommer le quota des passerelles pour rien. */
async function ping() {
  const cl = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of cl) c.postMessage({ type: 'refresh' });
}
self.addEventListener('periodicsync', e => {
  if (e.tag === 'pressure-refresh') e.waitUntil(ping());
});
self.addEventListener('sync', e => {
  if (e.tag === 'pressure-refresh') e.waitUntil(ping());
});
