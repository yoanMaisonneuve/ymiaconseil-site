// sheetfix.js — rattrape les numéros de feuille que l'OCR a PRESQUE bien lus.
//
// Un renvoi ne vaut que si son texte nomme exactement une feuille du document : « A-2O2 » (lettre O
// au lieu du zéro) ou « 4-300 » ne mènent nulle part, et la bulle entière est perdue. On corrige
// donc, après l'OCR de tout le plan, les textes qui ont la FORME d'un numéro de feuille et qui ne
// diffèrent d'une feuille connue que par une confusion de lecture classique (O/0, I/1, S/5, B/8,
// A/4…) ou par un trait de cercle collé au bord (« (A-202 », « IA-202 »).
//
// Ce qu'on ne corrige JAMAIS : un chiffre pris pour un autre chiffre. « A-201 » lu « A-202 » est
// indécelable, et le « corriger » vers la feuille voisine enverrait le poseur au mauvais endroit
// avec assurance — pire que pas de lien. Même règle pour un renvoi d'architecte (« A640 ») : il
// n'est à un chiffre d'aucune de nos feuilles, il reste tel quel.
//
// Toute correction exige une SEULE feuille candidate, et chacune est notée dans le journal.
// Module pur : ne lit et ne modifie que des éléments { s, x0, y0, x1, y1, horiz }.

import { normSheet, sheetKey } from '../../plan/detect.js';

const SHEET_RE = /^[A-Z]{1,3}[-. ]?\d{2,4}[A-Z]?$/;         // copie de detect.js
// Forme lâche d'un numéro de feuille lu par l'OCR : préfixe, séparateur quelconque, chiffres.
const LOOSE_RE = /^[A-Z0-9]{1,3}[\s\-–—._~=:]*[A-Z0-9]{2,5}$/;

// Paires de caractères que le lecteur confond sur un plan : dessin au trait, petit corps.
const PAIRS = ['O0', 'D0', 'Q0', 'U0', 'I1', 'L1', 'J1', 'T1', 'Z2', 'S5', 'G6', 'B8', 'A4'];
const LOOK = new Map();
for (const [a, b] of PAIRS) {
  LOOK.set(a, (LOOK.get(a) || '') + b);
  LOOK.set(b, (LOOK.get(b) || '') + a);
}
const alike = (a, b) => a === b || (LOOK.get(a) || '').includes(b);
// Un trait de bulle lu comme une lettre fine, collé au texte. En fin de texte, jamais le chiffre 1 :
// « A-3001 » est un vrai renvoi à 4 chiffres (feuille d'un autre jeu), pas « A-300 » suivi d'un trait.
const EDGE = new Set(['I', 'L', '1', 'J', 'T']);
const TAIL = new Set(['I', 'L', 'J', 'T']);

const cx = (it) => (it.x0 + it.x1) / 2;
const cy = (it) => (it.y0 + it.y1) / 2;

// Même longueur, chaque caractère égal ou sosie, au plus deux sosies.
function lookalike(k, K) {
  if (k.length !== K.length) return -1;
  let n = 0;
  for (let i = 0; i < k.length; i++) {
    if (k[i] === K[i]) continue;
    if (!alike(k[i], K[i])) return -1;
    n++;
  }
  return n <= 2 ? n : -1;
}

// Clé lue (alphanumérique seulement) contre les clés de feuille connues → { key, why, bold },
// seulement si une seule feuille colle. valid : le texte lu a déjà la forme d'un numéro de feuille.
// bold : correction hardie, admise seulement dans une bulle (voir fixSheetRefs) — la lettre du
// préfixe lue comme un chiffre (« 4-300 »), ou un caractère retiré au bord (« IA-202 »).
function match(k, keys, valid) {
  const hits = new Map();
  for (const K of keys) {
    const n = lookalike(k, K);
    if (n >= 0) { hits.set(K, { why: n ? `confusion ${diff(k, K)}` : 'ponctuation', edge: false }); continue; }
    if (k.length === K.length + 1) {
      if (EDGE.has(k[0]) && lookalike(k.slice(1), K) >= 0) hits.set(K, { why: `trait « ${k[0]} » au bord`, edge: true });
      // En fin de texte, seulement si le texte n'est pas déjà un numéro valide : « A-202T » (suffixe
      // lettre) ou « A-3001 » (4 chiffres) nomment une autre feuille, pas la nôtre plus un trait.
      else if (!valid && TAIL.has(k[k.length - 1]) && lookalike(k.slice(0, -1), K) >= 0) hits.set(K, { why: `trait « ${k[k.length - 1]} » au bord`, edge: true });
    }
  }
  if (hits.size !== 1) return null;
  const [K, h] = [...hits][0];
  return { key: K, why: h.why, bold: h.edge || (/\d/.test(k[0]) && /[A-Z]/.test(K[0])) };
}

// Un partenaire posé juste au-dessus, comme dans une bulle (mêmes bornes que findTop de detect.js).
function hasTop(b, items) {
  return items.some((t) => {
    if (t === b || !t.horiz) return false;
    const m = Math.min(t.size, b.size), dy = cy(b) - cy(t), ratio = t.size / b.size;
    return ratio >= 0.6 && ratio <= 1.7 && dy >= 0.45 * m && dy <= 1.9 * m && Math.abs(cx(t) - cx(b)) <= 0.8 * m;
  });
}

function diff(k, K) {
  const out = [];
  for (let i = 0; i < k.length; i++) if (k[i] !== K[i]) out.push(`${k[i]}→${K[i]}`);
  return out.join(', ');
}

const clean = (s) => String(s).toUpperCase().trim().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');

// Numéro de feuille du cartouche mal lu (« A-2O2 ») : sans lui, la feuille n'a pas de nom et aucun
// renvoi ne peut y mener. Avant buildIndex, dans le coin inférieur droit seulement (là où
// detect.js le cherche), on redonne leur forme aux chiffres d'un texte « préfixe + chiffres ».
export function fixTitleBlocks(doc, editable) {
  const log = [];
  doc.pages.forEach((pg, i) => {
    for (const it of pg.items) {
      if (!editable(it) || !it.horiz || cx(it) <= 0.8 * pg.w || cy(it) <= 0.8 * pg.h) continue;
      if (SHEET_RE.test(normSheet(it.s))) continue;
      const t = clean(it.s);
      const m = t.match(/^([A-Z]{1,3})([\s\-–—._~=:]*)([0-9OIDQSBZGL]{2,4})([A-Z]?)$/);
      if (!m || !/\d/.test(m[3])) continue;
      const digits = m[3].replace(/[A-Z]/g, (c) => (LOOK.get(c) || '').replace(/[^0-9]/g, '')[0] || c);
      const s = `${m[1]}${m[2] ? '-' : ''}${digits}${m[4]}`;
      if (!SHEET_RE.test(normSheet(s))) continue;
      log.push({ page: i, from: it.s, to: s, why: `cartouche, ${diff(m[3], digits)}`, x: Math.round(cx(it)), y: Math.round(cy(it)) });
      it.s = s;
    }
  });
  return log;
}

// Après buildIndex : les feuilles du document sont connues, on rattrape les renvois vers elles.
// editable(it) : vrai pour un texte venu de l'OCR (le vrai texte du PDF n'est jamais touché).
export function fixSheetRefs(doc, ix, editable) {
  const ids = new Map();   // clé → nom affiché
  for (const sh of ix.sheets) {
    if (/^P\d+$/.test(sh.id) || /\(p\.\d+\)$/.test(sh.id)) continue;
    ids.set(sheetKey(sh.id), sh.id);
  }
  const keys = [...ids.keys()];
  const log = [];
  doc.pages.forEach((pg, i) => {
    for (const it of pg.items) {
      if (!editable(it) || !it.horiz) continue;
      if (ids.has(sheetKey(it.s)) && SHEET_RE.test(normSheet(it.s))) continue;
      const t = clean(it.s);
      if (!LOOSE_RE.test(t)) continue;
      // « 4300 » seul est une cote, pas « A-300 » : sans lettre, il faut au moins un séparateur.
      if (!/[A-Z]/.test(t) && !/[^A-Z0-9]/.test(t)) continue;
      const k = t.replace(/[^A-Z0-9]/g, '');
      if (k.length < 3 || !/\d/.test(k)) continue;
      const hit = match(k, keys, SHEET_RE.test(normSheet(it.s)));
      if (!hit) continue;
      // « 4-300 » → « A-300 » (un chiffre devient la lettre du préfixe), « IA-202 » → « A-202 » (un
      // caractère retiré) : corrections hardies, seulement dans une bulle. Seul, ce texte peut être
      // une cote, un numéro de pièce, ou le vrai numéro d'une feuille d'un autre jeu.
      if (hit.bold && !hasTop(it, pg.items)) continue;
      const to = ids.get(hit.key);
      if (to === it.s) continue;
      log.push({ page: i, from: it.s, to, why: hit.why, x: Math.round(cx(it)), y: Math.round(cy(it)) });
      it.s = to;
    }
  });
  return log;
}
