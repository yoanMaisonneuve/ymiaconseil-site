// ocr.js — prépare un plan « imprimé en image » pour « Plans d'atelier ».
//
// Le cas : un jeu de plans passé par une imprimante PDF (PDF-XChange « [GDI] ») n'a plus ni texte
// ni tracés, seulement des images. L'app n'y trouve rien. Les navigateurs y font bien un OCR pour
// Ctrl+F, mais une page web n'y a pas accès.
//
// Ce que fait cette page, sur l'ordinateur et sans rien envoyer :
//   1. elle ouvre le PDF avec le pdf.js de l'app, et laisse de côté les feuilles qui ont déjà du texte ;
//   2. elle rend chaque feuille en image (par blocs, raster.js) et la lit (PP-OCRv4, ocr/pool.js) ;
//   3. elle rassemble les mots de tout le plan au format d'extract.js, apprend les numéros de feuille
//      avec buildIndex, et rattrape les renvois presque bien lus (ocr/sheetfix.js) ;
//   4. elle écrit un NOUVEAU PDF : le fichier d'origine intact + une couche de texte invisible posée
//      sur chaque mot (ocr/pdftext.js). L'app importe ce PDF sans rien changer de son côté ;
//   5. elle relit ce PDF avec extract.js + detect.js, comme l'app le fera, et en donne le rapport.
//
// Pourquoi hors de /plan/ : le service worker de l'app répond à toute navigation sous /plan/.

import * as pdfjsLib from '../plan/vendor/pdfjs/pdf.min.mjs';
import { extractPage, extractDocument } from '../plan/extract.js';
import { buildIndex } from '../plan/detect.js';
import * as PDFLib from './ocr/vendor/pdf-lib/pdf-lib.esm.min.js';
import { OcrPool, defaultWorkerCount } from './ocr/pool.js';
import { planTiles } from './ocr/engine.js';
import { PageRaster } from './ocr/raster.js';
import { wordGeometry, buildTextUpdate } from './ocr/pdftext.js';
import { fixTitleBlocks, fixSheetRefs } from './ocr/sheetfix.js';
import { recheck } from './ocr/recheck.js';
import { analyseReport } from './report.js';

const VENDOR = new URL('../plan/vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const params = new URLSearchParams(location.search);
// Résolution de lecture. 600 DPI, mesuré sur les plans d'essai (captures du plan Westbury remises en
// feuilles de 36 × 24 po) : lues à 300 DPI, 3 bulles de détail sur 12 ; à 600 DPI, 12 sur 12. Le
// chiffre d'une petite bulle ne fait qu'une dizaine de pixels à 300 DPI, trop peu pour le détecteur
// de texte. Au-delà de la résolution des images du PDF, pdf.js agrandit sans lisser (pixels doublés) :
// mesuré aussi, la lecture est la même qu'avec un agrandissement bicubique.
const DPI = clamp(Number(params.get('dpi')) || 600, 150, 1200);
// Fils de lecture : un par cœur libre, 4 au plus (pool.js). Chaque fil garde ~0,5 Go pendant la
// détection d'une tuile : mesuré sur une feuille dense lue à 600 DPI, 3,5 Go pour Chromium avec 3 fils,
// 4,8 Go avec 6. navigator.deviceMemory, plafonné à 8 par Chrome, ne distingue pas un portable de 8 Go
// d'une station de 64 Go ; or un onglet tué faute de mémoire perd toute la lecture. Plus de fils
// seulement sur demande : ?workers=6.
const WORKERS = clamp(Math.round(Number(params.get('workers'))) || defaultWorkerCount(), 1, 8);
// Moins d'éléments de texte que ça : la feuille est une image (un tampon, un en-tête d'imprimante
// ne font pas une feuille lisible). Une feuille dessinée en vrai texte en a des centaines.
const MIN_TEXT = 30;

const $ = (s) => document.querySelector(s);
const f1 = (v) => (Math.round(v * 10) / 10).toString().replace('.', ',');
// Mémoire du navigateur pendant la lecture, pour le journal : ~2 Go + ~0,5 Go par fil (voir WORKERS).
const memGo = (n) => f1(2 + 0.5 * n);
const mo = (b) => `${f1(b / 1e6)} Mo`;
const plural = (n, one, many) => `${n.toLocaleString('fr-CA')} ${n > 1 ? many : one}`;

function duree(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// « 1-3,7 » → {1, 2, 3, 7} : pour essayer d'abord sur quelques feuilles d'un gros plan.
function pageSet(spec, max) {
  if (!spec) return null;
  const out = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let n = Math.max(1, a); n <= Math.min(max, b); n++) out.add(n);
  }
  return out.size ? out : null;
}

// ── Affichage ───────────────────────────────────────────────────────────────

function work(msg, frac, sub) {
  $('#work').style.display = 'block';
  if (msg != null) $('#workMsg').textContent = msg;
  if (sub != null) $('#workSub').textContent = sub;
  if (frac != null) $('#bar').firstElementChild.style.width = `${Math.round(clamp(frac, 0, 1) * 100)}%`;
}

function say(text, kind) {
  const m = $('#msg');
  m.style.display = text ? 'block' : 'none';
  m.className = kind || '';
  m.textContent = text || '';
}

const pagesLog = [];
function logPage(line) {
  pagesLog.push(line);
  const el = $('#pages');
  el.style.display = 'block';
  el.textContent = pagesLog.join('\n');
  el.scrollTop = el.scrollHeight;
}

function showReport(text) {
  const r = $('#report');
  r.style.display = text ? 'block' : 'none';
  r.textContent = text || '';
}

// ── Images d'une feuille : combien, et à quelle résolution ─────────────────────
// Pour information seulement (et pour prévenir si elle est faible) : la liste d'opérations de pdf.js
// donne chaque image avec sa matrice ; sa résolution = pixels ÷ pouces qu'elle couvre.
async function imagesOf(page) {
  const OPS = pdfjsLib.OPS;
  const ol = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const dpis = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) ctm = mul(ctm, Array.from(a[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const w = fn === OPS.paintImageXObject ? a[1] : a[0] && a[0].width;
      const wpt = Math.hypot(ctm[0], ctm[1]);
      if (w && wpt > 1) dpis.push((w * 72) / wpt);
    }
  }
  dpis.sort((x, y) => x - y);
  return { n: dpis.length, dpi: dpis.length ? Math.round(dpis[Math.floor(dpis.length / 2)]) : null };
}

// ── Le travail ───────────────────────────────────────────────────────────────

let job = null;          // travail en cours : { cancelled, pool, stop }
let lastFile = null;
let lastUrl = null;

// Une attente qui cède à « Annuler » : le pool, lui, est arrêté net (workers terminés).
const race = (p) => Promise.race([p, job.cancelP]);

function stopJob() {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.stop(new Error('annulé'));
  if (job.pool) job.pool.terminate();
}

async function prepare(file, { force = false } = {}) {
  if (!file || job) return;
  lastFile = file;
  pagesLog.length = 0;
  $('#pages').style.display = 'none';
  showReport('');
  say('');
  $('#actions').style.display = 'none';
  $('#force').hidden = true;
  $('#drop').classList.add('busy');
  $('#running').style.display = 'flex';
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }

  let stop;
  const cancelP = new Promise((_, rej) => { stop = rej; });
  cancelP.catch(() => {});
  job = { cancelled: false, pool: null, stop, cancelP };
  const debug = { dpi: DPI, workers: WORKERS, pages: [], corrections: [], timing: {} };
  window.__ocr = debug;   // pour les essais automatisés : rien ne sort de la page
  let task = null, lock = null;
  const t0 = performance.now();
  try {
    lock = await navigator.wakeLock?.request('screen').catch(() => null);

    // 1. Ouvrir. Le tampon part au worker de pdf.js (transféré, pas copié) ; le fichier, lui, reste
    // sur le disque et sera relu plus tard pour écrire la sortie.
    work('Lecture du fichier…', 0.01, '');
    const buf = new Uint8Array(await file.arrayBuffer());
    if (!String.fromCharCode(...buf.subarray(0, 1024)).includes('%PDF-')) throw new Error('Ce fichier n\'est pas un PDF.');
    task = pdfjsLib.getDocument({
      data: buf, standardFontDataUrl: `${VENDOR}standard_fonts/`, wasmUrl: `${VENDOR}wasm/`,
      isEvalSupported: false, verbosity: 0,
    });
    const pdf = await race(task.promise);
    const N = pdf.numPages;
    // Un PDF chiffré s'ouvre (mot de passe propriétaire seul) mais ne peut pas être complété sans
    // tout ré-chiffrer : autant le dire avant une heure de lecture.
    const meta = await race(pdf.getMetadata()).catch(() => null);
    if (meta && meta.info && meta.info.EncryptFilterName) {
      throw new Error('ce PDF est protégé (chiffré) : on ne peut pas y ajouter de texte. L\'imprimer à nouveau en PDF sans protection, puis recommencer.');
    }

    // 2. Inventaire : le texte que l'app lit déjà sur chaque feuille (rapide, aucun rendu).
    const survey = [];
    for (let n = 1; n <= N; n++) {
      const page = await race(pdf.getPage(n));
      const ex = await race(extractPage(page));
      survey.push({ n, w: ex.w, h: ex.h, items: ex.items });
      page.cleanup();
      work(`Inventaire des feuilles… ${n}/${N}`, 0.02 + 0.03 * (n / N));
    }
    const only = pageSet(params.get('pages'), N);
    const todo = survey.filter((sp) => (!only || only.has(sp.n)) && (force || sp.items.length < MIN_TEXT));
    const withText = survey.filter((sp) => sp.items.length >= MIN_TEXT).length;
    if (!todo.length) {
      work('Rien à lire.', 1, '');
      say(withText === N
        ? `Ce plan contient déjà du texte sur ses ${N} feuilles : l'app peut le lire tel quel, il n'y a rien à préparer.`
        : 'Aucune feuille à lire dans la sélection demandée.', 'ok');
      $('#actions').style.display = 'flex';
      $('#save').style.display = 'none';
      $('#copy').style.display = 'none';
      $('#force').hidden = false;
      return;
    }
    logPage(`${file.name} — ${N} feuilles, ${mo(file.size)}. À lire : ${todo.length}` +
      `${withText ? ` · déjà en texte, laissées telles quelles : ${withText}` : ''} · lecture à ${DPI} DPI, ${WORKERS} fils` +
      ` (mémoire du navigateur : environ ${memGo(WORKERS)} Go)`);

    // L'écriture (étape 6) relit le fichier avec pdf-lib, plus strict que pdf.js sur certains PDF mal
    // formés. On l'essaie MAINTENANT : un refus après une ou deux heures de lecture perdrait tout.
    // (~60 ms pour 36 Mo.)
    work('Vérification du fichier…', 0.05, '');
    {
      const probe = await race(PDFLib.PDFDocument.load(new Uint8Array(await file.arrayBuffer()),
        { updateMetadata: false, throwOnInvalidObject: false }).catch(() => null));
      const n = probe ? probe.getPages().length : 0;
      if (n !== N) {
        throw new Error(`ce PDF est mal formé (${n} feuilles lisibles pour l'écriture, sur ${N}) : on ne pourrait pas y ajouter ` +
          'le texte lu. L\'imprimer à nouveau en PDF, puis recommencer.');
      }
    }

    // 3. Moteur OCR : modèles et runtime téléchargés une fois depuis ce site, copiés dans chaque worker.
    work('Chargement du moteur de lecture (30 Mo, une seule fois)…', 0.05, '');
    job.pool = new OcrPool({ workers: WORKERS });
    await race(job.pool.init());

    // 4. Lecture, feuille par feuille. Une seule feuille en mémoire à la fois (ses blocs rendus).
    const S = DPI / 72;
    const size = (sp) => planTiles(Math.round(sp.w * S), Math.round(sp.h * S)).length;
    const total = todo.reduce((s, sp) => s + size(sp), 0);
    let before = 0, words = 0, detShare = 0.55;
    const tOcr = performance.now();
    const ocrItems = new Map();   // indice de page → éléments OCR (format extract.js + géométrie PDF)
    for (const [k, sp] of todo.entries()) {
      const page = await race(pdf.getPage(sp.n));
      if (k === 0) {
        // Résolution des images de la première feuille : au-dessous de ~250 DPI, les petites bulles
        // sont illisibles quelle que soit la résolution de lecture (mesuré à 200 DPI : 3 sur 12).
        const im = await race(imagesOf(page)).catch(() => null);
        if (im && im.n) {
          logPage(`Images de la feuille ${sp.n} : ${im.n}, environ ${im.dpi} DPI` +
            `${im.dpi < 250 ? ' — résolution faible : les petits textes des bulles seront mal lus' : ''}`);
          debug.images = im;
        }
        page.cleanup();
      }
      const raster = new PageRaster(page, S, {
        annotationMode: pdfjsLib.AnnotationMode.ENABLE, cancelled: () => job.cancelled,
      });
      const tiles = size(sp);
      const tp = performance.now();
      const onProgress = ({ stage, done, total: t }) => {
        const fp = stage === 'det' ? detShare * (done / t) : detShare + (1 - detShare) * (done / t);
        const f = (before + fp * tiles) / total;
        const el = performance.now() - tOcr;
        const eta = f > 0.02 && el > 15000 ? ` · reste environ ${duree((el * (1 - f)) / f)}` : '';
        const lus = words + (stage === 'rec' ? done : 0);
        work(`Feuille ${k + 1}/${todo.length} (page ${sp.n}) — ${stage === 'det' ? 'repérage du texte' : 'lecture des mots'} ${Math.round((100 * done) / t)} %`,
          0.06 + 0.84 * f, `${plural(lus, 'mot lu', 'mots lus')} jusqu'ici${eta}`);
      };
      let raw, second, tr, rendersBefore;
      try {
        raw = await race(job.pool.recognizeImage(raster, { onProgress }));
        // Mots d'un ou deux caractères au sens douteux, relus dans l'autre sens (ocr/recheck.js) :
        // un bout de cote verticale lu « 8 » deviendrait sinon une étiquette de détail.
        tr = performance.now();
        rendersBefore = raster.renders;
        second = await race(recheck(raw, raster, (crops) => job.pool.readCrops(crops)));
        tr = performance.now() - tr;
      } finally {
        raster.release();
        page.cleanup();
      }
      const st = raw.stats || {};
      if (st.detMs && st.recMs) detShare = 0.5 * detShare + 0.5 * (st.detMs / (st.detMs + st.recMs));

      // Pixels du rendu → repère d'extract.js (viewport à l'échelle 1) et géométrie PDF du mot.
      const vp = raster.viewport;
      const toPdf = (x, y) => vp.convertToPdfPoint(x, y);
      // Feuille mixte (un peu de vrai texte + une image) : un mot déjà présent n'est pas doublé.
      const inText = (x, y) => sp.items.some((t) => x >= t.x0 - 1 && x <= t.x1 + 1 && y >= t.y0 - 1 && y <= t.y1 + 1);
      const items = [];
      for (const r of raw) {
        const s = r.s.trim();
        if (!s) continue;
        const x0 = r.x0 / S, y0 = r.y0 / S, x1 = r.x1 / S, y1 = r.y1 / S;
        if (sp.items.length && inText((x0 + x1) / 2, (y0 + y1) / 2)) continue;
        // Sens tel que le moteur l'a lu, ou tel que recheck l'a tranché pour un mot court ambigu.
        const ang = r.ang;
        const flat = Math.abs(ang) < 0.1 || Math.abs(Math.abs(ang) - Math.PI) < 0.1;
        items.push({
          s, x0, y0, x1, y1, size: flat ? y1 - y0 : x1 - x0, horiz: Math.abs(ang) < 0.1, ang, src: 't',
          ocr: true, conf: r.conf, g: wordGeometry(r, toPdf),
        });
      }
      ocrItems.set(sp.n - 1, items);
      words += items.length;
      before += tiles;
      const ms = performance.now() - tp;
      logPage(`p${sp.n} : ${plural(items.length, 'mot', 'mots')} · ${st.tiles} zones (${st.blank} blanches) · ${duree(ms)}`);
      debug.pages.push({ n: sp.n, ms: Math.round(ms), stats: st, renders: raster.renders,
        recheck: { ms: Math.round(tr), renders: raster.renders - rendersBefore, changes: second },
        words: items.map(({ s, x0, y0, x1, y1, ang, conf }) => ({ s, x0, y0, x1, y1, ang, conf })) });
    }
    job.pool.terminate();
    job.pool = null;
    debug.timing.ocrMs = Math.round(performance.now() - tOcr);
    // La suite dure quelques secondes et écrit le fichier : plus rien à annuler.
    $('#running').style.display = 'none';
    if (!words) {
      // Rien de neuf (feuilles blanches, ou tout le texte lu était déjà dans le PDF) : pas de fichier.
      work('Rien de neuf.', 1, '');
      say('Aucun mot nouveau n\'a été lu : il n\'y a rien à ajouter à ce PDF, aucun fichier n\'a été écrit.', 'ok');
      debug.done = true;
      return;
    }

    // 5. Tout le plan au format d'extract.js : buildIndex apprend les numéros de feuille, puis les
    // renvois presque bien lus sont rattrapés. Seuls les mots de l'OCR sont touchés.
    work('Numéros de feuille et renvois…', 0.91, '');
    const doc = { pages: survey.map((sp, i) => ({ w: sp.w, h: sp.h, items: [...sp.items, ...(ocrItems.get(i) || [])] })) };
    const fromOcr = (it) => !!it.ocr;
    const fixes = fixTitleBlocks(doc, fromOcr);
    const ix = buildIndex(doc);
    fixes.push(...fixSheetRefs(doc, ix, fromOcr));
    debug.corrections = fixes;
    await task.destroy();   // libère le PDF chargé par pdf.js avant de relire le fichier
    task = null;

    // 6. Écriture : fichier d'origine intact + couche de texte (mise à jour incrémentale).
    work('Écriture du PDF…', 0.93, '');
    const pages = new Map();
    for (const [i, items] of ocrItems) pages.set(i, items.map((it) => ({ s: it.s, ...it.g })));
    let out;
    {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await buildTextUpdate(PDFLib, bytes, pages, { numPages: N });
      out = res.mode === 'incremental'
        ? new Blob([file, res.appendix], { type: 'application/pdf' })
        : new Blob([res.bytes], { type: 'application/pdf' });
      debug.output = { mode: res.mode, size: out.size, words: res.words, appendix: res.appendix ? res.appendix.length : null };
    }
    const outName = `${file.name.replace(/\.pdf$/i, '')}-texte.pdf`;
    lastUrl = URL.createObjectURL(out);
    const a = $('#save');
    a.href = lastUrl;
    a.download = outName;
    a.style.display = '';
    a.click();

    // 7. Contre-épreuve : le PDF écrit, relu comme l'app le lira (extract.js + detect.js).
    work('Vérification du PDF écrit…', 0.95, '');
    const back = pdfjsLib.getDocument({
      data: new Uint8Array(await out.arrayBuffer()), standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`, isEvalSupported: false, verbosity: 0,
    });
    let text;
    try {
      const pdf2 = await back.promise;
      const doc2 = await extractDocument(pdf2, (n, t) => work(`Vérification du PDF écrit… ${n}/${t}`, 0.95 + 0.04 * (n / t)));
      const ix2 = buildIndex(doc2);
      const st = ix2.stats;
      const walls = ix2.pages.reduce((n, p) => n + p.hotspots.filter((h) => h.kind === 'sheet' && h.label).length, 0);
      // Nom du mur trouvé sur sa feuille = cercle rouge à l'arrivée. Sans lui, l'app ouvre la bonne
      // feuille mais ne montre pas le mur. detect.js n'accepte ce nom qu'à 0,9 × le corps du document :
      // sur un plan lu par OCR, la marge est mince. On le dit ici, feuille réelle à l'appui.
      const unnamed = ix2.walls.filter((w) => w.places.every((pl) => !pl.target));
      debug.check = { stats: { ...st, orphans: st.orphans.length }, walls, wallNames: { found: ix2.walls.length - unnamed.length, total: ix2.walls.length } };
      const L = [];
      L.push(`PRÉPARATION — ${outName}`);
      L.push(`${plural(todo.length, 'feuille lue', 'feuilles lues')} à ${DPI} DPI en ${duree(performance.now() - t0)} · ` +
        `${plural(debug.output.words, 'mot écrit', 'mots écrits')} · ${mo(file.size)} → ${mo(out.size)}` +
        `${debug.output.mode === 'full' ? ' (fichier réécrit en entier : fin du PDF d\'origine illisible)' : ''}`);
      L.push(`Ce que l'app y trouvera : ${plural(walls, 'marqueur de mur', 'marqueurs de mur')} · ` +
        `${plural(st.detailRefs, 'renvoi de détail', 'renvois de détail')} · ${plural(st.labels, 'cible', 'cibles')} · ${st.resolved} renvois branchés`);
      if (ix2.walls.length) {
        L.push(`Noms de mur trouvés sur leur feuille (mur surligné à l'arrivée) : ${ix2.walls.length - unnamed.length} sur ${ix2.walls.length}` +
          `${unnamed.length ? ` — sans surlignage : ${unnamed.map((w) => w.label).join(', ')} (l'app ouvre la bonne feuille, sans cercle sur le mur)` : ''}`);
      }
      L.push('');
      L.push(`── CORRECTIONS DE NUMÉROS DE FEUILLE : ${fixes.length} ──`);
      for (const c of fixes) L.push(`p${c.page + 1} « ${c.from} » → « ${c.to} » (${c.why}) à (${c.x},${c.y})`);
      if (!fixes.length) L.push('(aucune)');
      L.push('');
      L.push(analyseReport(outName, out.size, doc2, ix2));
      text = L.join('\n');
    } catch (e) {
      // Le fichier est déjà enregistré : un échec de relecture n'annule rien, il se signale.
      text = `PRÉPARATION — ${outName}\nLe PDF a été écrit, mais sa relecture a échoué : ${e && e.message ? e.message : e}`;
      debug.checkError = String(e && e.message ? e.message : e);
    } finally {
      back.destroy().catch(() => {});
    }
    debug.timing.totalMs = Math.round(performance.now() - t0);
    work('Terminé.', 1, `${plural(debug.output.words, 'mot écrit', 'mots écrits')} en ${duree(debug.timing.totalMs)}`);
    say(`Le PDF préparé a été enregistré : « ${outName} ». C'est lui qu'il faut importer dans l'app, sur le téléphone. ` +
      'Le rapport ci-dessous dit ce que l\'app y trouvera.', 'ok');
    showReport(text);
    $('#actions').style.display = 'flex';
    $('#copy').style.display = '';
    debug.done = true;
  } catch (e) {
    const cancelled = job && job.cancelled;
    work(cancelled ? 'Annulé.' : 'Échec.', 0, '');
    say(cancelled ? 'Lecture annulée : aucun fichier n\'a été écrit.' : `Erreur : ${e && e.message ? e.message : e}`, cancelled ? '' : 'err');
    debug.error = String(e && e.message ? e.message : e);
  } finally {
    if (job && job.pool) job.pool.terminate();
    if (task) task.destroy().catch(() => {});
    if (lock) lock.release().catch(() => {});
    job = null;
    $('#running').style.display = 'none';
    $('#drop').classList.remove('busy');
    $('#file').value = '';
  }
}

$('#file').addEventListener('change', (e) => prepare(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); prepare(e.dataTransfer.files[0]); });
$('#cancel').addEventListener('click', stopJob);
$('#force').addEventListener('click', () => prepare(lastFile, { force: true }));
window.addEventListener('beforeunload', (e) => { if (job) { e.preventDefault(); e.returnValue = ''; } });

$('#copy').addEventListener('click', async () => {
  const text = $('#report').textContent;
  try { await navigator.clipboard.writeText(text); $('#copy').textContent = 'Copié ✓'; }
  catch {
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents($('#report')); sel.removeAllRanges(); sel.addRange(range);
    $('#copy').textContent = 'Sélectionné : Ctrl+C';
  }
  setTimeout(() => { $('#copy').textContent = 'Copier le rapport'; }, 2500);
});
