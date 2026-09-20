// detect.js — des éléments de texte positionnés → l'index de navigation du plan.
//
// La convention des dessins d'atelier, telle qu'observée :
//
//   vue d'ensemble   ▲ MR03      « ce mur est dessiné sur la feuille A-201 »
//                      A-201
//
//   élévation        ( 5 )       « la coupe 5 est sur la feuille A-300 »
//                     300
//
//   feuille détails  (18)        gros numéro = l'étiquette du détail, la cible
//                    3/A703      (dessous : renvoi de l'architecte, pas le nôtre)
//
// Tout se ramène à une règle : un texte qui nomme une feuille du document, avec
// éventuellement un partenaire centré juste au-dessus. Partenaire numérique = renvoi
// de détail. Partenaire texte = nom du mur. Pas de partenaire = renvoi de feuille nu.
//
// Module pur, sans DOM : tourne dans Node pour les tests.

// À incrémenter à chaque changement de règle : l'app ré-analyse alors les plans déjà importés.
export const DETECT_VERSION = 10;

const SHEET_RE = /^[A-Z]{1,3}[-. ]?\d{2,4}[A-Z]?$/;
// Un détail se nomme par un numéro (« 5 », « 12A ») ou par une lettre seule (coupe « A »).
const DETAIL_RE = /^(\d{1,3}[A-Z]?|[A-Z])$/;
// Le haut d'un renvoi peut porter une mention : « 10 INV. » = détail 10 inversé, « 19-sim » = similaire.
const DETAIL_TOP_RE = /^(\d{1,3}[A-Z]?|[A-Z])(?:[\s\-–]*(INV|SIM|TYP|OPP|MIR)\.?)?$/;
const SHORT_RE = /^\d{2,4}$/;
// Un nom de mur tel qu'écrit dans un cercle de titre : « MR-07B », « MR03 ». Jamais de point (« C.4 » = axe).
const WALL_RAW_RE = /^([A-Z]{2,4})-?(\d{1,3})[A-Z]?$/;
const PAGE_LABEL_RE = /(N[O°]\.?\s*DE\s*PAGE|N[O°]\.?\s*(DE\s*)?FEUILLE|SHEET\s*(NO|NUM|#)|DWG\.?\s*(NO|NUM|#)|DESSIN\s*N[O°])/i;
const TITLE_LABEL_RE = /^(TITRE(\s*DU\s*DESSIN)?|DRAWING\s*TITLE|SHEET\s*TITLE)\s*:?$/i;
const AFTER_TITLE_RE = /(DESSIN[ÉE]\s*PAR|CHARG[ÉE]|DRAWN|CHECKED|V[ÉE]RIFI[ÉE]|DIMENSION|[ÉE]CHELLE|SCALE)/i;

// Une cote : commence par un nombre (ou un préfixe « (MG) »), porte une marque de pied ou de pouce,
// ou s'écrit « entier fraction » (« 45 3/4 »). Jamais une échelle (« = »), jamais une section de
// profilé (« 2" X 4" »), jamais une phrase.
const DIM_MARK_RE = /^(\([A-Z.]{1,4}\)\s*)?\d[\d\s\/\-.,]*('|''|"|′|″|”)[\d\s\/\-.,]*('|''|"|′|″|”)?[\d\s\/\-.,]*/;
const DIM_FRAC_RE = /^\d+\s+\d+\/\d+$/;
// Après la mesure : rien, ou au plus deux abréviations de métier (FAB., O.B., DOS/MENEAU) et une
// conversion entre crochets. Une phrase, non — une note d'atelier n'est pas une cote.
const DIM_TAIL_RE = /^(\s*\[[^\]]{1,20}\])?(\s*(?:[A-Z]{1,4}|[A-ZÀ-Ü]{1,12}[./-][A-ZÀ-Ü./-]{0,12})\.?){0,2}(\s*\[[^\]]{1,20}\])?\s*$/i;
// Cote d'INSTALLATION : elle dit où poser, par rapport à un repère du bâtiment — dos de meneau,
// face du mur-rideau, fond, pont. Yoan (canal, Q13) : « c'est ça nos mesures d'installation, on se
// fie aux axes ». Distincte d'une cote de FABRICATION (« FAB. »), qui dit la taille d'une pièce.
// Sur le plan ALUBASE : 47 cotes sur 1 093.
const DIM_POSE_RE = /\b(DOS\/MENEAU|F\/M-?RIDEAU|M\/FOND|F\/PONT|AXE)\b/i;
export const isPose = (s) => DIM_POSE_RE.test(s);

export function isDimension(s) {
  if (s.length > 44 || /[=]| X |\bX\b/i.test(s)) return false;
  if (DIM_FRAC_RE.test(s)) return true;
  const m = DIM_MARK_RE.exec(s);
  return !!m && DIM_TAIL_RE.test(s.slice(m[0].length));
}

export const normSheet = (s) => String(s).toUpperCase().replace(/[\s.]/g, '');
// Clé de feuille : le trait d'union ne compte pas. Un même plan écrit « A-300 » dans son cartouche
// et « A300 » dans un renvoi ; ce sont la même feuille. `normSheet` reste ce qu'on AFFICHE.
export const sheetKey = (s) => normSheet(s).replace(/-/g, '');
// Renvoi écrit sur une seule ligne : « 5/A-300 », « 5 / A300 », « A/A-301 ». Très répandu hors du
// bureau qui a dessiné nos trois plans — mais AUCUN de ces trois n'en contient un seul.
//
// Deux garde-fous, parce que cette écriture est aussi celle du renvoi de l'ARCHITECTE, écrit sous la
// bulle d'un détail (« 2/A-403 » sous le détail 17, vu sur le plan 25-012) : celui-là désigne le
// dessin d'origine de l'architecte, pas une destination dans notre jeu. Le suivre enverrait le poseur
// chercher un détail 2 sur une feuille qui porte les détails 29 à 40.
//   1. la feuille doit exister dans CE PDF ;
//   2. le détail doit exister SUR cette feuille — sinon le renvoi est jeté (voir section D).
// Le deuxième est plus strict que pour les renvois en deux parties, qui sont gardés même sans cible :
// là, la convention est certaine et l'app peut dire « étiquette introuvable ». Ici elle ne l'est pas.
const INLINE_RE = /^(\d{1,3}[A-Z]?|[A-Z])\s*\/\s*([A-Z]{0,3}-?\d{2,4}[A-Z]?)$/;
export const normKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
// Clé d'un nom de mur : comme normKey, et les zéros de tête des nombres tombent —
// vu sur un vrai plan : marqueur « PS-001 », élévation « PS-01 ».
export const wallKey = (s) => normKey(s).replace(/(^|[A-Z])0+(?=\d)/g, '$1');
const normDetail = (s) => String(s).toUpperCase().replace(/^0+(?=\d)/, '');

const cx = (it) => (it.x0 + it.x1) / 2;
const cy = (it) => (it.y0 + it.y1) / 2;

function findSheetItem(pg) {
  const { w, h, items } = pg;
  const cands = items.filter((it) => it.horiz && SHEET_RE.test(normSheet(it.s)));
  if (!cands.length) return null;
  const inCorner = cands.filter((it) => cx(it) > 0.8 * w && cy(it) > 0.8 * h);
  const inEdge = cands.filter((it) => cx(it) > 0.85 * w || cy(it) > 0.88 * h);
  const pool = inCorner.length ? inCorner : inEdge;
  if (!pool.length) return null;
  const label = items.find((it) => PAGE_LABEL_RE.test(it.s) && cx(it) > 0.6 * w && cy(it) > 0.6 * h);
  if (label) {
    let best = null, bestD = Infinity;
    for (const c of pool) {
      if (c.y1 < label.y0 - 2) continue; // jamais au-dessus de son libellé
      const d = Math.hypot(c.x0 - label.x0, cy(c) - cy(label));
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) return best;
  }
  // Sans libellé : le plus proche du coin inférieur droit.
  return pool.reduce((a, b) => (Math.hypot(w - cx(a), h - cy(a)) <= Math.hypot(w - cx(b), h - cy(b)) ? a : b));
}

function findTitle(pg, tzX, isBoilerplate) {
  let zone = pg.items.filter((it) => it.x0 >= tzX && it.horiz);
  // Numéro de feuille introuvable au bord droit (cartouche en bandeau bas, ou numérotation que je
  // ne sais pas lire) : plutôt qu'un titre vide, chercher dans la bande du bas.
  if (!zone.length) zone = pg.items.filter((it) => it.horiz && cy(it) > 0.8 * pg.h && !SHEET_RE.test(normSheet(it.s)));
  const label = zone.find((it) => TITLE_LABEL_RE.test(it.s));
  if (!label) {
    // Cartouche sans libellé « TITRE » lisible (vu sur le plan 26-018) : le titre est le bloc de
    // texte, plus gros que les libellés, posé juste au-dessus de « Chargé de projet / Dessiné par ».
    const after = zone.filter((it) => AFTER_TITLE_RE.test(it.s) && cy(it) > 0.8 * pg.h).sort((a, b) => a.y0 - b.y0)[0];
    if (!after) return '';
    // Le nom et l'adresse du projet sont écrits pareil, au même endroit, sur toutes les feuilles :
    // ce n'est pas le titre de CETTE feuille.
    const cands = zone.filter((it) => it.y1 <= after.y0 + 1 && it.size >= 1.2 * after.size && !/:\s*$/.test(it.s))
      .sort((a, b) => b.y0 - a.y0);
    const lire = (list) => {
      const lines = [];
      let edge = after.y0;
      for (const it of list) {
        // Premier écart (titre → libellé du dessous) : large. Ensuite : un simple interligne.
        if (edge - it.y1 > (lines.length ? 0.8 : 2.2) * it.size) break;
        lines.unshift(it.s); edge = it.y0;
      }
      return lines.join(' ').replace(/\s+/g, ' ').trim();
    };
    // Sans le texte répété d'abord ; mais si ce filtre ne laisse rien, mieux vaut un titre répété
    // qu'aucun titre — un jeu où trente feuilles s'appellent « DÉTAILS TYPIQUES » est ordinaire.
    return lire(cands.filter((it) => !isBoilerplate(it))) || lire(cands);
  }
  const below = zone
    .filter((it) => it.y0 >= label.y1 - 1 && it !== label)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out = [];
  for (const it of below) {
    if (AFTER_TITLE_RE.test(it.s)) break;
    if (it.y0 - label.y1 > pg.h * 0.06) break;
    out.push(it.s);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Taille de texte la plus fréquente : l'étalon « corps » de la page.
function bodySize(items) {
  const hist = new Map();
  for (const it of items) {
    if (it.src !== 't' || !it.horiz) continue;
    const k = Math.round(it.size * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let best = 0, bestN = 0;
  for (const [k, n] of hist) if (n > bestN) { best = k; bestN = n; }
  return best || 10;
}

// Partenaire centré juste au-dessus de `b`.
function findTop(b, items, used, isSheetName) {
  let best = null, bestDy = Infinity;
  for (const t of items) {
    if (t === b || !t.horiz || used.has(t)) continue;
    // Un texte qui nomme lui-même une feuille n'est jamais le « nom » d'un renvoi : dans une
    // liste de dessins, la ligne du dessus n'est pas l'étiquette de la ligne du dessous.
    if (isSheetName(t)) continue;
    const m = Math.min(t.size, b.size);
    const ratio = t.size / b.size;
    if (ratio < 0.6 || ratio > 1.7) continue;
    const dy = cy(b) - cy(t);
    if (dy < 0.45 * m || dy > 1.9 * m) continue;
    if (Math.abs(cx(t) - cx(b)) > 0.8 * m) continue;
    if (t.s.length > 12) continue;
    if (dy < bestDy) { bestDy = dy; best = t; }
  }
  return best;
}

function pad(r, p) {
  return { x0: r.x0 - p, y0: r.y0 - p, x1: r.x1 + p, y1: r.y1 + p };
}
function union(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function buildIndex(doc) {
  const pages = doc.pages;

  // ── A. numéro de feuille de chaque page ──────────────────────────────────
  const sheetItems = pages.map(findSheetItem);
  // Textes de cartouche répétés à l'identique (même texte, même place) sur la plupart des feuilles.
  const freq = new Map();
  const sig = (it) => `${it.s}@${Math.round(it.x0 / 6)},${Math.round(it.y0 / 6)}`;
  for (const pg of pages) for (const it of pg.items) if (it.x0 > 0.8 * pg.w) freq.set(sig(it), (freq.get(sig(it)) || 0) + 1);
  const isBoilerplate = (it) => pages.length >= 3 && (freq.get(sig(it)) || 0) >= Math.max(3, 0.6 * pages.length);
  const sheets = [];
  const sheetToPage = new Map();   // clé de feuille → indice de page
  const keyToId = new Map();       // clé de feuille → nom affiché
  pages.forEach((pg, i) => {
    const si = sheetItems[i];
    // `base` est le numéro tel qu'il est écrit ; `id` le distingue quand deux pages le partagent
    // (feuille révisée réémise, feuille continuée). Sans `base`, la deuxième page ne se reconnaissait
    // plus elle-même : ses traits de coupe devenaient des renvois vers la PREMIÈRE page.
    const base = si ? normSheet(si.s) : `P${i + 1}`;
    let id = base;
    const bk = sheetKey(base);
    if (sheetToPage.has(bk)) id = `${id} (p.${i + 1})`; // doublon : la première occurrence garde le nom
    else { sheetToPage.set(bk, i); keyToId.set(bk, id); }
    const tzX = si && si.x0 > 0.8 * pg.w ? si.x0 - 0.05 * pg.w : Infinity;
    sheets.push({ page: i, id, base, title: findTitle(pg, tzX, isBoilerplate), w: pg.w, h: pg.h, tzX });
  });

  // « 300 » → « A-300 », seulement si non ambigu.
  const shortMap = new Map();
  const shortSeen = new Map();
  for (const k of sheetToPage.keys()) {
    const m = k.match(/(\d{2,4})[A-Z]?$/);
    if (!m) continue;
    shortSeen.set(m[1], (shortSeen.get(m[1]) || 0) + 1);
    shortMap.set(m[1], k);
  }
  for (const [k, n] of shortSeen) if (n > 1) shortMap.delete(k);

  // ── B. renvois : tout texte qui nomme une feuille du document ────────────
  const out = pages.map(() => ({ hotspots: [], labels: [] }));
  const tops = pages.map(() => new Set());
  const orphans = [];

  pages.forEach((pg, i) => {
    const me = sheets[i];
    const used = tops[i];
    const seen = new Set();
    const selfPairs = []; // paires « N / cette feuille même » : trait de coupe OU titre de vue
    // Forme pleine d'abord : « A-201 » est un renvoi certain, il choisit son partenaire en premier.
    const refs = [];
    const inline = [];
    for (const b of pg.items) {
      if (!b.horiz) continue;
      const full = sheetKey(b.s);
      if (sheetToPage.has(full) && SHEET_RE.test(normSheet(b.s))) refs.push({ b, key: full, short: false });
      else if (SHORT_RE.test(b.s) && shortMap.has(b.s)) refs.push({ b, key: shortMap.get(b.s), short: true });
      else {
        // « 5/A-300 » : un seul texte porte le détail ET sa feuille.
        const m = b.s.toUpperCase().trim().match(INLINE_RE);
        if (m && sheetToPage.has(sheetKey(m[2]))) inline.push({ b, key: sheetKey(m[2]), detail: m[1] });
      }
    }
    refs.sort((a, b) => Number(a.short) - Number(b.short));

    for (const { b, key, short } of refs) {
      const sheet = keyToId.get(key);
      if (b.x0 >= me.tzX) continue; // cartouche
      const t = findTop(b, pg.items, used, (it) => sheetToPage.has(sheetKey(it.s)));
      const dm = t ? t.s.toUpperCase().match(DETAIL_TOP_RE) : null;
      const isDetail = !!dm;
      if (short && !isDetail) {
        orphans.push({ page: i, s: b.s, x: Math.round(cx(b)), y: Math.round(cy(b)) });
        continue; // « 300 » seul = une cote, pas un renvoi
      }
      if (!t && key === sheetKey(me.base)) continue; // la feuille qui se nomme elle-même
      if (t) used.add(t);
      let box;
      if (t) box = pad(union(t, b), 0.8 * b.size);
      else {
        // Renvoi nu, typiquement une ligne de la « liste des dessins » : le titre écrit à droite
        // sur la même ligne fait partie de la cible — une ligne large se touche mieux qu'un numéro.
        let row = b;
        for (const it of pg.items) {
          if (it === b || !it.horiz || it.x0 < b.x1 || it.x0 - b.x1 > 12 * b.size) continue;
          if (Math.abs(cy(it) - cy(b)) > 0.4 * b.size || Math.abs(it.size - b.size) > 0.2 * b.size) continue;
          row = union(row, it);
        }
        box = { x0: row.x0 - 0.8 * b.size, x1: row.x1 + 0.8 * b.size, y0: row.y0 - 0.3 * b.size, y1: row.y1 + 0.3 * b.size };
      }
      const cle = `${Math.round(cx(box) / 4)}:${Math.round(cy(box) / 4)}:${sheet}`;
      if (seen.has(cle)) continue;
      seen.add(cle);
      const hs = { ...box, sheet, page: sheetToPage.get(key) };
      if (isDetail) { hs.kind = 'detail'; hs.detail = normDetail(dm[1]); if (dm[2]) hs.note = dm[2]; }
      else { hs.kind = 'sheet'; hs.label = t ? t.s : null; }
      out[i].hotspots.push(hs);
      if (isDetail && key === sheetKey(me.base)) selfPairs.push({ hs, t, b });
    }

    for (const { b, key, detail } of inline) {
      const box = pad(b, 0.6 * b.size);
      const k2 = `${Math.round(cx(box) / 4)}:${Math.round(cy(box) / 4)}:${key}`;
      if (seen.has(k2)) continue;
      seen.add(k2);
      out[i].hotspots.push({ ...box, sheet: keyToId.get(key), page: sheetToPage.get(key),
        kind: 'detail', detail: normDetail(detail), inline: true });
    }

    // Certains bureaux titrent une vue avec la même écriture qu'un renvoi : « A / A-200 » sous la
    // coupe A, sur A-200 même, suivi de « RÉF: ». Le trait de coupe, plus haut, s'écrit pareil.
    // Le titre est la CIBLE, pas un renvoi. On le reconnaît à son « RÉF: » ; à défaut, c'est la
    // paire la plus basse (un titre se pose sous sa vue). S'il existe ailleurs sur la feuille une
    // vraie grosse étiquette du même nom, toutes ces paires sont des renvois et on ne touche à rien.
    const groups = new Map();
    for (const sp of selfPairs) {
      if (!groups.has(sp.hs.detail)) groups.set(sp.hs.detail, []);
      groups.get(sp.hs.detail).push(sp);
    }
    // Un titre de vue est accompagné de son échelle ou de sa référence (« ÉCHELLE: 3/16" = 1' »,
    // « RÉF: N/A »), dessous ou à droite. Un trait de coupe ne l'est jamais.
    const hasRefBelow = (b) => pg.items.some((r) => /^(R[ÉE]F|[ÉE]CH(ELLE)?|SCALE)\b/i.test(r.s) && r.y0 >= b.y0 - b.size &&
      cy(r) - cy(b) < 3 * Math.max(b.size, 8) && cx(r) - cx(b) > -5 * Math.max(b.size, 8) && cx(r) - cx(b) < 12 * Math.max(b.size, 8));
    for (const [n, members] of groups) {
      let title = members.find((m) => hasRefBelow(m.b));
      if (!title) {
        // Sans « RÉF: » : on ne conclut que s'il n'existe pas ailleurs une vraie grosse étiquette du
        // même nom. « Grosse » = nettement plus que le renvoi ; un fragment de cote ne compte pas.
        const bigger = pg.items.some((it) => it.horiz && it.x0 < me.tzX && !used.has(it) &&
          DETAIL_RE.test(it.s.toUpperCase()) && normDetail(it.s.toUpperCase()) === n && it.size >= 1.5 * members[0].t.size);
        if (bigger) continue;
        // Une ligne de coupe porte souvent une bulle à CHACUNE de ses deux extrémités. Sans indice
        // d'échelle, rien ne dit laquelle est le titre : on s'abstient, et l'app dit au poseur que
        // l'étiquette est introuvable — plutôt que de l'envoyer avec assurance au mauvais endroit.
        if (members.length > 1) continue;
        title = members[0];
      }
      out[i].hotspots.splice(out[i].hotspots.indexOf(title.hs), 1);
      const { x0, y0, x1, y1 } = title.hs;
      out[i].labels.push({ kind: 'detail', n, refs: 0, titleMark: true, x0, y0, x1, y1 });
    }
  });

  // ── C. cibles : étiquettes de détail et noms de mur sur les feuilles visées ──
  // Étalon au niveau du document : une page peut être dominée par du texte minuscule
  // (numéros de locaux de la vue d'ensemble) et fausser le rapport de tailles.
  const perPage = pages.map((pg) => bodySize(pg.items)).sort((a, b) => a - b);
  const docBody = perPage[Math.floor(perPage.length / 2)] || 10;

  function detailCandidates(i) {
    const me = sheets[i];
    return pages[i].items.filter((it) =>
      it.horiz && it.x0 < me.tzX && DETAIL_RE.test(it.s.toUpperCase()) && !tops[i].has(it));
  }
  function bestBySize(list) {
    return list.reduce((a, b) => (b.size > a.size ? b : a), list[0]);
  }
  // Un numéro posé juste à gauche d'un titre de vue (« 06  DÉTAIL EN COUPE ») est une étiquette,
  // à coup sûr. Vu sur le plan 26-018 : un gros « 6 » isolé ailleurs sur la feuille gagnait à la taille.
  // Un titre de vue ne commence pas toujours par « DÉTAIL » : « TÊTE ET SEUIL », « JAMB DETAIL »,
  // « JONCTION TYPIQUE ». Le mot peut être n'importe où dans la ligne, et en anglais.
  const VIEW_TITLE_RE = /(^|[\s(])(D[ÉE]TAIL|COUPE|SECTION|[ÉE]L[ÉE]VATION|PLAN|VUE|VIEW|HEAD|JAMB|SILL|T[ÊE]TE|SEUIL|JONCTION|APPUI)S?\b/i;
  const viewTitles = (i) => pages[i].items.filter((tt) => tt.horiz && tt.x0 < sheets[i].tzX &&
    tt.size >= 1.15 * docBody && VIEW_TITLE_RE.test(tt.s));
  const titledBy = (titles, it) => titles.some((tt) => tt !== it &&
    Math.abs(cy(tt) - cy(it)) < 1.6 * tt.size && tt.x0 > cx(it) - it.size && tt.x0 - cx(it) < 4 * tt.size);
  // Un numéro posé juste à gauche d'un titre de vue est une étiquette, à coup sûr : il gagne contre
  // un chiffre isolé plus gros ailleurs sur la feuille (un fragment de cote, un repère de pièce).
  function bestLabel(list, titles) {
    return list.map((it) => ({ it, sc: it.size * (titledBy(titles, it) ? 1.5 : 1) }))
      .reduce((a, b) => (b.sc > a.sc ? b : a)).it;
  }

  const refCount = new Map(); // « page|détail » → nombre de renvois
  for (const p of out) for (const hs of p.hotspots) {
    if (hs.kind !== 'detail') continue;
    const k = `${hs.page}|${hs.detail}`;
    refCount.set(k, (refCount.get(k) || 0) + 1);
  }

  pages.forEach((pg, i) => {
    const cands = detailCandidates(i);
    const byN = new Map();
    for (const c of cands) {
      const n = normDetail(c.s);
      if (!byN.has(n)) byN.set(n, []);
      byN.get(n).push(c);
    }
    const titled = new Set();
    for (const l of out[i].labels) {
      if (l.kind !== 'detail') continue;
      titled.add(l.n); l.refs = refCount.get(`${i}|${l.n}`) || 0;
    }
    const vTitles = viewTitles(i);
    for (const [n, list] of byN) {
      if (titled.has(n)) continue;
      const refs = refCount.get(`${i}|${n}`) || 0;
      const top = bestLabel(list, vTitles);
      // Étiquette retenue si elle est visée par un renvoi et plus grosse que le corps,
      // ou si elle est franchement grosse (≥ 1,8 × le corps) même sans renvoi.
      const big = top.size >= 1.8 * docBody && /\d/.test(n);
      const okRef = refs > 0 && top.size >= 1.15 * docBody;
      if (!big && !okRef) continue;
      // Le MÊME numéro peut être dessiné plusieurs fois sur une feuille : sur le plan 25-012, les
      // détails 38 et 39 de A-403 le sont deux fois (un jambage et son miroir). Ne garder que le
      // premier envoyait le poseur sur un meneau coté 2 9/16" au lieu de 1 9/16" — un pouce d'écart,
      // lu avec confiance. On garde donc toutes les bulles de même taille que la meilleure.
      // Mais pas n'importe laquelle : si la meilleure est posée contre un titre de vue, alors une
      // vraie bulle jumelle l'est aussi. Sans cette réserve, les trois repères de pièce « 6 100 » du
      // plan VERDIER — même corps que les vrais numéros — redeviendraient des cibles (P21d).
      const topTitre = titledBy(vTitles, top);
      for (const it of list) {
        if (it !== top) {
          if (topTitre ? !titledBy(vTitles, it) : it.size < top.size * 0.9) continue;
        }
        out[i].labels.push({ kind: 'detail', n, refs, ...pad(it, 0.6 * it.size) });
      }
    }
    // Bulle de titre laissée VIDE par le dessinateur (vu sur le plan 26-018 : « DÉTAIL EN PLAN »
    // sans son « 01 »). On ne déduit que dans un seul cas, sans ambiguïté possible : sur la feuille,
    // UN seul numéro est appelé sans avoir d'étiquette, et UN seul titre de vue n'a pas de numéro.
    // L'étiquette est marquée `inferred` : l'app le dira au poseur au lieu de faire comme si de rien.
    const have = out[i].labels.filter((l) => l.kind === 'detail');
    const missing = [...refCount.keys()].filter((k) => k.startsWith(`${i}|`)).map((k) => k.slice(String(i).length + 1))
      .filter((n) => !have.some((l) => l.n === n));
    if (missing.length === 1 && have.length >= 2) {
      const me = sheets[i];
      const titles = vTitles;
      const owner = (tt) => have.find((l) => Math.abs(cy(l) - cy(tt)) < 1.6 * tt.size && cx(l) < tt.x0 + tt.size && tt.x0 - cx(l) < 4 * tt.size);
      const paired = titles.filter((tt) => owner(tt)), orphan = titles.filter((tt) => !owner(tt));
      if (orphan.length === 1 && paired.length >= 2) {
        const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
        const dx = med(paired.map((tt) => cx(owner(tt)) - tt.x0)), dy = med(paired.map((tt) => cy(owner(tt)) - cy(tt)));
        const r = med(paired.map((tt) => (owner(tt).x1 - owner(tt).x0) / 2));
        const ox = orphan[0].x0 + dx, oy = cy(orphan[0]) + dy;
        out[i].labels.push({ kind: 'detail', n: missing[0], refs: refCount.get(`${i}|${missing[0]}`) || 0,
          inferred: true, x0: ox - r, y0: oy - r, x1: ox + r, y1: oy + r });
      }
    }
    out[i].labels.sort((a, b) => (parseInt(a.n, 10) - parseInt(b.n, 10)) || a.n.localeCompare(b.n));
  });

  // Noms de mur : pour chaque renvoi « MR03 → A-201 », chercher « MR-03 » sur A-201.
  const walls = new Map();
  for (const p of out) for (const hs of p.hotspots) {
    if (hs.kind !== 'sheet' || !hs.label) continue;
    const k = wallKey(hs.label);
    if (k.length < 2) continue;
    if (!walls.has(k)) walls.set(k, { label: hs.label, targets: new Map() });
    walls.get(k).targets.set(hs.page, hs.sheet);
  }
  // Familles de noms apprises des marqueurs (« MR ») : un mur dessiné en élévation peut
  // n'avoir AUCUN marqueur sur la vue d'ensemble (vu sur un vrai plan : MR-05B, MR-07B).
  const families = new Set();
  for (const wl of walls.values()) {
    const m = String(wl.label).toUpperCase().match(WALL_RAW_RE);
    if (m) families.add(m[1]);
  }
  // Cherché sur toutes les pages, pas seulement la feuille visée : un marqueur peut aussi se
  // tromper de feuille (vu sur le même plan : « MR02B → A-200 », dessiné sur A-201).
  pages.forEach((pg, pi) => {
    const me = sheets[pi];
    const byKey = new Map();
    for (const it of pg.items) {
      if (!it.horiz || it.x0 >= me.tzX || tops[pi].has(it)) continue;
      const k = wallKey(it.s);
      if (k.length < 2) continue;
      const m = it.s.toUpperCase().trim().match(WALL_RAW_RE);
      if (!walls.has(k) && !(m && families.has(m[1]))) continue;
      // Gros corps : un cercle de titre, accepté partout. Petit corps (vu sur le plan 26-018, « MR1 »
      // en corps 13) : accepté seulement sur la feuille qu'un marqueur annonce pour ce mur.
      const announced = walls.has(k) && walls.get(k).targets.has(pi);
      if (it.size < 1.3 * docBody && !(announced && it.size >= 0.9 * docBody)) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
    for (const [k, list] of byKey) {
      const top = bestBySize(list);
      out[pi].labels.push({ kind: 'wall', n: k, text: top.s, refs: 0, ...pad(top, 0.6 * top.size) });
      if (!walls.has(k)) walls.set(k, { label: top.s, targets: new Map() });
    }
  });

  // ── D. brancher chaque renvoi sur sa cible ───────────────────────────────
  let resolved = 0, unresolved = 0, jetes = 0;
  for (const p of out) for (const hs of p.hotspots) {
    const labels = out[hs.page].labels;
    let tgt = null;
    if (hs.kind === 'detail') {
      const tous = labels.filter((l) => l.kind === 'detail' && l.n === hs.detail);
      tgt = tous[0];
      // Deux dessins portent le même numéro sur la feuille visée : rien dans le renvoi ne dit
      // lequel. On les donne tous les deux plutôt que de choisir — l'app demandera.
      if (tous.length > 1) hs.targets = tous.map((l) => ({ x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }));
    }
    else if (hs.label) {
      const k = wallKey(hs.label);
      tgt = labels.find((l) => l.kind === 'wall' && l.n === k);
      if (!tgt) {
        // Absent de la feuille annoncée, présent sur une seule autre : le marqueur se trompe.
        const elsewhere = [];
        out.forEach((op, pi) => { const l = op.labels.find((x) => x.kind === 'wall' && x.n === k); if (l) elsewhere.push([pi, l]); });
        const readable = labels.some((l) => l.kind === 'wall');
        if (elsewhere.length === 1 && readable) {
          const [pi, l] = elsewhere[0];
          hs.alt = { page: pi, sheet: sheets[pi].id, target: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 } };
          l.refs++;
        }
      }
    }
    if (!tgt && hs.inline) { hs.jeter = true; continue; }   // voir INLINE_RE : sans cible, on n'affirme rien
    if (tgt) {
      hs.target = { x0: tgt.x0, y0: tgt.y0, x1: tgt.x1, y1: tgt.y1 };
      if (tgt.inferred) hs.inferred = true;
      if (hs.kind === 'sheet') tgt.refs++;
      resolved++;
    } else if (hs.kind === 'detail') unresolved++;
  }

  // ── E. les cotes, pour la loupe : position, angle et corps de chaque mesure ──
  const r1 = (v) => Math.round(v * 10) / 10;
  pages.forEach((pg, i) => {
    const me = sheets[i];
    out[i].dims = pg.items
      .filter((it) => it.x0 < me.tzX && !tops[i].has(it) && isDimension(it.s.trim()))
      .map((it) => {
        const d = { s: it.s.trim(), x: r1(cx(it)), y: r1(cy(it)), a: Math.round((it.ang || 0) * 1000) / 1000, h: r1(it.size) };
        if (isPose(d.s)) d.pose = 1;
        return d;
      })
      // L'ordre décide qui gagne la place quand deux cotes se disputent le même espace :
      // d'abord les cotes d'installation, puis la plus petite — celle qui a le plus besoin de la
      // loupe. Trié ici une fois pour toutes : le rapport des tailles ne change pas avec le zoom,
      // donc l'ordre reste juste à l'écran sans rien recalculer à chaque image.
      .sort((a, b) => (b.pose || 0) - (a.pose || 0) || a.h - b.h);
  });

  for (const p of out) {
    const n = p.hotspots.length;
    p.hotspots = p.hotspots.filter((hs) => !hs.jeter);
    jetes += n - p.hotspots.length;
  }

  // Où aller pour chaque mur : les feuilles où son nom est réellement dessiné ; à défaut,
  // celles qu'annoncent les marqueurs.
  const wallList = [...walls.entries()].map(([k, wl]) => {
    const places = [];
    out.forEach((op, pi) => {
      const l = op.labels.find((x) => x.kind === 'wall' && x.n === k);
      if (l) places.push({ page: pi, sheet: sheets[pi].id, target: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 } });
    });
    // Un « MR1 » écrit en gros sur la feuille des détails n'est pas l'élévation de MR1.
    const announced = places.filter((pl) => wl.targets.has(pl.page));
    if (announced.length) places.splice(0, places.length, ...announced);
    if (!places.length) for (const [page, sheet] of wl.targets) places.push({ page, sheet, target: null });
    const text = places.length && places[0].target
      ? out[places[0].page].labels.find((x) => x.kind === 'wall' && x.n === k).text : wl.label;
    return { key: k, label: text, places };
  }).sort((a, b) => a.key.localeCompare(b.key, 'fr', { numeric: true }));

  // La vue d'ensemble : la première feuille qui porte au moins trois marqueurs de mur.
  let home = 0;
  for (let i = 0; i < out.length; i++) {
    if (out[i].hotspots.filter((hs) => hs.kind === 'sheet' && hs.label).length >= 3) { home = i; break; }
  }

  return {
    version: DETECT_VERSION,
    home,
    sheets: sheets.map(({ tzX, base, ...rest }) => rest),
    pages: out,
    walls: wallList,
    stats: {
      pages: pages.length,
      hotspots: out.reduce((n, p) => n + p.hotspots.length, 0),
      detailRefs: out.reduce((n, p) => n + p.hotspots.filter((hs) => hs.kind === 'detail').length, 0),
      sheetRefs: out.reduce((n, p) => n + p.hotspots.filter((hs) => hs.kind === 'sheet').length, 0),
      labels: out.reduce((n, p) => n + p.labels.length, 0),
      dims: out.reduce((n, p) => n + p.dims.length, 0),
      resolved, unresolved, jetes,
      orphans,
    },
  };
}
