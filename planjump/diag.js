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
import { buildIndex, DETECT_VERSION, normSheet, sheetKey } from '../plan/detect.js';

const VENDOR = new URL('../plan/vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdf.worker.min.mjs`;

// Copies des règles de detect.js (non exportées), pour EXPLIQUER un rejet — jamais pour décider.
// Si detect.js change ces seuils, le rapport doit suivre : il le dit en tête (version du détecteur).
const SHEET_RE = /^[A-Z]{1,3}[-. ]?\d{2,4}[A-Z]?$/;
const DETAIL_TOP_RE = /^(\d{1,3}[A-Z]?|[A-Z])(?:[\s\-–]*(INV|SIM|TYP|OPP|MIR)\.?)?$/;
const DOTTED_WALL_RE = /^[A-Z]{2,4}-?\d{1,3}\.\d{1,2}[A-Z]?$/;
const MAX_LINES = 120;

const $ = (s) => document.querySelector(s);
const cx = (it) => (it.x0 + it.x1) / 2;
const cy = (it) => (it.y0 + it.y1) / 2;
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const f2 = (v) => (Math.round(v * 100) / 100).toString();
const inBox = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const q = (s) => `« ${s} »`;

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

// ── Pourquoi un texte de feuille n'a pas trouvé son partenaire au-dessus ─────────
// Mêmes critères que findTop() dans detect.js, dans le même ordre.
function whyNot(t, b, isSheetName) {
  const m = Math.min(t.size, b.size);
  const ratio = t.size / b.size;
  const dy = cy(b) - cy(t);
  const dx = Math.abs(cx(t) - cx(b));
  const checks = [
    ['horizontal', t.horiz],
    ['pas un nom de feuille', !isSheetName(t)],
    [`corps ${f2(ratio)}× (0,6–1,7)`, ratio >= 0.6 && ratio <= 1.7],
    [`écart vertical ${f2(dy / m)}m (0,45–1,9)`, dy >= 0.45 * m && dy <= 1.9 * m],
    [`décalage ${f2(dx / m)}m (≤ 0,8)`, dx <= 0.8 * m],
    [`${t.s.length} car. (≤ 12)`, t.s.length <= 12],
  ];
  const fails = checks.filter(([, ok]) => !ok).map(([k]) => k);
  const detail = DETAIL_TOP_RE.test(t.s.toUpperCase());
  return { fails, detail, text: `${q(t.s)} corps ${f1(t.size)} ${t.src}` };
}

function analyseReport(name, bytes, doc, ix) {
  const L = [];
  const st = ix.stats;
  L.push(`DIAGNOSTIC Plans d'atelier — détecteur v${DETECT_VERSION}`);
  L.push(`Fichier : ${name} (${f1(bytes / 1e6)} Mo), ${st.pages} pages`);
  L.push(`Renvois : ${st.hotspots} (détail ${st.detailRefs}, feuille ${st.sheetRefs}) · étiquettes ${st.labels} · résolus ${st.resolved} · non résolus ${st.unresolved} · jetés ${st.jetes}`);
  L.push('');

  // Feuilles connues du document, comme detect.js les indexe (clé sans trait d'union).
  const keys = new Set(ix.sheets.map((s) => sheetKey(String(s.id).replace(/\s*\(p\.\d+\)$/, ''))));
  const isSheetName = (it) => keys.has(sheetKey(it.s));
  const isSheetRef = (it) => it.horiz && isSheetName(it) && SHEET_RE.test(normSheet(it.s));

  // ── 1. Une ligne par page ──
  L.push('── PAGES ──');
  const noSheet = [];
  doc.pages.forEach((pg, i) => {
    const sh = ix.sheets[i];
    const op = ix.pages[i];
    const nT = pg.items.filter((it) => it.src === 't').length;
    const nA = pg.items.length - nT;
    const det = op.hotspots.filter((h) => h.kind === 'detail');
    const unres = det.filter((h) => !h.target).length;
    if (/^P\d+$/.test(sh.id)) noSheet.push(i + 1);
    L.push(`p${i + 1} ${sh.id}${sh.title ? ` — ${sh.title}` : ''} | texte ${nT} · annot ${nA} | renvois détail ${det.length}` +
      `${unres ? ` (${unres} sans étiquette)` : ''} · feuille ${op.hotspots.length - det.length} | étiquettes ${op.labels.length}` +
      `${nT + nA === 0 ? ' | ⚠ AUCUN TEXTE (scan ?)' : ''}`);
  });
  if (noSheet.length) L.push(`⚠ Numéro de feuille non trouvé : pages ${noSheet.join(', ')}`);
  L.push('');

  // ── 2. Renvois vers une feuille du document restés sans lien ──
  // Un texte « A-202 » hors cartouche, non couvert par un renvoi ni par un titre de vue :
  // on montre ce qui est posé juste au-dessus, et le critère de findTop() qui l'a écarté.
  L.push('── TEXTES DE FEUILLE SANS LIEN (et pourquoi) ──');
  let lines = 0, hidden = 0;
  const letterOk = [];
  doc.pages.forEach((pg, i) => {
    const op = ix.pages[i];
    const boxes = [...op.hotspots, ...op.labels.filter((l) => l.titleMark)];
    for (const b of pg.items) {
      if (!isSheetRef(b) || cx(b) > 0.85 * pg.w) continue;
      const covering = op.hotspots.find((h) => inBox(cx(b), cy(b), h));
      if (covering) {
        // Où mène la bulle : une lettre d'axe (E, F en orange) prise pour l'étiquette se voit à sa position.
        if (covering.kind === 'detail' && /^[A-Z]$/.test(covering.detail)) {
          const tg = covering.target;
          letterOk.push(`p${i + 1} ${covering.detail}/${covering.sheet} (${Math.round(cx(b))},${Math.round(cy(b))})` +
            (tg ? ` → p${covering.page + 1} (${Math.round(cx(tg))},${Math.round(cy(tg))})` : ' → étiquette introuvable'));
        }
        continue;
      }
      if (boxes.some((h) => inBox(cx(b), cy(b), h))) continue;
      if (lines >= MAX_LINES) { hidden++; continue; }
      const big = Math.max(b.size, 1);
      const above = pg.items
        .filter((t) => t !== b && cy(t) < cy(b) && cy(b) - cy(t) < 4 * Math.max(big, t.size) && Math.abs(cx(t) - cx(b)) < 3 * Math.max(big, t.size))
        .sort((a, c) => Math.hypot(cx(a) - cx(b), cy(a) - cy(b)) - Math.hypot(cx(c) - cx(b), cy(c) - cy(b)))
        .slice(0, 2);
      const head = `p${i + 1} ${q(b.s)} (${Math.round(cx(b))},${Math.round(cy(b))}) corps ${f1(b.size)} ${b.src}`;
      if (!above.length) { L.push(`${head} ← rien au-dessus`); lines++; continue; }
      for (const t of above) {
        const w = whyNot(t, b, isSheetName);
        const verdict = w.fails.length ? `✗ ${w.fails.join(' · ')}` : '✓ critères OK (pris par un autre renvoi ?)';
        L.push(`${head} ← ${w.text}${w.detail ? ' [forme détail]' : ''} : ${verdict}`);
        lines++;
      }
    }
  });
  if (!lines) L.push('(aucun)');
  if (hidden) L.push(`… et ${hidden} autres, non affichés.`);
  L.push('');

  // ── 3. Coupes nommées par une lettre, reconnues ──
  L.push(`── COUPES À LETTRE RECONNUES : ${letterOk.length} ──`);
  if (letterOk.length) L.push(letterOk.slice(0, 40).join('\n') + (letterOk.length > 40 ? `\n… +${letterOk.length - 40}` : ''));
  L.push('');

  // ── 4. Noms de mur avec un point (MR5.1) ──
  const dotted = [];
  doc.pages.forEach((pg, i) => {
    for (const it of pg.items) if (it.horiz && DOTTED_WALL_RE.test(it.s.toUpperCase().trim())) dotted.push(`p${i + 1} ${it.s}`);
  });
  L.push(`── NOMS DE MUR AVEC UN POINT (info) : ${dotted.length} ──`);
  if (dotted.length) L.push(dotted.slice(0, 40).join(' · ') + (dotted.length > 40 ? ` … +${dotted.length - 40}` : ''));
  L.push('');

  // ── 5. Murs annoncés dont le nom n'a pas été trouvé sur la feuille visée ──
  const lost = ix.walls.filter((w) => w.places.every((p) => !p.target));
  L.push(`── MURS SANS CIBLE SUR LEUR FEUILLE : ${lost.length} / ${ix.walls.length} ──`);
  if (lost.length) L.push(lost.map((w) => `${w.label} → ${w.places.map((p) => p.sheet).join(', ')}`).join(' · '));

  return L.join('\n');
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
    v: 1, fichier: name, detecteur: DETECT_VERSION,
    champs: ['s', 'x0', 'y0', 'x1', 'y1', 'size', 'horiz', 'ang', 'src'],
    pages: doc.pages.map((p) => ({
      w: r3(p.w), h: r3(p.h),
      items: p.items.map((it) => [it.s, r3(it.x0), r3(it.y0), r3(it.x1), r3(it.y1), r3(it.size), it.horiz ? 1 : 0, r3(it.ang || 0), it.src]),
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
