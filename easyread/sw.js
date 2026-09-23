// Service worker de Syllabes Faciles.
//
// Pourquoi il existe : l'app est publiee a ymiaconseil.com/easyread et s'installe sur l'ecran
// d'accueil de la tablette. Sans lui, taper l'icone sans wifi donne le dinosaure de Chrome, en
// plein ecran, sans barre d'adresse pour comprendre. Une app d'enfant qui meurt des que le
// reseau tombe, c'est le probleme qu'on croyait avoir resolu en publiant.
//
// Deux strategies, et la raison de chacune :
//
//   - LA PAGE (navigation) : reseau d'abord, cache en repli. Parce que le HTML nomme le bundle
//     par son empreinte, et que l'empreinte change a chaque export. Une page servie depuis un
//     vieux cache pointerait vers un bundle qui n'existe plus sur le serveur : ecran blanc,
//     et personne ne saurait pourquoi. Le reseau d'abord garantit que la page et son bundle
//     vont ensemble.
//   - TOUT LE RESTE : cache d'abord. Le bundle, les polices d'icones et les images portent leur
//     empreinte dans leur nom : leur contenu ne change JAMAIS pour une empreinte donnee. Les
//     relire sur le reseau serait du gaspillage pur, et Yoan paie ses jetons comme ses donnees.
//
// A CHAQUE PUBLICATION : changer VERSION. Sinon les tablettes qui ont deja l'app gardent
// l'ancien cache. C'est la panne P27 de l'app de plans, apprise a la dure le 20 septembre.

const VERSION = 'syllabes-2026-09-23a';
const COQUILLE = VERSION + '-coquille';

// Relatif au sw.js lui-meme : marche a /easyread/ en ligne comme a / en local, sans rien coder en dur.
const RACINE = new URL('./', self.location).pathname;

const A_PRECHARGER = [
  RACINE,
  RACINE + 'manifest.webmanifest',
  RACINE + 'icons/icon-192.png',
  RACINE + 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(COQUILLE)
      // addAll echoue en entier si un seul fichier manque ; on met donc chaque entree a part,
      // pour qu'une icone absente n'empeche pas la page d'etre disponible hors ligne.
      .then((c) => Promise.all(A_PRECHARGER.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => n.startsWith('syllabes-') && n !== COQUILLE)
            .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // jamais les autres domaines
  if (url.pathname.startsWith(RACINE + 'api/')) return;      // le backend inexistant : on laisse echouer vite
  if (!url.pathname.startsWith(RACINE)) return;              // hors de notre portee (ex : /plan/)

  // La page : reseau d'abord.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((rep) => {
          const copie = rep.clone();
          caches.open(COQUILLE).then((c) => c.put(RACINE, copie)).catch(() => {});
          return rep;
        })
        .catch(() => caches.match(RACINE).then((r) => r || caches.match(req)))
    );
    return;
  }

  // Le reste : cache d'abord, et on garde ce qu'on telecharge.
  e.respondWith(
    caches.match(req).then((cache) => cache || fetch(req).then((rep) => {
      if (rep && rep.ok && rep.type === 'basic') {
        const copie = rep.clone();
        caches.open(COQUILLE).then((c) => c.put(req, copie)).catch(() => {});
      }
      return rep;
    }))
  );
});
