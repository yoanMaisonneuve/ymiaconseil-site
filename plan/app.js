// app.js — la visionneuse.
//
// Le problème à tuer : sur un cellulaire modeste, une visionneuse PDF recalcule la feuille
// vectorielle (36 × 24 po) à chaque geste, et affiche du blanc pendant le calcul.
//
// La parade, en trois couches dessinées dans cet ordre sur un seul canvas plein écran :
//   1. FOND   — la feuille entière, rendue UNE fois par pdf.js, gardée comme image.
//               Pan et zoom ne font que redessiner cette image : jamais de blanc.
//   2. NET    — quand le geste s'arrête, la zone visible est rendue à la résolution exacte
//               de l'écran et posée PAR-DESSUS le fond. Le fond reste dessous en tout temps.
//   3. LIENS  — les renvois détectés, et la cible en surbrillance après un saut.

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { extractDocument } from './extract.js';
import { buildIndex, DETECT_VERSION, normKey, wallKey } from './detect.js';
import * as store from './store.js';

const VENDOR = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// ── Budget selon l'appareil ────────────────────────────────────────────────
const MEM = Number(params.get('mem')) || navigator.deviceMemory || 4;
const LOW = MEM <= 2;
const BASE_PIXELS = (LOW ? 5 : MEM <= 4 ? 8 : 12) * 1e6;   // surface du fond d'une feuille
const NET_PIXELS = (LOW ? 3 : 5) * 1e6;                    // surface de la couche nette
const BASE_KEEP = LOW ? 2 : 3;                             // fonds gardés en mémoire
const DPR = Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2.5);
const NET_DPR = Math.min(window.devicePixelRatio || 1, 2);
const ENABLE_HWA = params.get('hwa') !== '0';
const Z_MAX = 10;

const S = {
  plan: null, pdf: null, index: null,
  page: 0, view: { z: 1, tx: 0, ty: 0 },
  bases: new Map(),          // page → { bmp, scale }  (ordre d'insertion = ancienneté)
  net: null,                 // { page, bmp, x, y, w, h, scale }
  live: null,                // { page, canvas, scale } : fond en cours de calcul, montré tel quel
  stack: [],                 // historique de navigation : { page, view }
  backrefs: new Map(),       // « page|kind|n » → [{ page, hs }]
  showLinks: true, keepAwake: true, bigDims: true,
  mark: null,                // { page, rect, t0 } cible en surbrillance
  vw: 0, vh: 0, top: 52,
};

const stage = $('#stage');
const ctx = stage.getContext('2d', { alpha: false, desynchronized: true });

// ═══ Rendu pdf.js : une seule tâche à la fois, la plus urgente d'abord ═══════
const pageCache = new Map();
function getPage(n) {
  if (!pageCache.has(n)) pageCache.set(n, S.pdf.getPage(n + 1));
  return pageCache.get(n);
}

let running = null; // { kind: 'base'|'net'|'prep', page, task, cancelled }
function cancelRunning(kinds) {
  if (running && kinds.includes(running.kind)) {
    running.cancelled = true;
    try { running.task && running.task.cancel(); } catch { /* déjà finie */ }
  }
}

async function pdfRender(kind, n, scale, region, onCanvas) {
  // Attendre la fin (ou l'annulation) de la tâche en cours : pdf.js dessine sur le fil principal.
  while (running) { try { await running.done; } catch { /* annulée */ } }
  const job = { kind, page: n, task: null, cancelled: false };
  let finish; job.done = new Promise((r) => { finish = r; });
  running = job;
  const canvas = document.createElement('canvas');
  try {
    const page = await getPage(n);
    if (job.cancelled) throw new Error('annulé');
    const r = region || { x: 0, y: 0, w: S.index.sheets[n].w, h: S.index.sheets[n].h };
    canvas.width = Math.max(1, Math.round(r.w * scale));
    canvas.height = Math.max(1, Math.round(r.h * scale));
    const viewport = page.getViewport({ scale, offsetX: -r.x * scale, offsetY: -r.y * scale });
    if (onCanvas) onCanvas(canvas);
    // Annotations ACTIVÉES : les tampons de révision et les notes manuscrites font partie du plan.
    // Mesuré : les commentaires « AutoCAD SHX Text » n'ont pas d'apparence, pdf.js n'en dessine rien.
    job.task = page.render({ canvas, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE, background: '#ffffff' });
    await job.task.promise;
    if (job.cancelled) throw new Error('annulé');
    return canvas;
  } catch (e) {
    canvas.width = 0; canvas.height = 0;
    throw e;
  } finally {
    running = null; finish();
  }
}

const baseScale = (n) => {
  const sh = S.index.sheets[n];
  return Math.min(2.2, Math.sqrt(BASE_PIXELS / (sh.w * sh.h)));
};
// Préfixe « c » : fonds rendus AVEC les annotations. Les anciens fonds « b » (sans tampons) sont ignorés.
const bucketOf = (scale) => `c${Math.round(scale * 100)}${ENABLE_HWA ? '' : 's'}`;

function rememberBase(n, bmp, scale) {
  const old = S.bases.get(n);
  if (old && old.bmp !== bmp) old.bmp.close && old.bmp.close();
  S.bases.delete(n);
  S.bases.set(n, { bmp, scale });
  for (const k of [...S.bases.keys()]) {
    if (S.bases.size <= BASE_KEEP) break;
    if (k === S.page) continue;
    const b = S.bases.get(k); b.bmp.close && b.bmp.close(); S.bases.delete(k);
  }
}

const basePending = new Map();
// Fond d'une feuille : mémoire → image gardée dans le téléphone → calcul pdf.js.
function ensureBase(n, kind = 'base') {
  if (S.bases.has(n)) return Promise.resolve(S.bases.get(n));
  if (basePending.has(n)) return basePending.get(n);
  const planId = S.plan.id;
  const p = (async () => {
    const scale = baseScale(n), bucket = bucketOf(scale);
    const blob = await store.getBase(planId, n, bucket);
    if (blob) {
      try {
        const bmp = await createImageBitmap(blob);
        if (!S.plan || S.plan.id !== planId) { bmp.close(); throw new Error('plan fermé'); }
        rememberBase(n, bmp, scale);
        return S.bases.get(n);
      } catch (e) { if (String(e.message) === 'plan fermé') throw e; /* image illisible : on recalcule */ }
    }
    if (kind === 'base') cancelRunning(['prep', 'net']);
    const canvas = await pdfRender(kind, n, scale, null, (c) => {
      if (kind === 'base') S.live = { page: n, canvas: c, scale };
    });
    if (S.live && S.live.canvas === canvas) S.live = null;
    const bmp = await createImageBitmap(canvas);
    canvas.toBlob((b) => { canvas.width = 0; canvas.height = 0; if (b) store.putBase(planId, n, bucket, b); }, 'image/webp', 0.9);
    if (!S.plan || S.plan.id !== planId) { bmp.close(); throw new Error('plan fermé'); }
    rememberBase(n, bmp, scale);
    return S.bases.get(n);
  })();
  basePending.set(n, p);
  p.catch(() => {}).finally(() => { basePending.delete(n); if (S.live && S.live.page === n) S.live = null; });
  return p;
}

// Couche nette : la zone visible, à la résolution de l'écran.
let netTimer = 0;
function scheduleNet(delay = 140) {
  clearTimeout(netTimer);
  netTimer = setTimeout(renderNet, delay);
}
async function renderNet() {
  if (!S.pdf || gesture.active || anim) return;
  const n = S.page, sh = S.index.sheets[n], base = S.bases.get(n);
  if (!base) return;
  const want = Math.min(S.view.z * NET_DPR, Z_MAX * NET_DPR);
  // Le fond suffit tant qu'on n'est ni nettement plus près, ni nettement plus loin que lui.
  if (want <= base.scale * 1.12 && want >= base.scale * 0.6) return;
  const vx0 = -S.view.tx / S.view.z, vy0 = -S.view.ty / S.view.z;
  const vw = S.vw / S.view.z, vh = S.vh / S.view.z;
  let m = 0.25;
  let scale = want, r;
  for (;;) {
    const x0 = Math.max(0, vx0 - vw * m), y0 = Math.max(0, vy0 - vh * m);
    const x1 = Math.min(sh.w, vx0 + vw * (1 + m)), y1 = Math.min(sh.h, vy0 + vh * (1 + m));
    r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (r.w <= 1 || r.h <= 1) return;
    if (r.w * r.h * scale * scale <= NET_PIXELS) break;
    if (m > 0) m = 0; else { scale = Math.sqrt(NET_PIXELS / (r.w * r.h)); break; }
  }
  const cur = S.net;
  if (cur && cur.page === n && Math.abs(cur.scale - scale) < scale * 0.04 &&
      cur.x <= Math.max(0, vx0) + 1 && cur.y <= Math.max(0, vy0) + 1 &&
      cur.x + cur.w >= Math.min(sh.w, vx0 + vw) - 1 && cur.y + cur.h >= Math.min(sh.h, vy0 + vh) - 1) return;
  cancelRunning(['prep', 'net']);
  try {
    const canvas = await pdfRender('net', n, scale, r);
    const bmp = await createImageBitmap(canvas);
    canvas.width = 0; canvas.height = 0;
    if (S.page !== n) { bmp.close(); return; }
    if (S.net) S.net.bmp.close();
    S.net = { page: n, bmp, scale, ...r };
    draw();
  } catch { /* annulé par un nouveau geste : le fond est toujours là */ }
  finally { kickPrep(); }
}

// Préparation en arrière-plan : toutes les feuilles, les cibles de la feuille courante d'abord.
let prepToken = 0;
function kickPrep() { setTimeout(() => { if (!running) prepLoop(); }, 400); }
async function prepLoop() {
  if (!S.pdf) return;
  const token = ++prepToken, planId = S.plan.id;
  const total = S.index.sheets.length;
  const order = [];
  for (const hs of S.index.pages[S.page].hotspots) if (!order.includes(hs.page)) order.push(hs.page);
  for (let i = 0; i < total; i++) if (!order.includes(i)) order.push(i);
  let done = 0;
  for (const n of order) {
    if (token !== prepToken || !S.plan || S.plan.id !== planId) return;
    const bucket = bucketOf(baseScale(n));
    if (S.bases.has(n) || (await store.getBase(planId, n, bucket))) { done++; continue; }
    while (gesture.active || anim || running || performance.now() - gesture.last < 700) {
      await new Promise((r) => setTimeout(r, 250));
      if (token !== prepToken) return;
    }
    $('#prep').hidden = false; $('#prep').textContent = `Préparation ${done + 1}/${total}`;
    try {
      const canvas = await pdfRender('prep', n, baseScale(n), null);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.9));
      canvas.width = 0; canvas.height = 0;
      if (blob) await store.putBase(planId, n, bucket, blob);
      done++;
    } catch { return; /* annulée par un geste : relancée par kickPrep() */ }
  }
  $('#prep').hidden = true;
}

// ═══ Dessin ═════════════════════════════════════════════════════════════════
let dirty = false;
function draw() { if (!dirty) { dirty = true; requestAnimationFrame(paint); } }

function paint(now) {
  dirty = false;
  if (!S.index) return;
  const d = DPR, { z, tx, ty } = S.view, sh = S.index.sheets[S.page];
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#dcddd8'; ctx.fillRect(0, 0, stage.width, stage.height);
  const px = tx * d, py = ty * d, pw = sh.w * z * d, ph = sh.h * z * d;
  ctx.fillStyle = '#fff'; ctx.fillRect(px, py, pw, ph);

  const base = S.bases.get(S.page);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (base) ctx.drawImage(base.bmp, px, py, pw, ph);
  else if (S.live && S.live.page === S.page && S.live.canvas.width) ctx.drawImage(S.live.canvas, px, py, pw, ph);

  const net = S.net;
  if (net && net.page === S.page && (!base || net.scale > base.scale || z * d <= net.scale * 1.3)) {
    ctx.drawImage(net.bmp, (tx + net.x * z) * d, (ty + net.y * z) * d, net.w * z * d, net.h * z * d);
  }

  if (S.bigDims) paintDims(d, z, tx, ty);
  if (S.showLinks) paintLinks(d, z, tx, ty);
  if (S.mark && S.mark.page === S.page) {
    const t = (now - S.mark.t0) / 1000, r = S.mark.rect;
    const cxm = (tx + (r.x0 + r.x1) / 2 * z) * d, cym = (ty + (r.y0 + r.y1) / 2 * z) * d;
    const rad = Math.max(30 * d, Math.max(r.x1 - r.x0, r.y1 - r.y0) * 0.62 * z * d);
    const pulse = t < 2.4 ? 1 + 0.35 * Math.abs(Math.sin(t * Math.PI * 1.6)) : 1;
    ctx.lineWidth = (t < 2.4 ? 5 : 3.5) * d; ctx.strokeStyle = '#e1001a';
    ctx.beginPath(); ctx.arc(cxm, cym, rad * pulse, 0, Math.PI * 2); ctx.stroke();
    if (t < 2.4) { ctx.fillStyle = 'rgba(225,0,26,.10)'; ctx.fill(); draw(); }
  }
}

// La loupe des cotes. Une mesure trop petite pour être lue est redessinée par-dessus, jusqu'à ×2.
// Dès qu'elle est lisible seule, on n'y touche pas.
//
// PAS de pastille ni de cadre — Yoan, le 20 sept. : « je veux pas de bulles blanches avec contour ».
// À la place, le texte est posé sur un halo blanc obtenu en le traçant d'abord au trait épais. Ça
// efface juste ce qu'il faut du dessin dessous pour rester lisible, sans poser de boîte sur le plan.
const DIM_FONT = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
// Hauteurs de texte, en pixels d'écran. Montées le 20 sept. à la demande de Yoan (canal, Q13) :
// « ça semble bon mais on pourrait pt grossir encore un peu ».
const DIM_READABLE = 15.5, DIM_TARGET = 18, DIM_USELESS = 9;
function paintDims(d, z, tx, ty) {
  const dims = S.index.pages[S.page].dims;
  if (!dims || !dims.length) return;
  // Une pastille ne couvre jamais un renvoi ni une étiquette : ils occupent leur place d'avance.
  const placed = [];
  const pgNow = S.index.pages[S.page];
  for (const r of [...pgNow.hotspots, ...pgNow.labels]) {
    const x = tx + (r.x0 + r.x1) / 2 * z, y = ty + (r.y0 + r.y1) / 2 * z;
    if (x < -60 || y < -60 || x > S.vw + 60 || y > S.vh + 60) continue;
    placed.push({ x, y, w: (r.x1 - r.x0) / 2 * z * 0.8, h: (r.y1 - r.y0) / 2 * z * 0.8 });
  }
  let lastFont = '', drawn = 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const m of dims) {
    const hpx = m.h * z;
    if (hpx >= DIM_READABLE || hpx * 2 < DIM_USELESS) continue;
    const sx = tx + m.x * z, sy = ty + m.y * z;
    if (sx < -80 || sy < -80 || sx > S.vw + 80 || sy > S.vh + 80) continue;
    if (m._w === undefined) { ctx.font = `600 100px ${DIM_FONT}`; lastFont = ''; m._w = ctx.measureText(m.s).width / 100; }
    const c = Math.abs(Math.cos(m.a)), sn = Math.abs(Math.sin(m.a));
    // Deux cotes grossies ne se recouvrent jamais, et une cote ne bouge JAMAIS de sa place : sur un
    // plan, un chiffre déplacé ne désigne plus la même mesure. Quand ×2 ne rentre pas, on descend par
    // paliers — une cote serrée gagne au moins un peu, plutôt que rien. En dessous de ×1,2 ça ne vaut
    // plus la peine : on laisse le dessin d'origine.
    const full = Math.min(hpx * 2, DIM_TARGET);
    let size = 0, w = 0, h = 0, bw = 0, bh = 0;
    for (const tryout of [full, hpx * 1.6, hpx * 1.35]) {
      if (tryout < hpx * 1.2 || tryout > full) continue;
      w = m._w * tryout + tryout * 0.5; h = tryout * 1.22;
      bw = (w * c + h * sn) / 2 * 0.92; bh = (w * sn + h * c) / 2 * 0.92;
      let hit = false;
      for (const p of placed) if (Math.abs(p.x - sx) < p.w + bw && Math.abs(p.y - sy) < p.h + bh) { hit = true; break; }
      if (!hit) { size = tryout; break; }
    }
    if (!size) continue;
    placed.push({ x: sx, y: sy, w: bw, h: bh });
    const font = `600 ${(size * d).toFixed(1)}px ${DIM_FONT}`;
    if (font !== lastFont) { ctx.font = font; lastFont = font; }
    ctx.save();
    ctx.translate(sx * d, sy * d); ctx.rotate(m.a);
    ctx.lineWidth = size * d * 0.42; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.strokeText(m.s, 0, d * size * 0.04);
    ctx.fillStyle = m.pose ? '#b34700' : '#0b1a33';   // les cotes d'installation gardent leur orange
    ctx.fillText(m.s, 0, d * size * 0.04);
    ctx.restore();
    if (++drawn >= 320) break;
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function paintLinks(d, z, tx, ty) {
  const pg = S.index.pages[S.page];
  const inView = (r) => (tx + r.x1 * z) > 0 && (tx + r.x0 * z) < S.vw && (ty + r.y1 * z) > 0 && (ty + r.y0 * z) < S.vh;
  for (const hs of pg.hotspots) {
    if (!inView(hs)) continue;
    const x = (tx + hs.x0 * z) * d, y = (ty + hs.y0 * z) * d, w = (hs.x1 - hs.x0) * z * d, h = (hs.y1 - hs.y0) * z * d;
    const blue = hs.kind === 'detail';
    ctx.fillStyle = blue ? 'rgba(10,108,255,.17)' : 'rgba(240,120,0,.20)';
    ctx.strokeStyle = blue ? 'rgba(10,108,255,.9)' : 'rgba(224,104,0,.95)';
    if (Math.max(w, h) < 12 * d) {           // trop petit pour une boîte : un point bien visible
      ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 4.5 * d, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    } else {
      const rr = Math.min(w, h) * 0.3;
      ctx.lineWidth = 1.6 * d; ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, rr); else ctx.rect(x, y, w, h);
      ctx.fill(); ctx.stroke();
    }
  }
  ctx.lineWidth = 2 * d; ctx.strokeStyle = 'rgba(11,138,45,.85)';
  for (const l of pg.labels) {
    if (!inView(l)) continue;
    const rad = Math.max(l.x1 - l.x0, l.y1 - l.y0) * 0.56 * z * d;
    if (rad < 5 * d) continue;
    ctx.beginPath(); ctx.arc((tx + (l.x0 + l.x1) / 2 * z) * d, (ty + (l.y0 + l.y1) / 2 * z) * d, rad, 0, Math.PI * 2); ctx.stroke();
  }
}

// ═══ Vue : cadrage, bornes, animation ═══════════════════════════════════════
function resize() {
  const cx = S.vw ? (S.vw / 2 - S.view.tx) / S.view.z : null, cy = S.vw ? (S.vh / 2 - S.view.ty) / S.view.z : null;
  S.vw = window.innerWidth; S.vh = window.innerHeight;
  S.top = $('#topbar').getBoundingClientRect().height || 52;
  stage.width = Math.round(S.vw * DPR); stage.height = Math.round(S.vh * DPR);
  if (S.index && cx !== null) {
    // Le minimum dépend de l'orientation : sans ce rappel, une vue légale en portrait devient
    // illégale en paysage, et le premier pincement de dézoom faisait GROSSIR la feuille d'un coup.
    S.view.z = Math.min(Z_MAX, Math.max(zMin(), S.view.z));
    S.view.tx = S.vw / 2 - cx * S.view.z; S.view.ty = S.vh / 2 - cy * S.view.z; clampView(); scheduleNet();
  }
  draw();
}

const zFit = (n) => { const sh = S.index.sheets[n]; return Math.min(S.vw / sh.w, (S.vh - S.top) / sh.h) * 0.98; };
const zMin = () => zFit(S.page) * 0.7;

function fitView(n) {
  const sh = S.index.sheets[n], z = zFit(n);
  return { z, tx: (S.vw - sh.w * z) / 2, ty: S.top + (S.vh - S.top - sh.h * z) / 2 };
}

// Où atterrir pour une cible.
//
// UN MUR : la feuille entière. Demandé par Yoan (canal, Q5) : « je veux vraiment voir le mur »,
// pas un gros plan sur son étiquette. Une élévation se lit d'un bout à l'autre ; c'est le dessin
// qu'on vient chercher, pas son nom. La surbrillance dit où le mur est nommé.
//
// UN DÉTAIL : assez près pour lire. Le numéro est en bas à gauche de son dessin, donc on le place
// à gauche et un peu bas, et le détail s'étale en haut à droite — vérifié par Yoan (canal, Q4).
function viewForTarget(n, rect, kind) {
  if (kind === 'wall') return fitView(n);
  const sh = S.index.sheets[n];
  const cxr = (rect.x0 + rect.x1) / 2, cyr = (rect.y0 + rect.y1) / 2;
  const z = Math.max(zFit(n), Math.min(2.4, Math.max(S.vw / 620, 0.85)));
  const v = { z, tx: S.vw * 0.3 - cxr * z, ty: S.top + (S.vh - S.top) * 0.46 - cyr * z };
  return clampTo(v, sh);
}

function clampTo(v, sh) {
  const m = 70;
  const lim = (t, size, view, lo0) => {
    const a = Math.min(lo0 + m, view - size - m), b = Math.max(lo0 + m, view - size - m);
    return Math.min(b, Math.max(a, t));
  };
  v.tx = lim(v.tx, sh.w * v.z, S.vw, 0);
  v.ty = lim(v.ty, sh.h * v.z, S.vh, S.top);
  return v;
}
function clampView() { clampTo(S.view, S.index.sheets[S.page]); }

function zoomAt(sx, sy, f) {
  const z0 = S.view.z, z1 = Math.min(Z_MAX, Math.max(zMin(), z0 * f)), k = z1 / z0;
  S.view.tx = sx - (sx - S.view.tx) * k; S.view.ty = sy - (sy - S.view.ty) * k; S.view.z = z1;
}

let anim = null;
// Atterrissage différé : le fond d'une feuille peut mettre quelques secondes à se calculer sur un
// téléphone modeste. Si le poseur pose le doigt pendant ce temps, on ne lui arrache pas la vue —
// mais on n'oublie pas non plus où il allait : on y va dès qu'il lève le doigt.
let pendingLand = null;
function stopAnim() { if (anim) { cancelAnimationFrame(anim.raf); anim = null; } }
function animateTo(to, ms = 300) {
  stopAnim();
  const from = { ...S.view }, t0 = performance.now();
  const c0 = { x: (S.vw / 2 - from.tx) / from.z, y: (S.vh / 2 - from.ty) / from.z };
  const c1 = { x: (S.vw / 2 - to.tx) / to.z, y: (S.vh / 2 - to.ty) / to.z };
  const step = (now) => {
    const u = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - u, 3);
    const z = from.z * Math.pow(to.z / from.z, e);
    S.view.z = z;
    S.view.tx = S.vw / 2 - (c0.x + (c1.x - c0.x) * e) * z;
    S.view.ty = S.vh / 2 - (c0.y + (c1.y - c0.y) * e) * z;
    draw();
    if (u < 1) anim.raf = requestAnimationFrame(step);
    else {
      // La cible est reprise par son CENTRE, pas par son tx/ty : si l'écran a tourné pendant
      // l'animation, le tx/ty calculé au départ ne cadre plus rien. Sans rotation, c'est identique.
      anim = null;
      S.view = { z: to.z, tx: S.vw / 2 - c1.x * to.z, ty: S.vh / 2 - c1.y * to.z };
      clampView(); draw(); scheduleNet(60); savePos();
    }
  };
  anim = { raf: requestAnimationFrame(step) };
}

// ═══ Gestes ═════════════════════════════════════════════════════════════════
const gesture = { active: false, last: 0, ptrs: new Map(), tap: null, vel: { x: 0, y: 0, t: 0 }, fling: 0, lastTap: null };

stage.addEventListener('pointerdown', (e) => {
  if (!S.index) return;
  stage.setPointerCapture(e.pointerId);
  gesture.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture.active = true; gesture.last = performance.now();
  stopAnim(); cancelAnimationFrame(gesture.fling);
  clearTimeout(netTimer); cancelRunning(['net', 'prep']);
  if (gesture.ptrs.size === 1) {
    gesture.tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    gesture.vel = { x: 0, y: 0, t: performance.now() };
  } else gesture.tap = null;
});

stage.addEventListener('pointermove', (e) => {
  const p = gesture.ptrs.get(e.pointerId);
  if (!p) return;
  const now = performance.now();
  if (gesture.ptrs.size === 1) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (gesture.tap && Math.hypot(e.clientX - gesture.tap.x, e.clientY - gesture.tap.y) > 9) gesture.tap.moved = true;
    S.view.tx += dx; S.view.ty += dy;
    const dt = Math.max(1, now - gesture.vel.t);
    gesture.vel = { x: 0.7 * gesture.vel.x + 0.3 * (dx / dt), y: 0.7 * gesture.vel.y + 0.3 * (dy / dt), t: now };
  } else if (gesture.ptrs.size === 2) {
    const [a, b] = [...gesture.ptrs.values()];
    const d0 = Math.hypot(a.x - b.x, a.y - b.y), m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    p.x = e.clientX; p.y = e.clientY;
    const [a1, b1] = [...gesture.ptrs.values()];
    const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y), m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
    S.view.tx += m1.x - m0.x; S.view.ty += m1.y - m0.y;
    if (d0 > 0) zoomAt(m1.x, m1.y, d1 / d0);
  }
  p.x = e.clientX; p.y = e.clientY;
  gesture.last = now;
  clampView(); draw();
});

function endPointer(e) {
  if (!gesture.ptrs.has(e.pointerId)) return;
  gesture.ptrs.delete(e.pointerId);
  const now = performance.now();
  gesture.last = now;
  if (gesture.ptrs.size > 0) return;
  gesture.active = false;
  const tap = gesture.tap; gesture.tap = null;
  // Un toucher est une intention neuve : elle remplace l'atterrissage qui attendait.
  if (e.type === 'pointerup' && tap && !tap.moved && now - tap.t < 400) { pendingLand = null; onTap(tap.x, tap.y); return; }
  if (pendingLand) {
    const p = pendingLand; pendingLand = null;
    if (p.page === S.page) { animateTo(p.view, 340); return; }
  }
  // Lancer : la feuille glisse encore un peu, comme une carte.
  let { x: vx, y: vy } = gesture.vel;
  if (now - gesture.vel.t < 60 && Math.hypot(vx, vy) > 0.25) {
    let t = now;
    const slide = (n2) => {
      const dt = Math.min(32, n2 - t); t = n2;
      S.view.tx += vx * dt; S.view.ty += vy * dt;
      const k = Math.pow(0.994, dt); vx *= k; vy *= k;
      clampView(); draw(); gesture.last = n2;
      if (Math.hypot(vx, vy) > 0.03) gesture.fling = requestAnimationFrame(slide);
      else { scheduleNet(); savePos(); }
    };
    gesture.fling = requestAnimationFrame(slide);
  } else { scheduleNet(); savePos(); }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  if (!S.index) return;
  e.preventDefault();
  stopAnim(); cancelRunning(['net', 'prep']);
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022)));
  clampView(); draw(); gesture.last = performance.now(); scheduleNet(220); savePos();
}, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
// Après un toucher, le navigateur fabrique un « clic » au même endroit. Sans ceci, ce clic fantôme
// tombe sur le voile du panneau qu'on vient d'ouvrir, et le referme aussitôt.
stage.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
stage.addEventListener('contextmenu', (e) => e.preventDefault());

// ═══ Toucher un renvoi ══════════════════════════════════════════════════════
const distToRect = (x, y, r) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));

function onTap(sx, sy) {
  const z = S.view.z, x = (sx - S.view.tx) / z, y = (sy - S.view.ty) / z;
  const pg = S.index.pages[S.page];
  const reach = 22 / z;
  const hits = [];
  if (S.showLinks) {
    for (const hs of pg.hotspots) { const dd = distToRect(x, y, hs); if (dd <= reach) hits.push({ d: dd, hs }); }
    for (const l of pg.labels) {
      // Même seuil que le dessin (paintLinks) : à la feuille entière les bulles ne sont pas peintes,
      // et une cible invisible mangeait le double-toucher sur ce qui a l'air du papier vide.
      if (Math.max(l.x1 - l.x0, l.y1 - l.y0) * 0.56 * z < 5) continue;
      const dd = distToRect(x, y, l); if (dd <= reach * 0.6) hits.push({ d: dd + 4 / z, label: l });
    }
  }
  hits.sort((a, b) => a.d - b.d);
  const now = performance.now();
  if (!hits.length) {
    // Double-toucher dans le vide : zoomer, ou revenir à la feuille entière.
    const lt = gesture.lastTap;
    if (lt && now - lt.t < 320 && Math.hypot(lt.x - sx, lt.y - sy) < 40) {
      gesture.lastTap = null;
      if (S.view.z > zFit(S.page) * 2.2) animateTo(fitView(S.page), 260);
      else { const to = { ...S.view }; const k = 2.6; to.z = Math.min(Z_MAX, to.z * k); const kk = to.z / S.view.z; to.tx = sx - (sx - to.tx) * kk; to.ty = sy - (sy - to.ty) * kk; animateTo(clampTo(to, S.index.sheets[S.page]), 240); }
    } else { gesture.lastTap = { x: sx, y: sy, t: now }; scheduleNet(); }
    return;
  }
  gesture.lastTap = null;
  // Un seul candidat, ou un candidat nettement plus proche que les autres : on y va.
  const clear = hits.length === 1 || (hits[0].d === 0 && hits[1].d > 6 / z);
  if (clear) activate(hits[0]);
  else choose(hits.slice(0, 6));
}

function destOf(hs) {
  // Le marqueur se trompe de feuille : on va où le mur est réellement dessiné.
  if (hs.alt) return { page: hs.alt.page, rect: hs.alt.target, kind: 'wall', warn: `Le marqueur indique ${hs.sheet}, mais ${hs.label} est dessiné sur ${hs.alt.sheet}.` };
  return { page: hs.page, rect: hs.target || null, kind: hs.kind === 'detail' ? 'detail' : 'wall' };
}
const hsTitle = (hs) => (hs.kind === 'detail'
  ? `Détail ${hs.detail}${hs.note ? ` (${hs.note}.)` : ''}`
  : (hs.label || 'Feuille'));
const hsSub = (hs) => `Feuille ${hs.alt ? hs.alt.sheet : hs.sheet}${hs.kind === 'detail' && !hs.target ? ' · étiquette introuvable' : ''}`;

function activate(hit) {
  if (hit.hs) {
    // Plusieurs dessins portent ce numéro sur la feuille visée : on demande plutôt que de deviner.
    // Deviner, ici, c'est envoyer quelqu'un couper une pièce d'après la mauvaise coupe.
    if (hit.hs.targets && hit.hs.targets.length > 1) {
      const hs = hit.hs;
      openSheet(`Détail ${hs.detail} — il y en a ${hs.targets.length} sur ${hs.sheet}`,
        hs.targets.map((t, i) => ({
          dot: '#0a6cff', big: `Le ${i + 1}${i === 0 ? 'er' : 'e'}`,
          small: `${Math.round(t.x0)}, ${Math.round(t.y0)} sur la feuille`,
          run: () => go(hs.page, t, 'detail'),
        })));
      return;
    }
    const d = destOf(hit.hs);
    go(d.page, d.rect, d.kind);
    if (d.warn) toast(d.warn, true);
    else if (hit.hs.kind === 'detail' && !hit.hs.target) toast(`Détail ${hit.hs.detail} : étiquette introuvable sur ${hit.hs.sheet}.`, true);
    else if (hit.hs.inferred) toast(`Détail ${hit.hs.detail} : la bulle est vide sur le dessin. Déduit par élimination — à confirmer.`, true);
    else if (hit.hs.note === 'INV') toast(`Détail ${hit.hs.detail} — INV. : à lire inversé.`);
    else if (hit.hs.note === 'SIM') toast(`Détail ${hit.hs.detail} — SIM. : détail similaire.`);
  } else showCallers(hit.label);
}

function choose(hits) {
  openSheet('Lequel ?', hits.map((h) => (h.hs
    ? { dot: h.hs.kind === 'detail' ? '#0a6cff' : '#f07800', big: hsTitle(h.hs), small: hsSub(h.hs), run: () => activate(h) }
    : { dot: '#0b8a2d', big: h.label.kind === 'wall' ? `Mur ${h.label.text || h.label.n}` : `Détail ${h.label.n}`, small: 'Voir d\'où il est appelé', run: () => activate(h) })));
}

// Depuis une étiquette : « qui m'appelle ? » — la navigation à rebours.
function showCallers(label) {
  const list = S.backrefs.get(`${S.page}|${label.kind}|${label.n}`) || [];
  const name = label.kind === 'wall' ? `Mur ${label.text || label.n}` : `Détail ${label.n}`;
  if (!list.length) { toast(`${name} : aucun renvoi ne pointe ici.`); return; }
  const byPage = new Map();
  for (const c of list) { if (!byPage.has(c.page)) byPage.set(c.page, []); byPage.get(c.page).push(c.hs); }
  openSheet(`${name} — appelé depuis`, [...byPage].map(([p, arr]) => ({
    dot: '#0a6cff', big: S.index.sheets[p].id, small: `${S.index.sheets[p].title || ''} · ${arr.length} renvoi${arr.length > 1 ? 's' : ''}`.replace(/^ · /, ''),
    run: () => go(p, arr[0], 'detail'),
  })));
}

// ═══ Navigation ═════════════════════════════════════════════════════════════
const planState = () => ({ v: 'plan', depth: S.stack.length });
let overlayEntry = false;

function pushNav() {
  if (overlayEntry) { overlayEntry = false; hidePanels(); history.replaceState(planState(), ''); }
  else history.pushState(planState(), '');
}

function go(n, rect, kind) {
  S.stack.push({ page: S.page, view: { ...S.view } });
  if (S.stack.length > 60) S.stack.shift();
  pushNav();
  showPage(n, rect, kind);
}

async function showPage(n, rect, kind, exactView) {
  stopAnim(); cancelAnimationFrame(gesture.fling); clearTimeout(netTimer); cancelRunning(['net', 'prep']);
  pendingLand = null;
  const samePage = n === S.page && S.bases.has(n);
  S.page = n;
  if (!samePage && S.net) { S.net.bmp.close(); S.net = null; }
  S.mark = rect ? { page: n, rect, t0: performance.now() } : null;
  const sh = S.index.sheets[n];
  $('#sheetId').textContent = sh.id; $('#sheetTitle').textContent = sh.title || `Page ${n + 1}`;
  updateBack();
  const target = exactView ? { ...exactView } : rect ? viewForTarget(n, rect, kind) : fitView(n);
  if (samePage) { animateTo(target, 320); return; }
  // Nouvelle feuille : on la montre entière, puis on descend vers la cible — on sait où on est.
  S.view = exactView ? { ...exactView } : fitView(n);
  draw();
  const ready = S.bases.has(n);
  if (!ready) { $('#busyMsg').textContent = `Feuille ${sh.id}…`; $('#busy').hidden = false; }
  const tick = setInterval(draw, 250);   // montrer le fond qui se dessine, plutôt qu'attendre devant du vide
  try { await ensureBase(n, 'base'); } catch { /* l'utilisateur est déjà ailleurs */ }
  clearInterval(tick);
  if (S.page !== n) return;
  $('#busy').hidden = true;
  if (S.mark) S.mark.t0 = performance.now();
  draw();
  if (!exactView && rect) {
    if (gesture.active) pendingLand = { page: n, view: target };
    else animateTo(target, 340);
  } else scheduleNet(60);
  savePos(); kickPrep();
}

function updateBack() {
  const b = $('#back');
  if (!S.stack.length) { b.hidden = true; return; }
  b.hidden = false;
  $('#backLbl').textContent = S.index.sheets[S.stack[S.stack.length - 1].page].id;
}

let afterPanel = null;
window.addEventListener('popstate', () => {
  if (overlayEntry) { overlayEntry = false; hidePanels(); const f = afterPanel; afterPanel = null; if (f) f(); return; }
  if (!S.index) return;
  if (S.stack.length) { const prev = S.stack.pop(); showPage(prev.page, null, null, prev.view); return; }
  closePlan();
});

let saveTimer = 0;
// `tout de suite` quand le téléphone s'apprête à mettre l'app de côté : Android peut la tuer sans
// prévenir, et un enregistrement différé de 900 ms meurt avec elle. Le poseur rouvrirait alors son
// plan à la première feuille au lieu du détail qu'il était en train de lire.
function savePos(tout_de_suite) {
  clearTimeout(saveTimer);
  const ecrire = () => {
    // Un plan « éphémère » n'a pas pu être gardé : écrire sa fiche seule mettrait à l'accueil un
    // plan sans son PDF, que l'ouverture ne saurait pas retrouver.
    if (!S.plan || S.plan.ephemere) return;
    S.plan.lastPos = { page: S.page, c: { x: (S.vw / 2 - S.view.tx) / S.view.z, y: (S.vh / 2 - S.view.ty) / S.view.z }, zr: S.view.z / zFit(S.page) };
    store.savePlan(S.plan).catch(() => {});
  };
  if (tout_de_suite) ecrire(); else saveTimer = setTimeout(ecrire, 900);
}

// ═══ Panneaux ═══════════════════════════════════════════════════════════════
let panelGen = 0;
function hidePanels() { for (const id of ['#scrim', '#drawer', '#sheet']) $(id).hidden = true; }
let panelShownAt = 0;
function showPanel(id) {
  panelGen++; panelShownAt = performance.now();
  hidePanels();
  $('#scrim').hidden = false; $(id).hidden = false;
  if (!overlayEntry) { overlayEntry = true; history.pushState({ v: 'overlay' }, ''); }
}
function closePanel() { if (overlayEntry) history.back(); else hidePanels(); }
// Fermer le panneau, PUIS agir : l'historique du navigateur est asynchrone, on attend son signal.
function closePanelThen(fn) { if (overlayEntry) { afterPanel = fn; history.back(); } else { hidePanels(); fn(); } }
$('#scrim').addEventListener('click', () => { if (performance.now() - panelShownAt > 350) closePanel(); });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanel);

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function openSheet(title, options) {
  $('#sheetHead').textContent = title;
  const body = $('#sheetBody'); body.textContent = '';
  for (const o of options) {
    const b = el('button', `opt${o.danger ? ' danger' : ''}`); b.type = 'button';
    if (o.dot) { const t = el('span', 'tag'); t.style.cssText = `flex:none;width:14px;height:14px;border-radius:50%;background:${o.dot}`; b.append(t); }
    const tx = el('span'); tx.append(el('span', 'big', o.big)); if (o.small) tx.append(el('small', null, o.small));
    b.append(tx);
    b.addEventListener('click', () => { if (o.keepOpen) o.run(); else runFromPanel(o.run); });
    body.append(b);
  }
  showPanel('#sheet');
}
// Une action de panneau : si elle navigue, go() recycle l'entrée d'historique du panneau ; sinon on le ferme.
function runFromPanel(fn) {
  const gen = panelGen;
  fn();
  // Ni navigation (go() a recyclé l'entrée d'historique), ni nouveau panneau ouvert : on referme.
  if (overlayEntry && gen === panelGen) closePanel();
}

function openDrawer() {
  $('#q').value = '';
  renderDrawer('');
  showPanel('#drawer');
}

function chip(text, cls, run) { const c = el('button', `chip ${cls || ''}`, text); c.type = 'button'; c.addEventListener('click', () => runFromPanel(run)); return c; }

function goWall(w) {
  if (w.places.length === 1) { const p = w.places[0]; go(p.page, p.target, 'wall'); return; }
  openSheet(`Mur ${w.label}`, w.places.map((p) => ({ dot: '#f07800', big: p.sheet, small: S.index.sheets[p.page].title, run: () => go(p.page, p.target, 'wall') })));
}

function renderDrawer(q) {
  const body = $('#drawerBody'); body.textContent = '';
  const ix = S.index, key = normKey(q);
  const match = (s) => !key || normKey(s).includes(key);

  const walls = ix.walls.filter((w) => match(w.label));
  if (walls.length) {
    body.append(el('div', 'grp', 'Murs'));
    const c = el('div', 'chips');
    for (const w of walls) c.append(chip(w.label, 'wall', () => goWall(w)));
    body.append(c);
  }
  body.append(el('div', 'grp', key ? 'Résultats' : 'Feuilles'));
  let shown = 0;
  ix.sheets.forEach((sh, i) => {
    const details = ix.pages[i].labels.filter((l) => l.kind === 'detail');
    const dm = key ? details.filter((l) => normKey(l.n) === key) : details;
    const sheetHit = match(sh.id) || match(sh.title || '');
    if (key && !sheetHit && !dm.length) return;
    shown++;
    const row = el('button', `row${i === S.page ? ' cur' : ''}`); row.type = 'button';
    row.append(el('span', 'id', sh.id), el('span', 'tt', sh.title || `Page ${i + 1}`));
    if (details.length) row.append(el('span', 'n', `${details.length} détails`));
    row.addEventListener('click', () => runFromPanel(() => { if (i !== S.page) go(i, null, null); }));
    body.append(row);
    const list = key ? dm : details;
    if (list.length) {
      const sub = el('div', 'sub chips');
      for (const l of list) sub.append(chip(l.n, '', () => go(i, l, 'detail')));
      body.append(sub);
    }
  });
  if (!shown && !walls.length) body.append(el('div', 'note', 'Rien ne correspond.'));
  if (!key && !ix.stats.hotspots) body.append(el('div', 'note', 'Aucun renvoi détecté dans ce plan : PDF numérisé (image) ou convention différente. La navigation par feuille fonctionne quand même.'));
}
$('#q').addEventListener('input', (e) => renderDrawer(e.target.value));
$('#menuBtn').addEventListener('click', openDrawer);
$('#sheetBtn').addEventListener('click', openDrawer);
$('#homeBtn').addEventListener('click', () => { if (S.page !== S.index.home) go(S.index.home, null, null); else animateTo(fitView(S.page)); });
$('#fit').addEventListener('click', () => animateTo(fitView(S.page)));
$('#back').addEventListener('click', () => history.back());
$('#moreBtn').addEventListener('click', () => {
  const st = S.index.stats;
  openSheet(S.plan.name, [
    { big: S.showLinks ? 'Masquer les renvois' : 'Afficher les renvois', small: `${st.detailRefs} renvois de détail · ${st.sheetRefs} renvois de feuille`, run: () => { S.showLinks = !S.showLinks; draw(); } },
    { big: S.bigDims ? 'Cotes à leur taille d\'origine' : 'Grossir les cotes', small: `${st.dims || 0} mesures repérées · grossies jusqu'à ×2 quand elles sont trop petites`, run: () => { S.bigDims = !S.bigDims; draw(); } },
    { big: S.keepAwake ? 'Laisser l\'écran s\'éteindre' : 'Garder l\'écran allumé', small: 'Pratique quand on mesure avec les deux mains', run: () => { S.keepAwake = !S.keepAwake; wake(); } },
    { big: 'Changer de plan', small: 'Retour à la liste de mes plans', run: () => closePanelThen(leaveViewer), keepOpen: true },
  ]);
});

let toastTimer = 0;
function toast(msg, warn) {
  const t = $('#toast'); t.textContent = msg; t.className = warn ? 'warn' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, warn ? 5200 : 3000);
}

// ═══ Écran allumé ═══════════════════════════════════════════════════════════
let lock = null;
async function wake() {
  try {
    if (S.keepAwake && S.index && document.visibilityState === 'visible' && navigator.wakeLock) lock = await navigator.wakeLock.request('screen');
    else if (lock) { await lock.release(); lock = null; }
  } catch { /* refusé : sans gravité */ }
}
document.addEventListener('visibilitychange', () => { wake(); if (document.visibilityState === 'hidden') savePos(true); });

// ═══ Ouvrir / importer un plan ══════════════════════════════════════════════
function work(msg, frac) {
  $('#work').hidden = false; $('#workMsg').textContent = msg;
  if (frac != null) $('#workBar').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

function loadPdf(bytes) {
  return pdfjsLib.getDocument({
    data: bytes, standardFontDataUrl: `${VENDOR}standard_fonts/`, wasmUrl: `${VENDOR}wasm/`,
    isEvalSupported: false, enableHWA: ENABLE_HWA, verbosity: 0,
  }).promise;
}

async function analyse(pdf) {
  const doc = await extractDocument(pdf, (n, t) => work(`Lecture des feuilles… ${n}/${t}`, 0.15 + 0.75 * (n / t)));
  work('Repérage des renvois…', 0.93);
  return buildIndex(doc);
}

async function importFile(file) {
  if (!file) return;
  try {
    work('Lecture du plan…', 0.05);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('Ce fichier n\'est pas un PDF.');
    const id = await store.fingerprint(bytes, file.name);
    const known = await store.getPlan(id);
    if (known) { await openPlan(id); return; }
    const pdf = await loadPdf(bytes.slice());        // pdf.js garde sa copie ; l'original part dans le téléphone
    const index = await analyse(pdf);
    const plan = { id, name: file.name.replace(/\.pdf$/i, ''), size: bytes.length, pages: pdf.numPages, addedAt: Date.now(), lastOpenedAt: Date.now(), index, lastPos: null };
    work('Enregistrement dans le téléphone…', 0.97);
    // Le plan est déjà lu et analysé — une minute de travail sur un téléphone modeste. Si le
    // téléphone refuse de le garder (mémoire pleine, navigation privée, stockage bloqué par
    // l'employeur), on l'ouvre quand même pour cette séance plutôt que de tout jeter.
    let garde = true;
    try { await store.saveNewPlan(plan, new Blob([bytes], { type: 'application/pdf' })); }
    catch { garde = false; }
    if (garde) store.askPersistence();
    plan.ephemere = !garde;   // rien à réécrire plus tard : la fiche n'existe pas dans le téléphone
    startViewer(plan, pdf);
    if (!garde) toast('Pas de place pour garder ce plan dans le téléphone. Il reste ouvert pour cette séance seulement.', true);
  } catch (e) {
    $('#work').hidden = true;
    const m = e && e.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe.' : (e && e.message) || 'Lecture impossible.';
    alert(`Impossible d'ouvrir ce plan.\n${m}`);
  }
}

async function openPlan(id) {
  try {
    work('Ouverture…', 0.2);
    const plan = await store.getPlan(id), blob = await store.getFile(id);
    if (!plan || !blob) throw new Error('Plan introuvable dans ce téléphone.');
    const bytes = new Uint8Array(blob instanceof Blob ? await blob.arrayBuffer() : blob);
    const pdf = await loadPdf(bytes);
    if (!plan.index || plan.index.version !== DETECT_VERSION) plan.index = await analyse(pdf);  // le détecteur a progressé
    plan.lastOpenedAt = Date.now();
    try { await store.savePlan(plan); } catch { /* horodatage perdu : le plan s'ouvre quand même */ }
    startViewer(plan, pdf);
  } catch (e) {
    $('#work').hidden = true;
    alert(`Impossible d'ouvrir ce plan.\n${(e && e.message) || ''}`);
  }
}

function buildBackrefs(ix) {
  const map = new Map();
  ix.pages.forEach((pg, p) => {
    for (const hs of pg.hotspots) {
      const d = hs.alt ? hs.alt.page : hs.page;
      const k = hs.kind === 'detail' ? `${d}|detail|${hs.detail}` : hs.label ? `${d}|wall|${wallKey(hs.label)}` : null;
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ page: p, hs });
    }
  });
  return map;
}

function startViewer(plan, pdf) {
  S.plan = plan; S.pdf = pdf; S.index = plan.index; S.stack = []; S.net = null; S.mark = null;
  S.backrefs = buildBackrefs(plan.index);
  pageCache.clear();
  $('#work').hidden = true; $('#home').hidden = true; $('#viewer').hidden = false;
  resize();
  history.pushState(planState(), '');
  const lp = plan.lastPos;
  const n = lp && lp.page < plan.index.sheets.length ? lp.page : plan.index.home;
  let view = null;
  if (lp && lp.c) { const z = Math.min(Z_MAX, zFit(n) * (lp.zr || 1)); view = clampTo({ z, tx: S.vw / 2 - lp.c.x * z, ty: S.vh / 2 - lp.c.y * z }, plan.index.sheets[n]); }
  showPage(n, null, null, view);
  wake();
  const st = plan.index.stats;
  if (!lp) toast(st.hotspots ? `${st.hotspots} renvois repérés. Touche un mur ou une coupe.` : 'Aucun renvoi repéré dans ce plan. Navigation par feuille seulement.', !st.hotspots);
}

function leaveViewer() { history.go(-(S.stack.length + 1)); S.stack = []; closePlan(); }

function closePlan() {
  savePos(); prepToken++; cancelRunning(['base', 'net', 'prep']); clearTimeout(netTimer); stopAnim();
  for (const b of S.bases.values()) b.bmp.close && b.bmp.close();
  S.bases.clear(); if (S.net) { S.net.bmp.close(); S.net = null; }
  pendingLand = null;
  const pdf = S.pdf;
  S.pdf = null; S.index = null; S.plan = null; S.stack = []; S.live = null; pageCache.clear();
  // pdf.js 6 : la libération passe par la tâche de chargement, plus par le document.
  try { const t = pdf && (pdf.loadingTask || pdf); if (t && t.destroy) Promise.resolve(t.destroy()).catch(() => {}); } catch { /* déjà libéré */ }
  $('#viewer').hidden = true; $('#home').hidden = false; $('#prep').hidden = true; $('#busy').hidden = true;
  wake(); renderHome();
}

// ═══ Accueil ════════════════════════════════════════════════════════════════
async function renderHome() {
  let plans = [];
  try { plans = await store.listPlans(); } catch { /* stockage indisponible (navigation privée) */ }
  const box = $('#plans'); box.textContent = '';
  $('#plansTitle').hidden = !plans.length;
  if (!plans.length) { box.append(el('div', 'empty', 'Aucun plan pour l\'instant. Ouvre le PDF des dessins d\'atelier : il sera gardé ici, prêt à rouvrir sans réseau.')); return; }
  for (const p of plans) {
    const card = el('div', 'plan');
    const open = el('button', 'open'); open.type = 'button';
    const st = p.index && p.index.stats;
    open.append(el('div', 'name', p.name), el('div', 'meta', `${p.pages} feuilles · ${st ? st.hotspots : 0} renvois · ${(p.size / 1048576).toFixed(1)} Mo`));
    open.addEventListener('click', () => openPlan(p.id));
    const more = el('button', 'more'); more.type = 'button'; more.setAttribute('aria-label', 'Options du plan');
    more.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
    more.addEventListener('click', () => openSheet(p.name, [
      { big: 'Ouvrir', run: () => closePanelThen(() => openPlan(p.id)), keepOpen: true },
      { big: 'Retirer de ce téléphone', small: 'Le fichier PDF d\'origine n\'est pas touché', danger: true, keepOpen: true,
        run: async () => { if (confirm(`Retirer « ${p.name} » de ce téléphone ?`)) { await store.removePlan(p.id); closePanelThen(renderHome); } } },
    ]));
    card.append(open, more); box.append(card);
  }
}

$('#importBtn').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; importFile(f); });

// Glisser-déposer (ordinateur).
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; if (!S.index) $('#drop').hidden = false; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; const f = e.dataTransfer.files[0]; if (f && !S.index) importFile(f); });

// Plan reçu par « Partager → Plans » (Android, app installée) : le service worker l'a mis de côté.
async function takeShared() {
  if (!params.has('partage') || !('caches' in window)) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('plans-partage');
    const keys = await cache.keys();
    if (!keys.length) return false;
    const res = await cache.match(keys[0]);
    const name = decodeURIComponent(res.headers.get('x-nom') || 'plan.pdf');
    const blob = await res.blob();
    await cache.delete(keys[0]);
    await importFile(new File([blob], name, { type: 'application/pdf' }));
    return true;
  } catch { return false; }
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
window.addEventListener('pagehide', () => savePos(true));

const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && secure && !params.has('nosw')) navigator.serviceWorker.register('sw.js').catch(() => {});

history.replaceState({ v: 'home' }, '');
renderHome();
takeShared();

// Prise de test : l'état interne, pour le banc d'essai automatisé.
window.__plans = { S, go, onTap, importFile, fitView, viewForTarget, get running() { return running; } };
