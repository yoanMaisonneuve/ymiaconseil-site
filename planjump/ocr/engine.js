// engine.js — OCR PP-OCRv4 (détection DB + reconnaissance CTC) sur une image, sans serveur.
//
// Portage fidèle de RapidOCR (rapidocr_onnxruntime 1.4.4, Python) : mêmes modèles ONNX, mêmes
// réglages (son config.yaml), mêmes prétraitements. C'est ce moteur qui a été validé sur les
// captures du plan Westbury ; on le reproduit, on ne le réinvente pas. Écarts VOULUS, tous ici :
//
//   1. Pas de réduction à 2000 px (max_side_len). Une page 36 × 24 po à 300 DPI fait 10800 × 7200 px ;
//      réduite à 2000, une bulle « 09 » tomberait à 5 px de haut. On lit plutôt des tuiles de 1536 px
//      qui se chevauchent, à la résolution native, puis on recolle les boîtes coupées par une tuile.
//   2. Boîtes DB alignées sur les axes : composantes connexes 8-voisines du masque au lieu de
//      findContours + minAreaRect. Le texte d'un dessin DAO est à 0° ou 90°, un rectangle droit
//      l'enferme aussi bien. Score = moyenne de la probabilité dans le rectangle (score_mode « fast »),
//      décollement (unclip) d'une distance aire × 1,6 / périmètre, comme pyclipper sur un rectangle.
//      Les contours de trous (RETR_LIST) et la limite de 1000 candidats sont ignorés.
//   3. Classifieur d'orientation (cls) : RapidOCR le passe sur toutes les boîtes. Sur un plan, seul le
//      texte vertical en a besoin : RapidOCR tourne les boîtes hautes de 90° anti-horaire, ce qui met
//      à l'envers la cote DAO ordinaire (écrite de bas en haut) — sans cls, toutes les cotes verticales
//      sont perdues (vérifié sur 5.png et 7.png). Par défaut on ne le passe donc que sur celles-là
//      (option cls: 'all' pour refaire exactement RapidOCR).
//   4. Pas de « letterbox » (images de moins de 30 px de haut ou 8 fois plus larges que hautes) :
//      une tuile n'est jamais dans ce cas.
//
// Ce qui n'est PAS un écart : les redimensionnements (cv2.resize bilinéaire, refait au bit près),
// la normalisation (mêmes arrondis float32/float64 que numpy), l'ordre BGR (les modèles Paddle ont
// appris sur des images OpenCV), les lots de lecture (tri par allongement, par 6, complétés à 320 px
// au moins — réduire ce remplissage accélère mais fait perdre des cotes, mesuré).
//
// Module pur : ni DOM ni canvas. Une image est { width, height, data } (RGBA, comme ImageData).
// onnxruntime est INJECTÉ (new OcrEngine(ort)) : le fichier se charge tel quel dans un Worker
// (onnxruntime-web, worker.js) comme dans Node (fonctions pures comparées à OpenCV).

export const DEFAULTS = {
  tile: 1536,            // côté d'une tuile de détection (multiple de 32 : aucun redimensionnement)
  overlap: 256,          // chevauchement minimal : plus haut que le plus gros texte à recoller
  limitSideLen: 736,     // limit_type « min » : agrandit les petites images, ne réduit jamais
  thresh: 0.3,
  boxThresh: 0.5,
  unclipRatio: 1.6,
  dilate: true,
  recH: 48, recW: 320, recBatch: 6,
  clsH: 48, clsW: 192, clsBatch: 6, clsThresh: 0.9,
  cls: 'vertical',       // 'vertical' | 'all' | 'none' — voir l'écart n° 3
  textScore: 0.5,        // text_score : sous ce score, RapidOCR jette la lecture
  blankLuma: 160,        // un pixel plus sombre est de l'encre
  blankInk: 12,          // moins de pixels d'encre que ça : tuile blanche, on ne la lit pas
};

// round() de Python (et np.round) : au pair le plus proche sur les demis. RapidOCR s'en sert pour
// caler les tailles sur 32 ; Math.round donnerait 32 px de plus sur certaines images.
export function pyRound(v) {
  const r = Math.round(v);
  return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

// ── Images ────────────────────────────────────────────────────────────────────

export function cropRGBA(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const src = img.data, W = img.width;
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * W + x) * 4;
    out.set(src.subarray(s, s + w * 4), r * w * 4);
  }
  return { width: w, height: h, data: out };
}

// Une « source » donne ses pixels par région : une page de 300 DPI n'a alors pas besoin d'exister
// d'un seul bloc (un rendu pdf.js par tuile suffit). Une ImageData devient une source triviale.
export function asSource(img) {
  if (typeof img.region === 'function') return img;
  return { width: img.width, height: img.height, region: (x, y, w, h) => cropRGBA(img, x, y, w, h) };
}

// np.rot90 : quart de tour anti-horaire. La colonne de droite devient la ligne du haut.
export function rot90ccw(img) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const d32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const o32 = new Uint32Array(out.buffer);
  for (let i = 0; i < w; i++) {           // ligne de sortie i  ←  colonne w-1-i
    const sc = w - 1 - i;
    for (let j = 0; j < h; j++) o32[i * h + j] = d32[j * w + sc];
  }
  return { width: h, height: w, data: out };
}

export function rot180(img) {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  const d32 = new Uint32Array(img.data.buffer, img.data.byteOffset, n);
  const o32 = new Uint32Array(out.buffer);
  for (let i = 0; i < n; i++) o32[i] = d32[n - 1 - i];
  return { width: img.width, height: img.height, data: out };
}

// cvRound : arrondi au pair le plus proche (lrint), comme saturate_cast<short>(float) d'OpenCV.
function cvRound(v) {
  const r = Math.round(v);
  return (r - v === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

// Tables d'un axe de cv2.resize (INTER_LINEAR) en virgule fixe 11 bits : centres de pixels décalés
// d'un demi, calcul en float32 comme OpenCV. clampEdge : bords répliqués sur x (OpenCV ne borne pas y,
// mais y lit alors deux fois la même ligne — même résultat, mêmes poids).
function cvAxis(dst, src, clampEdge) {
  const scale = 1 / (dst / src);
  const i0 = new Int32Array(dst), i1 = new Int32Array(dst), a0 = new Int32Array(dst), a1 = new Int32Array(dst);
  for (let d = 0; d < dst; d++) {
    let f = Math.fround((d + 0.5) * scale - 0.5);
    let s = Math.floor(f);
    f = Math.fround(f - s);
    if (clampEdge) {
      if (s < 0) { f = 0; s = 0; }
      if (s >= src - 1) { f = 0; s = src - 1; }
    }
    i0[d] = Math.min(Math.max(s, 0), src - 1);
    i1[d] = Math.min(Math.max(s + 1, 0), src - 1);
    a0[d] = cvRound(Math.fround(1 - f) * 2048);
    a1[d] = cvRound(f * 2048);
  }
  return { i0, i1, a0, a1 };
}

// cv2.resize(img, (dw, dh)) sur une image 8 bits BGR, au bit près : passe horizontale entière
// (poids × 2048), passe verticale avec la formule SIMD d'OpenCV (VResizeLinearVec_32s8u), bouts de
// ligne compris — vérifié identique à OpenCV 5.0 sur 300 découpes au hasard. Pourquoi tant de soin :
// un écart d'UN niveau de gris sur quelques pixels a suffi à couper en deux la boîte d'une cote
// verticale (« 2288.9 » de 5.png, lue « 2288. »). Rend une image RGBA (alpha 255).
export function cvResize(img, dw, dh) {
  const { width: sw, height: sh, data: src } = img;
  if (sw === dw && sh === dh) return img;
  const X = cvAxis(dw, sw, true), Y = cvAxis(dh, sh, false);
  const W3 = dw * 3;
  const hrow = (r) => {                       // ligne source r, redimensionnée en x, BGR entrelacé
    const out = new Int32Array(W3), base = r * sw * 4;
    for (let x = 0; x < dw; x++) {
      const p = base + X.i0[x] * 4, q = base + X.i1[x] * 4, a = X.a0[x], b = X.a1[x];
      out[x * 3] = src[p + 2] * a + src[q + 2] * b;
      out[x * 3 + 1] = src[p + 1] * a + src[q + 1] * b;
      out[x * 3 + 2] = src[p] * a + src[q] * b;
    }
    return out;
  };
  const cache = new Map();
  const row = (r) => {
    let v = cache.get(r);
    if (!v) { v = hrow(r); cache.set(r, v); if (cache.size > 3) cache.delete(cache.keys().next().value); }
    return v;
  };
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const S0 = row(Y.i0[y]), S1 = row(Y.i1[y]), b0 = Y.a0[y], b1 = Y.a1[y];
    const o = y * dw * 4;
    for (let x = 0, e = 0; x < dw; x++) {
      for (let c = 2; c >= 0; c--, e++) {      // BGR entrelacé → RGBA (le tableau borne à 0..255)
        out[o + x * 4 + c] = ((((S0[e] >> 4) * b0) >> 16) + (((S1[e] >> 4) * b1) >> 16) + 2) >> 2;
      }
      out[o + x * 4 + 3] = 255;
    }
  }
  return { width: dw, height: dh, data: out };
}

// Normalisation (v/255 − 0,5)/0,5 en tables, avec les arrondis de numpy : la détection multiplie
// par 1/255 en float32 puis soustrait en float64 ; reconnaissance et classifieur divisent en float32.
const LUT_DET = new Float32Array(256), LUT_REC = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  LUT_DET[v] = (Math.fround(v * Math.fround(1 / 255)) - 0.5) / 0.5;
  LUT_REC[v] = Math.fround(Math.fround(Math.fround(v / 255) - 0.5) / 0.5);
}

// Redimensionne puis écrit en BGR planaire dans out (à partir de offset, lignes de largeur outW).
// Les colonnes au-delà de dw restent à 0 : c'est le remplissage de RapidOCR.
function resizeNormCHW(img, dw, dh, out, offset, outW, outH, lut) {
  const r = cvResize(img, dw, dh), d = r.data;
  const plane = outW * outH;
  for (let y = 0; y < dh; y++) {
    const ro = offset + y * outW;
    let s = y * dw * 4;
    for (let x = 0; x < dw; x++, s += 4) {
      out[ro + x] = lut[d[s + 2]];
      out[ro + plane + x] = lut[d[s + 1]];
      out[ro + 2 * plane + x] = lut[d[s]];
    }
  }
}

// Tuile blanche : presque aucun pixel d'encre. Une marge vide ne mérite pas 1 s de réseau.
export function isBlank(img, o = DEFAULTS) {
  const d = img.data, lim = o.blankLuma * 1000;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 < lim && ++ink >= o.blankInk) return false;
  }
  return true;
}

// ── Tuiles ────────────────────────────────────────────────────────────────────

// Tuiles toutes de même taille, réparties régulièrement : la dernière est recalée sur le bord
// au lieu d'être une bande étroite (le réseau lit mal un texte collé au bord d'une image étroite).
function axis(len, tile, overlap) {
  if (len <= tile) return [[0, len]];
  const n = Math.ceil((len - overlap) / (tile - overlap));
  const out = [];
  for (let i = 0; i < n; i++) out.push([Math.round((i * (len - tile)) / (n - 1)), tile]);
  return out;
}

export function planTiles(width, height, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const xs = axis(width, o.tile, o.overlap), ys = axis(height, o.tile, o.overlap);
  const tiles = [];
  for (const [y, h] of ys) for (const [x, w] of xs) tiles.push({ x, y, w, h, index: tiles.length });
  return tiles;
}

// Boîtes d'une tuile → repère de l'image. « cut » : la boîte touche un bord de tuile qui n'est
// pas un bord de l'image — le texte y est peut-être coupé, la tuile voisine le voit en entier.
// « Touche » = à moins d'une demi-hauteur de ligne : une lettre coupée par le bord n'y laisse souvent
// qu'un filet que le détecteur ignore, et la boîte s'arrête quelques pixels avant (vu sur le
// cartouche d'essai : « DETAILS EN » et « AILS EN PLAN », à 5 px du bord, jamais recollés).
export function toImageBoxes(tile, boxes, width, height) {
  return boxes.map((b) => {
    const m = Math.max(1, Math.round(0.5 * Math.min(b.x1 - b.x0, b.y1 - b.y0)));
    const cut = (b.x0 <= m && tile.x > 0) || (b.y0 <= m && tile.y > 0) ||
      (b.x1 >= tile.w - 1 - m && tile.x + tile.w < width) || (b.y1 >= tile.h - 1 - m && tile.y + tile.h < height);
    return { x0: b.x0 + tile.x, y0: b.y0 + tile.y, x1: b.x1 + tile.x, y1: b.y1 + tile.y, score: b.score, tile: tile.index, cut };
  });
}

const isVert = (b) => (b.y1 - b.y0) >= 1.5 * (b.x1 - b.x0);
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// Deux boîtes de tuiles différentes décrivent-elles le même texte ?
//   – l'une est (presque) dans l'autre : doublon de la zone de chevauchement, ou morceau coupé ;
//   – ou l'une est coupée par un bord de tuile et elles sont sur la même ligne (le long d'un texte
//     plus long que le chevauchement, chaque tuile n'en voit qu'un bout).
// « Même ligne » se juge sur l'axe transverse de la plus longue : deux lignes empilées ont des
// boîtes qui se touchent après unclip, mais se recouvrent peu en hauteur.
function sameText(a, b) {
  const ix = ov(a.x0, a.x1, b.x0, b.x1), iy = ov(a.y0, a.y1, b.y0, b.y1);
  if (ix <= 0 || iy <= 0) return false;
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0), areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const small = areaA <= areaB ? a : b;
  const long = Math.max(a.x1 - a.x0, a.y1 - a.y0) >= Math.max(b.x1 - b.x0, b.y1 - b.y0) ? a : b;
  const cross = isVert(long)
    ? ix / (Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0))
    : iy / (Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0));
  const contain = (ix * iy) / Math.min(areaA, areaB);
  if (contain >= 0.6 && (small.cut || cross >= 0.6)) return true;
  return (a.cut || b.cut) && cross >= 0.6;
}

// Fusionne les doublons entre tuiles (union des rectangles). Jamais deux boîtes d'une même tuile :
// le réseau les a séparées en voyant tout leur contexte.
export function mergeBoxes(boxes) {
  const n = boxes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const order = boxes.map((_, i) => i).sort((i, j) => boxes[i].x0 - boxes[j].x0);
  for (let p = 0; p < n; p++) {
    const a = boxes[order[p]];
    for (let q = p + 1; q < n; q++) {
      const b = boxes[order[q]];
      if (b.x0 > a.x1) break;
      if (a.tile === b.tile || !sameText(a, b)) continue;
      const ra = find(order[p]), rb = find(order[q]);
      if (ra !== rb) parent[rb] = ra;
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), b = boxes[i];
    const g = groups.get(r);
    if (!g) { groups.set(r, { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, score: b.score }); continue; }
    g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0);
    g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1);
    g.score = Math.max(g.score, b.score);
  }
  return [...groups.values()];
}

// ── Post-traitement DB (voir l'écart n° 2) ─────────────────────────────────────

function dbBoxes(pred, mw, mh, destW, destH, o) {
  const n = mw * mh;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = pred[i] > o.thresh ? 1 : 0;
  let mask = bin;
  if (o.dilate) {
    // cv2.dilate avec un noyau 2×2 (ancre en (1,1)) : un pixel s'allume si lui, son voisin de
    // gauche, celui du haut ou la diagonale haut-gauche l'est. Recolle les lettres d'un mot.
    mask = new Uint8Array(n);
    for (let y = 0; y < mh; y++) {
      const r = y * mw;
      for (let x = 0; x < mw; x++) {
        const i = r + x;
        mask[i] = bin[i] | (x > 0 ? bin[i - 1] : 0) |
          (y > 0 ? bin[i - mw] | (x > 0 ? bin[i - mw - 1] : 0) : 0);
      }
    }
  }

  const boxes = [];
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    // Composante 8-voisine (celle que suit findContours) : on n'en garde que le rectangle.
    let top = 0;
    stack[top++] = start; seen[start] = 1;
    let x0 = mw, y0 = mh, x1 = -1, y1 = -1;
    while (top) {
      const i = stack[--top];
      const y = (i / mw) | 0, x = i - y * mw;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= mh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= mw) continue;
          const j = yy * mw + xx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    // minAreaRect d'un contour de pixels : distance entre centres extrêmes, d'où x1 − x0.
    const bw = x1 - x0, bh = y1 - y0;
    if (Math.min(bw, bh) < 3) continue;                     // min_size
    let sum = 0;
    for (let y = y0; y <= y1; y++) {
      const r = y * mw;
      for (let x = x0; x <= x1; x++) sum += pred[r + x];
    }
    const score = sum / ((bw + 1) * (bh + 1));
    if (score < o.boxThresh) continue;
    // unclip : pyclipper décale chaque côté du rectangle de d (coins arrondis, hors boîte englobante).
    const d = (bw * bh * o.unclipRatio) / (2 * (bw + bh));
    const ex0 = Math.round(x0 - d), ex1 = Math.round(x1 + d);
    const ey0 = Math.round(y0 - d), ey1 = Math.round(y1 + d);
    if (Math.min(ex1 - ex0, ey1 - ey0) < 5) continue;       // min_size + 2
    // Retour à la taille de la tuile (np.round), puis filter_tag_det_res : bornes [0, w−1], > 3 px.
    const cl = (v, m) => Math.min(Math.max(v, 0), m);
    const X0 = cl(pyRound((ex0 / mw) * destW), destW - 1), X1 = cl(pyRound((ex1 / mw) * destW), destW - 1);
    const Y0 = cl(pyRound((ey0 / mh) * destH), destH - 1), Y1 = cl(pyRound((ey1 / mh) * destH), destH - 1);
    if (X1 - X0 <= 3 || Y1 - Y0 <= 3) continue;
    boxes.push({ x0: X0, y0: Y0, x1: X1, y1: Y1, score });
  }
  return boxes;
}

// ── Décodage CTC ──────────────────────────────────────────────────────────────

// Convention PaddleOCR (CTCLabelDecode de RapidOCR) : indice 0 = « blank » CTC, puis le
// dictionnaire, puis une espace finale. 1 + 6623 + 1 = 6625 sorties pour ch_PP-OCRv4_rec.
export function parseKeys(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return ['blank', ...lines.map((l) => l.replace(/\r$/, '')), ' '];
}

function ctcDecode(probs, T, C, chars, k) {
  let s = '', sum = 0, cnt = 0, prev = -1;
  const base = k * T * C;
  for (let t = 0; t < T; t++) {
    const off = base + t * C;
    let best = 0, bp = probs[off];
    for (let c = 1; c < C; c++) { const p = probs[off + c]; if (p > bp) { bp = p; best = c; } }
    // Doublons consécutifs fusionnés, puis blanc retiré — dans cet ordre, comme RapidOCR.
    if (best !== 0 && best !== prev) { s += chars[best]; sum += bp; cnt++; }
    prev = best;
  }
  return { s, conf: cnt ? sum / cnt : 0 };
}

// ── Moteur ────────────────────────────────────────────────────────────────────

export class OcrEngine {
  constructor(ort, opts = {}) {
    this.ort = ort;
    this.o = { ...DEFAULTS, ...opts };
    this.det = this.rec = this.cls = null;
    this.chars = null;
  }

  // models : { det, rec, cls? } en ArrayBuffer/Uint8Array ; keys : texte de ppocr_keys.txt.
  async load({ det, rec, cls, keys }, sessionOptions = {}) {
    const so = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions };
    const mk = (m) => this.ort.InferenceSession.create(m instanceof Uint8Array ? m : new Uint8Array(m), so);
    this.det = await mk(det);
    this.rec = await mk(rec);
    if (cls) this.cls = await mk(cls);
    this.chars = parseKeys(keys);
    return this;
  }

  // Détection sur UNE image (une tuile) : rectangles en pixels de cette image.
  async detect(img) {
    const o = this.o;
    const { width: w, height: h } = img;
    // DetPreProcess de RapidOCR, limit_type « min ».
    let ratio = 1;
    if (Math.min(h, w) < o.limitSideLen) ratio = o.limitSideLen / (h < w ? h : w);
    const rh = pyRound(Math.trunc(h * ratio) / 32) * 32;
    const rw = pyRound(Math.trunc(w * ratio) / 32) * 32;
    if (rw <= 0 || rh <= 0) return [];
    const input = new Float32Array(3 * rw * rh);
    resizeNormCHW(img, rw, rh, input, 0, rw, rh, LUT_DET);
    const feeds = { [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, rh, rw]) };
    const out = (await this.det.run(feeds))[this.det.outputNames[0]];
    const [, , mh, mw] = out.dims;
    const boxes = dbBoxes(out.data, mw, mh, w, h, o);
    out.dispose?.();
    return boxes;
  }

  // Classifieur 0°/180° : renvoie, pour chaque image, vrai s'il faut la retourner.
  async classify(imgs) {
    const o = this.o;
    const flips = new Array(imgs.length).fill(false);
    if (!this.cls || !imgs.length) return flips;
    const order = imgs.map((_, i) => i).sort((a, b) => imgs[a].width / imgs[a].height - imgs[b].width / imgs[b].height);
    for (let b0 = 0; b0 < order.length; b0 += o.clsBatch) {
      const idx = order.slice(b0, b0 + o.clsBatch);
      const H = o.clsH, W = o.clsW;
      const input = new Float32Array(idx.length * 3 * H * W);
      idx.forEach((k, bi) => {
        const im = imgs[k];
        const rw = Math.min(Math.ceil(H * (im.width / im.height)), W);
        resizeNormCHW(im, rw, H, input, bi * 3 * H * W, W, H, LUT_REC);
      });
      const feeds = { [this.cls.inputNames[0]]: new this.ort.Tensor('float32', input, [idx.length, 3, H, W]) };
      const out = (await this.cls.run(feeds))[this.cls.outputNames[0]];
      idx.forEach((k, bi) => {
        const p0 = out.data[bi * 2], p1 = out.data[bi * 2 + 1];
        flips[k] = p1 > p0 && p1 > o.clsThresh;            // label « 180 » avec score > cls_thresh
      });
      out.dispose?.();
    }
    return flips;
  }

  // Reconnaissance d'images de texte déjà découpées (et redressées) : [{ s, conf }].
  // Tri par allongement et lots de 6 comme RapidOCR : chaque lot est complété (zéros) jusqu'à la
  // largeur du plus allongé, ce qui influe un peu sur la lecture — d'où le même regroupement.
  async recognize(imgs) {
    const o = this.o;
    const res = new Array(imgs.length);
    const order = imgs.map((_, i) => i).sort((a, b) => imgs[a].width / imgs[a].height - imgs[b].width / imgs[b].height);
    for (let b0 = 0; b0 < order.length; b0 += o.recBatch) {
      const idx = order.slice(b0, b0 + o.recBatch);
      const H = o.recH;
      let maxR = o.recW / o.recH;
      for (const k of idx) maxR = Math.max(maxR, imgs[k].width / imgs[k].height);
      const W = Math.trunc(H * maxR);
      const input = new Float32Array(idx.length * 3 * H * W);
      idx.forEach((k, bi) => {
        const im = imgs[k];
        const cw = Math.ceil(H * (im.width / im.height));
        resizeNormCHW(im, cw > W ? W : cw, H, input, bi * 3 * H * W, W, H, LUT_REC);
      });
      const feeds = { [this.rec.inputNames[0]]: new this.ort.Tensor('float32', input, [idx.length, 3, H, W]) };
      const out = (await this.rec.run(feeds))[this.rec.outputNames[0]];
      const [, T, C] = out.dims;
      if (C !== this.chars.length) throw new Error(`dictionnaire de ${this.chars.length} classes pour un modèle qui en sort ${C}`);
      idx.forEach((k, bi) => { res[k] = ctcDecode(out.data, T, C, this.chars, bi); });
      out.dispose?.();
    }
    return res;
  }

  // Redresse (cls) puis lit une liste de découpes produites par makeCrop : [{ s, conf, flip }].
  async readCrops(crops) {
    const mode = this.o.cls;
    const sel = mode === 'none' ? [] : crops.map((c, i) => i).filter((i) => mode === 'all' || crops[i].vertical);
    const flips = await this.classify(sel.map((i) => crops[i]));
    const flip = new Array(crops.length).fill(false);
    sel.forEach((i, k) => { flip[i] = flips[k]; });
    const imgs = crops.map((c, i) => (flip[i] ? rot180(c) : c));
    const res = await this.recognize(imgs);
    return res.map((r, i) => ({ ...r, flip: flip[i] }));
  }

  // Page entière : tuiles → détection → fusion → découpes → cls → reconnaissance.
  // img : ImageData (ou source { width, height, region(x,y,w,h) }). Coordonnées en pixels de l'image.
  async recognizeImage(img, opts = {}) {
    const o = { ...this.o, ...opts };
    const prev = this.o;
    this.o = o;
    try {
      const src = asSource(img);
      const tiles = planTiles(src.width, src.height, o);
      const t0 = now();
      let raw = [], blank = 0;
      for (const t of tiles) {
        const px = await src.region(t.x, t.y, t.w, t.h);
        if (isBlank(px, o)) { blank++; } else raw = raw.concat(toImageBoxes(t, await this.detect(px), src.width, src.height));
        o.onProgress?.({ stage: 'det', done: t.index + 1, total: tiles.length });
      }
      const boxes = mergeBoxes(raw);
      const t1 = now();
      const crops = [];
      for (const b of boxes) crops.push(await makeCrop(src, b));
      const reads = await this.readCrops(crops);
      o.onProgress?.({ stage: 'rec', done: crops.length, total: crops.length });
      const items = finalize(boxes, crops, reads, o);
      items.stats = { tiles: tiles.length, blank, boxes: boxes.length, detMs: t1 - t0, recMs: now() - t1 };
      return items;
    } finally {
      this.o = prev;
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// get_rotate_crop_image de RapidOCR, cas d'un rectangle droit : la transformée perspective se réduit
// à une translation entière, donc à une simple découpe [x0, x1) × [y0, y1). Puis quart de tour
// anti-horaire si la boîte est haute (h/w ≥ 1,5) : texte vertical couché avant lecture.
export async function makeCrop(src, b) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const px = await src.region(b.x0, b.y0, w, h);
  const vertical = h / w >= 1.5;
  const c = vertical ? rot90ccw(px) : px;
  c.vertical = vertical;
  return c;
}

// Lectures + boîtes → résultat final, filtré au text_score et trié haut → bas, gauche → droite.
// ang : direction de la ligne de base dans le repère écran (y vers le bas), comme extract.js.
// Une boîte verticale retournée par cls se lit de bas en haut (cote DAO ordinaire) : −90°.
export function finalize(boxes, crops, reads, o = DEFAULTS) {
  const items = [];
  boxes.forEach((b, i) => {
    const r = reads[i];
    if (!r || !r.s || r.conf < o.textScore) return;
    const v = crops[i].vertical;
    const ang = v ? (r.flip ? -Math.PI / 2 : Math.PI / 2) : (r.flip ? Math.PI : 0);
    items.push({ s: r.s, conf: r.conf, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, vertical: v, ang });
  });
  items.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return items;
}
