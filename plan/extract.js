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

export async function extractPage(page) {
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

  let annots = [];
  try {
    annots = await page.getAnnotations({ intent: 'display' });
  } catch {
    annots = [];
  }
  for (const a of annots) {
    const raw = (a.contentsObj && a.contentsObj.str) || a.contents || '';
    const s = String(raw).trim();
    if (!s || !a.rect || s.length > 60) continue;
    // Transformation faite à la main : l'API de pdf.js pour ça a changé d'une version à l'autre.
    const m = vp.transform;
    const ax = m[0] * a.rect[0] + m[2] * a.rect[1] + m[4], ay = m[1] * a.rect[0] + m[3] * a.rect[1] + m[5];
    const bx = m[0] * a.rect[2] + m[2] * a.rect[3] + m[4], by = m[1] * a.rect[2] + m[3] * a.rect[3] + m[5];
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
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    pages.push(await extractPage(page));
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
