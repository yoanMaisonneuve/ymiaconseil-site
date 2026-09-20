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

export async function extractPage(page) {
  const vp = page.getViewport({ scale: 1 });
  const items = [];

  const tc = await page.getTextContent();
  for (const it of tc.items) {
    if (!it.str) continue;
    const s = it.str.trim();
    if (!s) continue;
    const b = textItemToBox(it, vp.transform);
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
