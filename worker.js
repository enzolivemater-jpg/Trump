/* ═══════════════════════════════════════════════════════════════════════════
   PRESSURE — proxy personnel (Cloudflare Worker) · v2
   ───────────────────────────────────────────────────────────────────────────
   POURQUOI CE WORKER
   · Reddit et whitehouse.gov n'envoient aucun en-tête CORS : le navigateur
     refuse la réponse même quand le serveur répond 200.
   · GDELT exige un User-Agent de navigateur et limite par IP : les relais
     publics partagés (allorigins, codetabs) prennent 429 en permanence.
   · Truth Social est derrière Cloudflare et refuse les IP de datacenter —
     d'où le routage vers l'archive publique CNN côté client.
   Un worker personnel règle tout : une seule origine, ton propre quota
   (100 000 requêtes/jour en gratuit), en-têtes posés côté serveur.

   CE QUI CHANGE PAR RAPPORT À LA v1
   1. GET / renvoie désormais 200 + un JSON de santé au lieu de 400.
      C'est ce qui affichait « Proxy perso · HTTP 400 » dans le diagnostic
      alors que le worker fonctionnait parfaitement.
   2. Allowlist par suffixe en plus de la liste exacte (sous-domaines).
   3. Bascule automatique www.reddit.com → old.reddit.com sur 403/429.
   4. Validation du corps GDELT : l'API répond 200 avec un message d'erreur
      en texte brut. Le worker le convertit en 502 lisible au lieu de laisser
      le client planter sur un JSON.parse.
   5. Timeout serveur de 15 s : le worker ne reste plus pendu jusqu'à
      expiration du budget côté client.
   6. En-têtes de diagnostic X-Px-* exposés au navigateur.
   7. Les réponses en erreur ne sont plus mises en cache au bord.

   DÉPLOIEMENT — voir README-deploy.md
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─── Sécurité : sans allowlist, l'URL publique devient un proxy ouvert que
   n'importe qui peut faire tourner sur ton quota. Ajoute ici l'hôte d'un
   nouveau flux avant de le coller dans « Extra feed » côté application. ─── */
const ALLOW = [
  'api.gdeltproject.org',
  'www.federalregister.gov',
  'www.reddit.com',
  'old.reddit.com',
  'oauth.reddit.com',
  'news.google.com',
  'www.whitehouse.gov',
  'truthsocial.com',
  'ix.cnn.io'
];

/* Suffixes autorisés : couvre les sous-domaines sans les lister un par un. */
const ALLOW_SUFFIX = [
  '.reddit.com',
  '.whitehouse.gov',
  '.gdeltproject.org',
  '.federalregister.gov',
  '.cnn.io'
];

/* User-Agent de navigateur. C'est l'élément indispensable pour GDELT et
   Reddit : tous deux refusent les clients sans UA reconnaissable. */
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const ACCEPT = 'application/json, application/rss+xml, application/atom+xml, ' +
               'application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';

/* Access-Control-Expose-Headers est obligatoire : sans lui, le JavaScript de
   la page ne peut pas lire les en-têtes X-Px-* d'une réponse cross-origin. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Px-Status,X-Px-Host,X-Px-Try,X-Px-Ms',
  'Access-Control-Max-Age': '86400'
};

const TIMEOUT = 15000;   /* toujours < au budget par flux côté client (25 s) */
const VERSION = '2.0.0';

/* Miroirs essayés dans l'ordre quand l'hôte principal refuse (403 / 429).
   Reddit sert le même flux .rss sur old.reddit.com avec un filtrage bien
   plus permissif envers les IP de datacenter — dont celles de Cloudflare. */
const MIRROR = {
  'www.reddit.com': ['www.reddit.com', 'old.reddit.com'],
  'old.reddit.com': ['old.reddit.com', 'www.reddit.com']
};

/* Hôtes dont le corps doit être vérifié avant d'être relayé. GDELT répond
   HTTP 200 avec « Your query was too short… » en texte brut : sans ce
   contrôle, le client reçoit un 200 et casse au JSON.parse, ce qui fait
   passer la source en « down » pour une raison illisible. */
/* ix.cnn.io est volontairement absent : l'archive Truth Social pese plusieurs
   Mo et la bufferiser en memoire n'apporterait rien — elle est relayee en
   flux comme le RSS. */
const MUST_BE_JSON = new Set(['api.gdeltproject.org', 'www.federalregister.gov']);

const allowed = host =>
  ALLOW.includes(host) || ALLOW_SUFFIX.some(s => host.endsWith(s));

const reply = (body, status, extra = {}) =>
  new Response(body, {
    status,
    headers: { ...CORS, 'Cache-Control': 'no-store', ...extra }
  });

const fail = (msg, status, extra = {}) =>
  reply(JSON.stringify({ ok: false, error: msg, status }), status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extra
  });

/* Une seule requête sortante, avec les en-têtes que réclament les sources. */
function grab(url) {
  return fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': ACCEPT,
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    },
    redirect: 'follow',
    /* Coupe la requête côté serveur avant que le client n'abandonne. */
    signal: AbortSignal.timeout(TIMEOUT),
    /* Cache de bord : n'a d'effet que sur un domaine personnalisé, il est
       ignoré sur *.workers.dev. Inoffensif, utile si tu montes un domaine.
       Les erreurs ne sont jamais mises en cache. */
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: { '200-299': 60, '300-399': 0, '400-599': 0 }
    }
  });
}

export default {
  async fetch(request) {
    const t0 = Date.now();
    const here = new URL(request.url);

    /* ── Preflight ──────────────────────────────────────────────────────── */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail('method not allowed, GET only', 405);
    }

    /* ── Santé ───────────────────────────────────────────────────────────
       Sans paramètre, le worker se déclare vivant. C'est ce qui remplace
       l'ancien « HTTP 400 » du diagnostic PRESSURE. */
    const raw = here.searchParams.get('url') || here.searchParams.get('quest');
    if (!raw) {
      return reply(
        JSON.stringify({
          ok: true,
          name: 'pressure-px',
          version: VERSION,
          usage: here.origin + '/?url=https%3A%2F%2Fexample.com%2Ffeed',
          allow: ALLOW,
          allowSuffix: ALLOW_SUFFIX
        }),
        200,
        { 'Content-Type': 'application/json; charset=utf-8' }
      );
    }

    /* ── Validation de la cible ─────────────────────────────────────────── */
    let target;
    try {
      target = new URL(raw);
    } catch {
      return fail('bad url: ' + String(raw).slice(0, 80), 400);
    }
    if (target.protocol !== 'https:') return fail('https only', 400);
    /* Garde-fou anti-boucle : un ?url= pointant sur le worker lui-même
       consommerait deux requêtes de quota par appel, indéfiniment. */
    if (target.hostname === here.hostname) return fail('loop refused', 400);
    if (!allowed(target.hostname)) {
      return fail('host not allowed: ' + target.hostname +
                  ' — ajoute-le dans ALLOW du worker', 403);
    }

    /* ── Requête, avec bascule de miroir sur refus ───────────────────────── */
    const hosts = MIRROR[target.hostname] || [target.hostname];
    let last = null, tries = 0;

    for (const host of hosts) {
      tries++;
      const u = new URL(target.toString());
      u.hostname = host;

      let up;
      try {
        up = await grab(u.toString());
      } catch (e) {
        /* Timeout, DNS, TLS : on tente le miroir suivant s'il existe. */
        last = fail('upstream unreachable: ' + String(e.message || e).slice(0, 120), 502, {
          'X-Px-Host': host, 'X-Px-Try': String(tries), 'X-Px-Ms': String(Date.now() - t0)
        });
        continue;
      }

      /* Refus typé : on bascule sur le miroir plutôt que de rendre l'erreur. */
      if ((up.status === 403 || up.status === 429) && tries < hosts.length) {
        last = fail('upstream ' + up.status + ' on ' + host, up.status, {
          'X-Px-Host': host, 'X-Px-Try': String(tries)
        });
        continue;
      }

      const dbg = {
        'X-Px-Status': String(up.status),
        'X-Px-Host': host,
        'X-Px-Try': String(tries),
        'X-Px-Ms': String(Date.now() - t0)
      };

      if (!up.ok) {
        /* Le statut d'origine est conservé tel quel : c'est lui que Feed
           status affiche, et c'est ce qui rend la panne diagnosticable. */
        const body = (await up.text().catch(() => '')).slice(0, 300);
        return fail('upstream ' + up.status + (body ? ' · ' + body : ''), up.status, dbg);
      }

      const ct = up.headers.get('content-type') || 'text/plain; charset=utf-8';

      /* Sources JSON : on vérifie la forme avant de relayer. */
      if (MUST_BE_JSON.has(host)) {
        const text = await up.text();
        const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 1);
        if (head !== '{' && head !== '[') {
          return fail('upstream sent non-json: ' + text.trim().slice(0, 200), 502, dbg);
        }
        return reply(text, 200, {
          ...dbg,
          'Content-Type': 'application/json; charset=utf-8'
        });
      }

      /* Tout le reste (RSS, Atom) est relayé en flux : pas de mise en
         mémoire, pas de limite de taille, latence minimale. */
      return new Response(up.body, {
        status: 200,
        headers: { ...CORS, ...dbg, 'Content-Type': ct, 'Cache-Control': 'public, max-age=60' }
      });
    }

    return last || fail('no upstream answered', 502);
  }
};
