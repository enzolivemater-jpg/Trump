/* PRESSURE — proxy personnel (Cloudflare Worker)
 *
 * Pourquoi : Reddit et Truth Social n'envoient aucun en-tête CORS et refusent
 * les relais publics partagés (403 sur les IP de datacenter mutualisées).
 * GDELT, lui, réclame un User-Agent de navigateur sous peine de 429.
 * Un worker personnel règle les trois : une seule origine, ton propre quota,
 * et des en-têtes posés côté serveur.
 *
 * Déploiement (5 min, gratuit, 100 000 requêtes/jour) :
 *   1. dash.cloudflare.com  →  Workers & Pages  →  Create  →  Start from Hello World
 *   2. Remplacer tout le contenu par ce fichier  →  Deploy
 *   3. Copier l'URL obtenue, par ex. https://pressure-proxy.TONCOMPTE.workers.dev
 *   4. Dans PRESSURE : Info → Personal proxy → coller l'URL suivie de /?url=
 *        https://pressure-proxy.TONCOMPTE.workers.dev/?url=
 *      → Save proxy
 *
 * ALLOW limite le worker à tes sources : sans cette liste, l'URL publique
 * devient un proxy ouvert que n'importe qui peut utiliser sur ton quota.
 */

const ALLOW = [
  'api.gdeltproject.org',
  'www.federalregister.gov',
  'www.reddit.com',
  'oauth.reddit.com',
  'news.google.com',
  'www.whitehouse.gov',
  'truthsocial.com',
  'cdn.jsdelivr.net'
];

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

const fail = (msg, status) =>
  new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return fail('GET only', 405);

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return fail('missing ?url=', 400);

    let target;
    try { target = new URL(raw); } catch { return fail('bad url', 400); }
    if (target.protocol !== 'https:') return fail('https only', 400);
    if (!ALLOW.includes(target.hostname)) return fail('host not allowed', 403);

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, application/rss+xml, application/atom+xml, ' +
                    'application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        // Cache court : le desk rescanne toutes les 90 s, inutile de retaper
        // la source à chaque fois depuis plusieurs onglets.
        cf: { cacheTtl: 60, cacheEverything: true }
      });
    } catch (e) {
      return fail('upstream unreachable: ' + e.message, 502);
    }

    // Le corps est relayé en flux : pas de mise en mémoire, pas de limite de taille.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS,
        'Content-Type': upstream.headers.get('content-type') || 'text/plain',
        'Cache-Control': 'public, max-age=60'
      }
    });
  }
};
