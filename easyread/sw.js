// L'INTERRUPTEUR de /easyread/ — Syllabes Faciles a déménagé à https://syllabesfaciles.ca
//
// Décision de Yoan, 09.10.2026 à 21 h 59 : ymiaconseil.com/easyread/ devient une RÉALISATION de YM IA Conseil (une
// page de vente qui pointe vers syllabesfaciles.ca). L'app ne s'y publie plus.
//
// Pourquoi ce fichier existe : ceux qui ont utilisé l'app à /easyread/ gardent son service worker (enregistré sous
// /easyread/sw.js, portée /easyread/). Si ce fichier disparaissait, leur navigateur garderait l'ANCIEN pour toujours
// (une mise à jour qui répond 404 ne désinscrit rien) : il continuerait de mettre la page en cache, et l'enfant qui
// touche l'icône de l'app tomberait sur une page de vente au lieu de ses livres.
//
// Ce qu'il fait, une seule fois, chez eux seulement : il remplace l'ancien (skipWaiting), vide les caches de l'app
// (« syllabes-… », et rien d'autre : le domaine sert aussi d'autres apps), se désinscrit, et envoie vers
// https://syllabesfaciles.ca les fenêtres que l'ancien contrôlait (et seulement elles : matchAll sans
// includeUncontrolled, sinon une page de ymiaconseil.com ouverte à côté partirait aussi). Il ne sert jamais rien
// lui-même (aucun « fetch ») : la page de vente passe par le réseau.
// Le visiteur qui n'avait pas l'app ne le reçoit jamais : la page de vente ne l'enregistre pas.
//
// À GARDER à cette adresse exacte (easyread/sw.js) tant que /easyread/ existe : le navigateur ne cherche la mise à
// jour qu'au nom sous lequel l'ancien a été enregistré. Prouvé en local par banc-interrupteur.mjs (même dossier).

const CIBLE = 'https://syllabesfaciles.ca/';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const noms = await caches.keys();
      await Promise.all(noms.filter((n) => n.startsWith('syllabes-')).map((n) => caches.delete(n)));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
    const fenetres = await self.clients.matchAll({ type: 'window' });
    await Promise.all(fenetres.map((c) => c.navigate(CIBLE).catch(() => null)));
  })());
});
