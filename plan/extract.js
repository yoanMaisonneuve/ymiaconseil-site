// extract.js — une page pdf.js → liste plate d'éléments de texte positionnés.
//
// Deux sources, fusionnées dans le même format :
//   1. le texte réel du PDF (polices TrueType : numéros de détail, cotes, cartouche) ;
//   2. les annotations « Square » qu'AutoCAD ajoute pour chaque texte SHX tracé en
//      géométrie (marqueurs MR03 / A-201 de la vue d'ensemble, renvois d'architecte).
//      Invisibles à l'écran, mais elles portent le texte et son rectangle.
//
// Coordonnées de sortie : espace « viewport » à l'échelle 1, origine en haut à gauche,
// y vers le bas — le même repère que le rendu, donc directement superposable.
//
// Module pur : aucun accès au DOM. Tourne tel quel dans Node pour les tests.

function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function textItemToBox(it, vpTransform) {
  const tx = mul(vpTransform, it.transform);
  const ux = tx[0], uy = tx[1];          // direction de la ligne de base
  const vx = tx[2], vy = tx[3];          // direction « vers le haut » du glyphe
  const ulen = Math.hypot(ux, uy) || 1;
  const vlen = Math.hypot(vx, vy) || 1;
  const size = vlen;
  const w = it.width || 0;
  const h = it.height || size;
  const ox = tx[4], oy = tx[5];
  const bx = (ux / ulen) * w, by = (uy / ulen) * w;
  const hx = (vx / vlen) * h, hy = (vy / vlen) * h;
  const xs = [ox, ox + bx, ox + hx, ox + bx + hx];
  const ys = [oy, oy + by, oy + hy, oy + by + hy];
  // Horizontal = ligne de base à moins de ~8° de l'axe x, non renversée.
  const horiz = Math.abs(uy) <= Math.abs(ux) * 0.14 && ux > 0;
  return {
    x0: Math.min(...xs), y0: Math.min(...ys),
    x1: Math.max(...xs), y1: Math.max(...ys),
    size, horiz,
    ang: Math.atan2(uy, ux),   // angle de la ligne de base, repère écran (y vers le bas)
  };
}

// Texte posé par l'OCR de PlanJump (planjump/ocr/pdftext.js) sur un plan imprimé en image. Sa
// « taille » est la hauteur de la boîte que le détecteur DB a trouvée, pas un corps de police. Or ce
// détecteur décolle la boîte du noyau de texte d'une distance d = aire × 1,6 / périmètre : pour un
// mot long, d ≈ 0,8 × la hauteur du noyau ; pour une lettre seule, bien moins. Résultat mesuré sur
// le plan Westbury : la lettre d'une bulle de coupe (« D » au-dessus de « A-203 ») sort à 0,36–0,58
// fois le corps du numéro de feuille qu'elle surmonte, écrit pourtant à la même hauteur. detect.js
// la rejetait (il exige 0,6), et les noms de mur courts (« MR6 ») passaient sous son seuil.
//
// On refait donc le calcul du moteur à l'envers : la boîte (longueur L, hauteur H) donne d, puis la
// hauteur du noyau h = H − 2d, et on rend h × 2,6 — la hauteur qu'aurait la boîte d'un mot long de
// même noyau. Un mot long garde sa taille ; un mot court retrouve la sienne.
//   L = l + 2d, H = h + 2d, d = r·l·h / 2(l + h)  ⇒  (8 + 4r)d² − 2(1 + r)(L + H)d + r·L·H = 0
const OCR_UNCLIP = 1.6;   // planjump/ocr/engine.js, DEFAULTS.unclipRatio
export function ocrTextSize(len, size) {
  const r = OCR_UNCLIP, a = 8 + 4 * r, b = 2 * (1 + r) * (len + size), c = r * len * size;
  const disc = b * b - 4 * a * c;
  if (!(len > 0) || !(size > 0) || disc < 0) return size;
  const d = (b - Math.sqrt(disc)) / (2 * a);
  const h = size - 2 * d;
  return h > 0 ? Math.max(size, h * (1 + r)) : size;
}

// Plan RÉIMPOSÉ (vu sur le plan 26-006 Fleetwood, 28.10) : un outil a posé chaque feuille de 36 × 24 po
// dans une page A4, par une transformation en tête du contenu (« .2296 0 0 .2296 0 222.17 cm »). Le dessin
// a suivi ; les annotations SHX, non : leurs rectangles sont restés dans le repère de la feuille d'origine.
// Lues telles quelles, elles tombaient hors de la page ou au mauvais endroit — « MR5.1 » devenait le numéro
// de la feuille A-202, et tous les renvois vers A-202, A-203, A-205… disparaissaient.
// On le reconnaît à des annotations HORS de la page. La transformation de tête du contenu les recale, à
// deux conditions : elle les ramène toutes, ou presque, dans la page, et elle leur donne la taille du texte
// de la feuille. La deuxième écarte la tête d'un plan AutoCAD ordinaire (« 0.06 0 0 0.06 14 48 cm »,
// son unité de dessin), qui ramènerait aussi tout dans la page — écrasé dans un coin. Faute de calage, on
// jette les annotations qui sortent de la page : pas de cible vaut mieux qu'une cible au mauvais endroit.
//
// Codes d'opération de pdf.js (`OPS`), stables depuis des années, vérifiés au banc sur pdfjs-dist 6.3.289.
const OP_TRANSFORM = 12;
// Ce qui peut précéder la transformation sans rien dessiner : dependency, setGState, save, restore,
// endPath, clip, eoClip, contenu marqué, constructPath (le rectangle de découpe de la page).
const OP_NEUTRES = new Set([1, 9, 10, 11, 28, 29, 30, 69, 70, 71, 91]);

async function teteDuContenu(page) {
  let ol;
  try {
    ol = await page.getOperatorList({ intent: 'display' });
  } catch {
    return null;
  }
  let m = null;
  for (let k = 0; k < Math.min(ol.fnArray.length, 12); k++) {
    if (ol.fnArray[k] === OP_TRANSFORM) { m = Array.from(ol.argsArray[k]); break; }
    if (!OP_NEUTRES.has(ol.fnArray[k])) break;
  }
  page.cleanup();   // la liste d'opérations d'une feuille pèse lourd ; le rendu la refera
  return m;
}

const mediane = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

async function corpsDe(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return mediane(tc.items.filter((it) => it.str && it.str.trim()).map((it) => textItemToBox(it, vp.transform).size));
}

const appliquer = (m, r) => {
  const xs = [], ys = [];
  for (const [x, y] of [[r[0], r[1]], [r[2], r[1]], [r[0], r[3]], [r[2], r[3]]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const dansLaPage = (r, v) => {
  const x = (r[0] + r[2]) / 2, y = (r[1] + r[3]) / 2;
  return x >= Math.min(v[0], v[2]) && x <= Math.max(v[0], v[2]) && y >= Math.min(v[1], v[3]) && y <= Math.max(v[1], v[3]);
};

async function lireNotes(page) {
  let annots = [];
  try {
    annots = await page.getAnnotations({ intent: 'display' });
  } catch {
    annots = [];
  }
  const notes = [];
  for (const a of annots) {
    const raw = (a.contentsObj && a.contentsObj.str) || a.contents || '';
    const s = String(raw).trim();
    if (!s || !a.rect || s.length > 60) continue;
    notes.push({ s, rect: a.rect });
  }
  return notes;
}

// Le rectangle d'un commentaire SHX épouse le texte : sa hauteur tient lieu de corps (voir `tall` plus bas).
const hauteur = (r, s) => { const w = r[2] - r[0], h = r[3] - r[1]; return h > w * 1.2 && s.length > 1 ? w : h; };

// Ce que donne la transformation `m` (null : telles quelles) : assez d'annotations dans la page ? Et quel
// écart entre leur corps et celui du texte de la feuille (en log : 0 = même corps) ?
function essai(m, notes, v, corps) {
  const rs = notes.map((n) => ({ r: m ? appliquer(m, n.rect) : n.rect, s: n.s }));
  const h = mediane(rs.map((x) => hauteur(x.r, x.s)));
  return {
    m,
    dedans: rs.filter((x) => dansLaPage(x.r, v)).length >= 0.9 * notes.length,
    ecart: corps > 0 && h > 0 ? Math.abs(Math.log(h / corps)) : Infinity,
  };
}

// La transformation à appliquer aux annotations de cette page, ou null : telles quelles.
// `ctx.calage` : celle trouvée sur une autre feuille du même document (le même outil les a toutes posées).
// Elle sert aussi quand toutes les annotations tombent dans la page PAR HASARD (le coin bas-gauche de la
// feuille d'origine recouvre la page A4) : le corps du texte départage.
async function calage(page, notes, ctx, corps) {
  if (!notes.length) return null;
  const v = page.view;
  const cands = [essai(null, notes, v, corps)];
  if (ctx.calage) cands.push(essai(ctx.calage, notes, v, corps));
  if (!cands.some((c) => c.dedans) && (ctx.essais || 0) < 3) {
    ctx.essais = (ctx.essais || 0) + 1;    // une liste d'opérations par feuille coûte cher : trois essais au plus
    const m = await teteDuContenu(page);
    if (m) cands.push(essai(m, notes, v, corps));
  }
  // Telles quelles d'abord ; un calage ne gagne qu'avec le corps du texte (à 4 × près) et nettement plus juste.
  let best = cands[0].dedans ? cands[0] : null;
  for (const c of cands.slice(1)) {
    if (!c.dedans || c.ecart > Math.log(4)) continue;
    if (!best || c.ecart < best.ecart - 0.1) best = c;
  }
  if (!best || !best.m) return null;
  if (!ctx.calage) ctx.calage = best.m;
  return best.m;
}

export async function extractPage(page, ctx = {}) {
  const vp = page.getViewport({ scale: 1 });
  const items = [];

  // Un mot de l'OCR est seul dans une séquence marquée « /Span BMC » sans propriétés (pdftext.js) ;
  // un PDF natif n'en a pas (mesuré : 0 sur nos plans vectoriels). La page doit en être faite
  // presque entièrement : un Span isolé dans un PDF balisé ne suffit pas.
  const tc = await page.getTextContent({ includeMarkedContent: true });
  const open = [];
  const texts = [];
  for (const it of tc.items) {
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      open.push(it.type === 'beginMarkedContent' && it.tag === 'Span');
      continue;
    }
    if (it.type === 'endMarkedContent') { open.pop(); continue; }
    if (!it.str) continue;
    const s = it.str.trim();
    if (!s) continue;
    texts.push({ s, it, span: open.length > 0 && open[open.length - 1] });
  }
  const ocr = texts.length > 0 && texts.filter((t) => t.span).length >= 0.9 * texts.length;
  for (const { s, it, span } of texts) {
    const b = textItemToBox(it, vp.transform);
    // `raw` garde la hauteur de la boîte lue. L'étalon du document (bodySize), la grosse étiquette
    // sans renvoi et le filtre des cotes métriques, réglés sur elle, s'y tiennent : la correction ne
    // sert qu'à comparer un mot court à ses voisins (bulle de coupe, nom de mur).
    if (ocr && span) { b.raw = b.size; b.size = ocrTextSize(it.width || 0, b.size); }
    items.push({ s, ...b, src: 't' });
  }

  const notes = await lireNotes(page);
  const cal = await calage(page, notes, ctx, mediane(items.map((it) => it.raw || it.size)));
  for (const { s, rect } of notes) {
    const r = cal ? appliquer(cal, rect) : rect;
    if (!dansLaPage(r, page.view)) continue;   // hors de la feuille : ni visible ni touchable
    // Transformation faite à la main : l'API de pdf.js pour ça a changé d'une version à l'autre.
    const m = vp.transform;
    const ax = m[0] * r[0] + m[2] * r[1] + m[4], ay = m[1] * r[0] + m[3] * r[1] + m[5];
    const bx = m[0] * r[2] + m[2] * r[3] + m[4], by = m[1] * r[2] + m[3] * r[3] + m[5];
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    if (!(x1 > x0) || !(y1 > y0)) continue;
    // Le rectangle d'un commentaire SHX épouse le texte : sa hauteur tient lieu de corps.
    const tall = (y1 - y0) > (x1 - x0) * 1.2 && s.length > 1;
    items.push({ s, x0, y0, x1, y1, size: tall ? (x1 - x0) : (y1 - y0), horiz: !tall, ang: tall ? -Math.PI / 2 : 0, src: 'a' });
  }

  return { w: vp.width, h: vp.height, items };
}

export async function extractDocument(pdf, onProgress) {
  // Pré-passe, sur les annotations seules (rapide) : le document est-il réimposé ? La première feuille dont
  // la plupart des annotations sortent de la page donne le calage, avant qu'une feuille ambiguë ne passe.
  const ctx = { calage: null, essais: 0 };
  for (let n = 1; n <= pdf.numPages && !ctx.calage && ctx.essais < 2; n++) {
    const page = await pdf.getPage(n);
    const notes = await lireNotes(page);
    if (notes.filter((x) => !dansLaPage(x.rect, page.view)).length > notes.length / 2) {
      await calage(page, notes, ctx, await corpsDe(page));
    }
  }
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    pages.push(await extractPage(page, ctx));
    if (onProgress) onProgress(n, pdf.numPages);
  }
  let outline = null;
  try {
    outline = await pdf.getOutline();
  } catch {
    outline = null;
  }
  return { pages, outline };
}
