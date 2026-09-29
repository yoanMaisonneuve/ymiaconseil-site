// diag.js — rejoue le détecteur de « Plans d'atelier » sur un PDF et dit ce qu'il a vu.
//
// Pourquoi une page à part : un plan de 300 Mo ne voyage pas (courriel, GitHub), et il appartient
// au chantier. Ici il est lu dans le navigateur, avec les MÊMES modules que l'app (extract.js,
// detect.js), et seul un rapport texte en sort — collé à la main par celui qui le lit.
//
// Pourquoi hors de /plan/ : le service worker de l'app sert sa propre page à toute navigation
// sous /plan/. Une page diag.html posée là afficherait l'app, sur tout appareil qui l'a déjà ouverte.

import * as pdfjsLib from '../plan/vendor/pdfjs/pdf.min.mjs';
import { extractDocument } from '../plan/extract.js';
import { buildIndex, DETECT_VERSION } from '../plan/detect.js';
import { analyseReport } from './report.js';

const VENDOR = new URL('../plan/vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;

const $ = (s) => document.querySelector(s);
let current = null; // { name, doc }

function work(msg, frac) {
  $('#work').style.display = 'block';
  $('#workMsg').textContent = msg;
  if (frac != null) $('#bar').firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

function show(text, isError) {
  const r = $('#report');
  r.style.display = 'block';
  r.textContent = text;
  r.classList.toggle('err', !!isError);
}

// ── Sonde : ce que pdf.js reçoit AVANT extract.js ─────────────────────────────
// Un plan où Ctrl+F trouve « A-202 » mais où l'app ne lit aucun texte : il faut savoir si pdf.js
// voit des opérations de texte (police illisible ?), du dessin seul (texte vectorisé), une image
// (scan), ou des calques éteints. Trois premières pages : assez pour conclure, pas trop long.
async function probe(pdf) {
  const L = ['── SONDE pdf.js ──'];
  try {
    const meta = await pdf.getMetadata();
    const inf = (meta && meta.info) || {};
    L.push(`Producteur : ${inf.Producer || '?'} · Créateur : ${inf.Creator || '?'} · PDF ${inf.PDFFormatVersion || '?'}` +
      `${inf.IsAcroFormPresent ? ' · formulaire' : ''}${inf.IsXFAPresent ? ' · XFA' : ''}`);
  } catch (e) { L.push(`Métadonnées illisibles : ${e.message}`); }
  try {
    const oc = await pdf.getOptionalContentConfig();
    const groups = oc ? [...oc] : [];
    const off = groups.filter(([, g]) => !g.visible).length;
    L.push(`Calques : ${groups.length}${groups.length ? ` (${off} éteints)` : ''}`);
  } catch (e) { L.push(`Calques illisibles : ${e.message}`); }

  const OPS = pdfjsLib.OPS;
  const TEXT_OPS = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const IMG_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  for (let n = 1; n <= Math.min(3, pdf.numPages); n++) {
    try {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent({ includeMarkedContent: true });
      const texts = tc.items.filter((it) => typeof it.str === 'string');
      const nonEmpty = texts.filter((it) => it.str.trim());
      const fonts = Object.values(tc.styles || {}).map((s) => s.fontFamily);
      const ol = await page.getOperatorList();
      let nText = 0, nImg = 0, nPath = 0, nForm = 0;
      for (const fn of ol.fnArray) {
        if (TEXT_OPS.has(fn)) nText++;
        else if (IMG_OPS.has(fn)) nImg++;
        else if (fn === OPS.constructPath) nPath++;
        else if (fn === OPS.paintFormXObjectBegin) nForm++;
      }
      const ann = await page.getAnnotations({ intent: 'display' }).catch(() => []);
      const kinds = {};
      for (const a of ann) kinds[a.subtype] = (kinds[a.subtype] || 0) + 1;
      L.push(`p${n} ${Math.round(vp.width)}×${Math.round(vp.height)} rot ${page.rotate} | textContent ${texts.length} (non vides ${nonEmpty.length})` +
        ` · polices ${fonts.length} | ops texte ${nText} · tracés ${nPath} · images ${nImg} · formes ${nForm}` +
        ` | annotations ${ann.length}${ann.length ? ` ${JSON.stringify(kinds)}` : ''}`);
      if (texts.length) L.push(`   échantillon : ${JSON.stringify(texts.slice(0, 8).map((it) => it.str))}`);
      if (fonts.length) L.push(`   polices : ${[...new Set(fonts)].slice(0, 4).join(', ')}`);
      page.cleanup();
    } catch (e) { L.push(`p${n} sonde impossible : ${e.message}`); }
  }
  return L.join('\n');
}

// Données texte : tout ce que detect.js reçoit, pour le rejouer ailleurs sans le PDF.
async function exportGz(name, doc) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const data = {
    // v2 : `raw`, la hauteur de boîte lue par l'OCR avant redressement (0 hors OCR, voir extract.js).
    v: 2, fichier: name, detecteur: DETECT_VERSION,
    champs: ['s', 'x0', 'y0', 'x1', 'y1', 'size', 'horiz', 'ang', 'src', 'raw'],
    pages: doc.pages.map((p) => ({
      w: r3(p.w), h: r3(p.h),
      items: p.items.map((it) => [it.s, r3(it.x0), r3(it.y0), r3(it.x1), r3(it.y1), r3(it.size), it.horiz ? 1 : 0, r3(it.ang || 0), it.src, r3(it.raw || 0)]),
    })),
  };
  const blob = new Blob([JSON.stringify(data)]);
  const gz = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(gz);
  a.download = `${name.replace(/\.pdf$/i, '')}-texte.json.gz`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function run(file) {
  if (!file) return;
  $('#actions').style.display = 'none';
  $('#dlNote').hidden = true;
  current = null;
  let task = null;
  try {
    work('Lecture du fichier…', 0.02);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const size = bytes.byteLength;
    if (!String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('Ce fichier n\'est pas un PDF.');
    work('Ouverture du PDF…', 0.05);
    task = pdfjsLib.getDocument({
      data: bytes, standardFontDataUrl: `${VENDOR}standard_fonts/`, wasmUrl: `${VENDOR}wasm/`,
      isEvalSupported: false, verbosity: 0,
    });
    const pdf = await task.promise;
    const doc = await extractDocument(pdf, (n, t) => work(`Lecture des feuilles… ${n}/${t}`, 0.05 + 0.85 * (n / t)));
    work('Repérage des renvois…', 0.93);
    const ix = buildIndex(doc);
    current = { name: file.name, doc };
    work('Sonde pdf.js…', 0.96);
    show(`${analyseReport(file.name, size, doc, ix)}\n\n${await probe(pdf)}`);
    work('Terminé.', 1);
    $('#actions').style.display = 'flex';
    $('#dlNote').hidden = false;
  } catch (e) {
    work('Échec.', 0);
    show(`Erreur : ${e && e.message ? e.message : e}`, true);
  } finally {
    // Libère le PDF (300 Mo) : seules les données texte restent en mémoire.
    if (task) task.destroy().catch(() => {});
  }
}

$('#file').addEventListener('change', (e) => run(e.target.files[0]));
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); run(e.dataTransfer.files[0]); });

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
$('#dl').addEventListener('click', () => current && exportGz(current.name, current.doc));
