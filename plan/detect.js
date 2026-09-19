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
export const DETECT_VERSION = 2;

const SHEET_RE = /^[A-Z]{1,3}[-. ]?\d{2,4}[A-Z]?$/;
const DETAIL_RE = /^\d{1,3}[A-Z]?$/;
// Le haut d'un renvoi peut porter une mention : « 10 INV. » = détail 10, inversé.
const DETAIL_TOP_RE = /^(\d{1,3}[A-Z]?)\s*(INV|SIM|TYP|OPP|MIR)?\.?$/;
const SHORT_RE = /^\d{2,4}$/;
// Un nom de mur tel qu'écrit dans un cercle de titre : « MR-07B », « MR03 ». Jamais de point (« C.4 » = axe).
const WALL_RAW_RE = /^([A-Z]{2,4})-?(\d{1,3})[A-Z]?$/;
const PAGE_LABEL_RE = /(N[O°]\.?\s*DE\s*PAGE|N[O°]\.?\s*(DE\s*)?FEUILLE|SHEET\s*(NO|NUM|#)|DWG\.?\s*(NO|NUM|#)|DESSIN\s*N[O°])/i;
const TITLE_LABEL_RE = /^(TITRE(\s*DU\s*DESSIN)?|DRAWING\s*TITLE|SHEET\s*TITLE)\s*:?$/i;
const AFTER_TITLE_RE = /(DESSIN[ÉE]\s*PAR|CHARG[ÉE]|DRAWN|CHECKED|V[ÉE]RIFI[ÉE]|DIMENSION|[ÉE]CHELLE|SCALE)/i;

export const normSheet = (s) => String(s).toUpperCase().replace(/[\s.]/g, '');
export const normKey = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
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

function findTitle(pg, tzX) {
  const zone = pg.items.filter((it) => it.x0 >= tzX && it.horiz);
  const label = zone.find((it) => TITLE_LABEL_RE.test(it.s));
  if (!label) return '';
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
function findTop(b, items, used) {
  let best = null, bestDy = Infinity;
  for (const t of items) {
    if (t === b || !t.horiz || used.has(t)) continue;
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
  const sheets = [];
  const sheetToPage = new Map();
  pages.forEach((pg, i) => {
    const si = sheetItems[i];
    let id = si ? normSheet(si.s) : `P${i + 1}`;
    if (sheetToPage.has(id)) id = `${id} (p.${i + 1})`; // doublon : la première occurrence garde le nom
    else sheetToPage.set(id, i);
    const tzX = si && si.x0 > 0.8 * pg.w ? si.x0 - 0.05 * pg.w : Infinity;
    sheets.push({ page: i, id, title: findTitle(pg, tzX), w: pg.w, h: pg.h, tzX });
  });

  // « 300 » → « A-300 », seulement si non ambigu.
  const shortMap = new Map();
  const shortSeen = new Map();
  for (const id of sheetToPage.keys()) {
    const m = id.match(/(\d{2,4})[A-Z]?$/);
    if (!m) continue;
    shortSeen.set(m[1], (shortSeen.get(m[1]) || 0) + 1);
    shortMap.set(m[1], id);
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
    // Forme pleine d'abord : « A-201 » est un renvoi certain, il choisit son partenaire en premier.
    const refs = [];
    for (const b of pg.items) {
      if (!b.horiz) continue;
      const full = normSheet(b.s);
      if (sheetToPage.has(full) && SHEET_RE.test(full)) refs.push({ b, sheet: full, short: false });
      else if (SHORT_RE.test(b.s) && shortMap.has(b.s)) refs.push({ b, sheet: shortMap.get(b.s), short: true });
    }
    refs.sort((a, b) => Number(a.short) - Number(b.short));

    for (const { b, sheet, short } of refs) {
      if (b.x0 >= me.tzX) continue; // cartouche
      const t = findTop(b, pg.items, used);
      const dm = t ? t.s.toUpperCase().match(DETAIL_TOP_RE) : null;
      const isDetail = !!dm;
      if (short && !isDetail) {
        orphans.push({ page: i, s: b.s, x: Math.round(cx(b)), y: Math.round(cy(b)) });
        continue; // « 300 » seul = une cote, pas un renvoi
      }
      if (!t && sheet === me.id) continue; // la feuille qui se nomme elle-même
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
      const key = `${Math.round(cx(box) / 4)}:${Math.round(cy(box) / 4)}:${sheet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hs = { ...box, sheet, page: sheetToPage.get(sheet) };
      if (isDetail) { hs.kind = 'detail'; hs.detail = normDetail(dm[1]); if (dm[2]) hs.note = dm[2]; }
      else { hs.kind = 'sheet'; hs.label = t ? t.s : null; }
      out[i].hotspots.push(hs);
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
    for (const [n, list] of byN) {
      const refs = refCount.get(`${i}|${n}`) || 0;
      const top = bestBySize(list);
      // Étiquette retenue si elle est visée par un renvoi et plus grosse que le corps,
      // ou si elle est franchement grosse (≥ 1,8 × le corps) même sans renvoi.
      const big = top.size >= 1.8 * docBody;
      const okRef = refs > 0 && top.size >= 1.15 * docBody;
      if (!big && !okRef) continue;
      out[i].labels.push({ kind: 'detail', n, refs, ...pad(top, 0.6 * top.size) });
    }
    out[i].labels.sort((a, b) => (parseInt(a.n, 10) - parseInt(b.n, 10)) || a.n.localeCompare(b.n));
  });

  // Noms de mur : pour chaque renvoi « MR03 → A-201 », chercher « MR-03 » sur A-201.
  const walls = new Map();
  for (const p of out) for (const hs of p.hotspots) {
    if (hs.kind !== 'sheet' || !hs.label) continue;
    const k = normKey(hs.label);
    if (!k) continue;
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
      if (!it.horiz || it.x0 >= me.tzX || tops[pi].has(it) || it.size < 1.3 * docBody) continue;
      const k = normKey(it.s);
      if (!k) continue;
      const m = it.s.toUpperCase().trim().match(WALL_RAW_RE);
      if (!walls.has(k) && !(m && families.has(m[1]))) continue;
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
  let resolved = 0, unresolved = 0;
  for (const p of out) for (const hs of p.hotspots) {
    const labels = out[hs.page].labels;
    let tgt = null;
    if (hs.kind === 'detail') tgt = labels.find((l) => l.kind === 'detail' && l.n === hs.detail);
    else if (hs.label) {
      const k = normKey(hs.label);
      tgt = labels.find((l) => l.kind === 'wall' && l.n === k);
      if (!tgt) {
        // Absent de la feuille annoncée, présent sur une seule autre : le marqueur se trompe.
        const elsewhere = [];
        out.forEach((op, pi) => { const l = op.labels.find((x) => x.kind === 'wall' && x.n === k); if (l) elsewhere.push([pi, l]); });
        if (elsewhere.length === 1) {
          const [pi, l] = elsewhere[0];
          hs.alt = { page: pi, sheet: sheets[pi].id, target: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 } };
          l.refs++;
        }
      }
    }
    if (tgt) {
      hs.target = { x0: tgt.x0, y0: tgt.y0, x1: tgt.x1, y1: tgt.y1 };
      if (hs.kind === 'sheet') tgt.refs++;
      resolved++;
    } else if (hs.kind === 'detail') unresolved++;
  }

  // Où aller pour chaque mur : les feuilles où son nom est réellement dessiné ; à défaut,
  // celles qu'annoncent les marqueurs.
  const wallList = [...walls.entries()].map(([k, wl]) => {
    const places = [];
    out.forEach((op, pi) => {
      const l = op.labels.find((x) => x.kind === 'wall' && x.n === k);
      if (l) places.push({ page: pi, sheet: sheets[pi].id, target: { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 } });
    });
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
    sheets: sheets.map(({ tzX, ...rest }) => rest),
    pages: out,
    walls: wallList,
    stats: {
      pages: pages.length,
      hotspots: out.reduce((n, p) => n + p.hotspots.length, 0),
      detailRefs: out.reduce((n, p) => n + p.hotspots.filter((hs) => hs.kind === 'detail').length, 0),
      sheetRefs: out.reduce((n, p) => n + p.hotspots.filter((hs) => hs.kind === 'sheet').length, 0),
      labels: out.reduce((n, p) => n + p.labels.length, 0),
      resolved, unresolved,
      orphans,
    },
  };
}
