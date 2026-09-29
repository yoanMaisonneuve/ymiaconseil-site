// pdftext.js — ajoute à un PDF une couche de texte INVISIBLE, mot par mot, là où l'OCR l'a lu.
//
// Même principe qu'OCRmyPDF : mode de rendu 3 (ni rempli ni tracé), Helvetica, un mot = un Tj
// dont la boîte tombe exactement sur l'image du mot. Le dessin ne change pas d'un pixel ; pdf.js,
// Ctrl+F et l'app lisent le texte.
//
// Pourquoi une MISE À JOUR INCRÉMENTALE plutôt que réécrire le fichier : un plan imprimé en image
// pèse jusqu'à 300 Mo. On laisse le fichier d'origine intact, octet pour octet, et on ajoute à sa
// fin une petite section : les nouveaux objets (police, flux de texte, dictionnaires de page mis à
// jour) et une table de références qui renvoie (/Prev) à l'ancienne. Sortie = original + section.
// Rien n'est recopié ni ré-encodé : les images ne peuvent pas bouger, et le navigateur n'a pas à
// fabriquer un deuxième fichier de 300 Mo en mémoire (un Blob [fichier, section] suffit).
// pdf-lib sert à lire la structure (pages, ressources héritées) et à écrire les objets.
//
// Module pur : pdf-lib est INJECTÉ, rien du DOM. Tourne tel quel dans Node pour les tests.

// Nom de ressource de la police ajoutée ; suffixé s'il est déjà pris sur la page.
const FONT_KEY = 'FOcr';

// ── Géométrie d'un mot ──────────────────────────────────────────────────────

// Un mot lu par l'OCR (boîte en pixels du rendu, angle de sa ligne de base dans le repère écran,
// comme extract.js) → origine de la ligne de base, directions et tailles dans l'espace du PDF.
// toPdf(x, y) : pixel du rendu → point PDF (viewport.convertToPdfPoint de pdf.js). Passer par le
// viewport règle d'un coup l'échelle, l'origine de la MediaBox et la rotation (/Rotate) de la page.
//
//   ang 0      lu de gauche à droite : ligne de base en bas de la boîte, le haut des lettres vers le haut ;
//   ang π      à l'envers : ligne de base en haut, départ à droite ;
//   ang −π/2   de bas en haut (la cote DAO ordinaire) : ligne de base à droite, départ en bas ;
//   ang +π/2   de haut en bas : ligne de base à gauche, départ en haut.
export function wordGeometry(it, toPdf) {
  const { x0, y0, x1, y1 } = it;
  const a = it.ang || 0;
  let o, u, v, len, size;
  if (Math.abs(a) < 0.1) { o = [x0, y1]; u = [1, 0]; v = [0, -1]; len = x1 - x0; size = y1 - y0; }
  else if (Math.abs(Math.abs(a) - Math.PI) < 0.1) { o = [x1, y0]; u = [-1, 0]; v = [0, 1]; len = x1 - x0; size = y1 - y0; }
  else if (a < 0) { o = [x1, y1]; u = [0, -1]; v = [-1, 0]; len = y1 - y0; size = x1 - x0; }
  else { o = [x0, y0]; u = [0, 1]; v = [1, 0]; len = y1 - y0; size = x1 - x0; }
  const P = toPdf(o[0], o[1]);
  const U = toPdf(o[0] + u[0], o[1] + u[1]);
  const V = toPdf(o[0] + v[0], o[1] + v[1]);
  const ux = U[0] - P[0], uy = U[1] - P[1], vx = V[0] - P[0], vy = V[1] - P[1];
  const ku = Math.hypot(ux, uy) || 1, kv = Math.hypot(vx, vy) || 1;
  return { o: [P[0], P[1]], u: [ux / ku, uy / ku], v: [vx / kv, vy / kv], len: len * ku, size: size * kv };
}

// ── Texte → WinAnsi ─────────────────────────────────────────────────────────

// Le dictionnaire de l'OCR est chinois d'origine : il rend parfois la ponctuation en pleine chasse
// (« （ », « ： », « ， »). Helvetica en WinAnsi ne l'a pas : on la ramène à l'ASCII, et on jette ce
// qui reste inencodable (un idéogramme lu dans une hachure) plutôt que d'échouer.
const SUBST = {
  '　': ' ', '、': ',', '。': '.', '「': '"', '」': '"', '‘': '\'', '’': '\'',
  '·': '.', '−': '-', '‐': '-', '‑': '-', '‒': '-', '′': '\'', '″': '"',
};
export function sanitizeWinAnsi(s, canEncode) {
  let out = '';
  for (const ch of String(s).normalize('NFC')) {
    const cp = ch.codePointAt(0);
    let c = ch;
    if (cp >= 0xFF01 && cp <= 0xFF5E) c = String.fromCharCode(cp - 0xFEE0);
    else if (SUBST[ch]) c = SUBST[ch];
    if (canEncode(c.codePointAt(0))) out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ── Écriture ────────────────────────────────────────────────────────────────

const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

// Octets ASCII d'une chaîne (le flux de contenu n'a que de l'ASCII : le texte y est en hexadécimal).
const ascii = (s) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
};

// Fin du fichier d'origine : où commence sa dernière table de références (→ /Prev de la nôtre), de
// quel type elle est (table classique ou flux /XRef, notre section suit le même), et son /Size.
// null si la fin du fichier ne se lit pas proprement : on réécrira alors tout le fichier.
export function readTail(bytes) {
  const n = bytes.length;
  const tail = latin1(bytes.subarray(Math.max(0, n - 4096)));
  const k = tail.lastIndexOf('startxref');
  if (k < 0) return null;
  const m = /^startxref\s+(\d+)/.exec(tail.slice(k));
  if (!m) return null;
  const prev = Number(m[1]);
  if (!(prev > 0 && prev < n)) return null;
  const head = latin1(bytes.subarray(prev, Math.min(n, prev + 4096)));
  let stream, size;
  if (/^\s*xref\b/.test(head)) {
    stream = false;
    const t = tail.lastIndexOf('trailer');
    const s = t >= 0 ? /\/Size\s+(\d+)/.exec(tail.slice(t)) : null;
    size = s ? Number(s[1]) : 0;
  } else if (/^\s*\d+\s+\d+\s+obj\b/.test(head)) {
    stream = true;
    const end = head.indexOf('stream');
    const s = /\/Size\s+(\d+)/.exec(end > 0 ? head.slice(0, end) : head);
    size = s ? Number(s[1]) : 0;
  } else return null;
  return { prev, stream, size, endsWithEol: bytes[n - 1] === 0x0a || bytes[n - 1] === 0x0d };
}

// Largeurs Helvetica des codes WinAnsi 32…255, écrites dans le dictionnaire de police : sans elles,
// chaque lecteur prend les métriques qu'il connaît pour « Helvetica ». Avec elles, la largeur d'un
// mot est la même partout — celle qu'on a calculée pour qu'il couvre sa boîte.
function winAnsiWidths(emb) {
  const byCode = new Map();   // code WinAnsi → nom de glyphe
  for (const [code, name] of Object.values(emb.encoding.unicodeMappings)) if (!byCode.has(code)) byCode.set(code, name);
  const w = [];
  for (let c = 32; c <= 255; c++) w.push(byCode.has(c) ? emb.widthOfGlyph(byCode.get(c)) : 0);
  return w;
}

// Largeur d'un texte en Helvetica, SANS crénage : un Tj n'en applique pas (pdf-lib, lui, en ajoute
// dans widthOfTextAtSize), et c'est la largeur rendue qui doit tomber sur la boîte.
function advance(emb, text, size) {
  let w = 0;
  for (const g of emb.encodeTextAsGlyphs(text)) w += emb.widthOfGlyph(g.name);
  return (w * size) / 1000;
}

// Flux de contenu d'une page : un seul BT…ET, mode 3, un Tm + Tj par mot. Tf et Tz ne sont réémis
// que s'ils changent (ils font partie de l'état graphique, pas du bloc BT).
function pageStream(words, emb, fontKey, wrapped) {
  const L = [];
  if (wrapped) L.push('Q');                 // referme le « q » posé devant le contenu d'origine
  L.push('BT', '3 Tr');
  let lastSize = null, lastTz = null, n = 0;
  for (const w of words) {
    const text = w.text;
    if (!text || !(w.size > 0) || !(w.len > 0)) continue;
    const adv = advance(emb, text, w.size);
    if (!(adv > 0)) continue;
    const size = num(w.size), tz = num((100 * w.len) / adv);
    if (size !== lastSize) { L.push(`/${fontKey} ${size} Tf`); lastSize = size; }
    if (tz !== lastTz) { L.push(`${tz} Tz`); lastTz = tz; }
    // Chaque mot dans sa propre séquence marquée : pdf.js coupe là ses éléments de texte. Sans elle,
    // deux mots voisins de même corps sur une même ligne (« A-202 » puis « RÉF:N/A ») deviendraient
    // un seul élément, et le renvoi ne serait plus reconnu. Un mot lu = un élément relu, même boîte.
    L.push('/Span BMC');
    L.push(`${num(w.u[0])} ${num(w.u[1])} ${num(w.v[0])} ${num(w.v[1])} ${num(w.o[0])} ${num(w.o[1])} Tm`);
    L.push(`${emb.encodeText(text).toString()} Tj`, 'EMC');
    n++;
  }
  L.push('ET', '');
  return { text: L.join('\n'), n };
}

// Écrit les objets donnés à la suite du fichier d'origine : section « obj … endobj » + références.
function serialize(L, entries, tail, trailer, base) {
  const { PDFName, PDFNumber, PDFRef, PDFCrossRefStream } = L;
  const enc = (s) => ascii(s);
  const chunks = [];
  let off = base;
  const push = (b) => { chunks.push(b); off += b.length; };
  if (!tail.endsWithEol) push(enc('\n'));
  const offsets = [];
  const writeObj = (ref, obj) => {
    offsets.push([ref, off]);
    push(enc(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    const b = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(b, 0);
    push(b);
    push(enc('\nendobj\n'));
  };
  entries.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  for (const [ref, obj] of entries) writeObj(ref, obj);

  let xrefAt;
  if (!tail.stream) {
    // Table classique : sous-sections d'objets consécutifs, entrées de 20 octets pile.
    xrefAt = off;
    // L'entrée 0 (tête de la liste des objets libres) en tête, comme Acrobat : certains lecteurs
    // tiennent pour abîmée une table de mise à jour qui ne commence pas à 0.
    const lines = ['xref', '0 1', '0000000000 65535 f\r'];
    for (let i = 0; i < offsets.length;) {
      let j = i;
      while (j + 1 < offsets.length && offsets[j + 1][0].objectNumber === offsets[j][0].objectNumber + 1) j++;
      lines.push(`${offsets[i][0].objectNumber} ${j - i + 1}`);
      for (let k = i; k <= j; k++) {
        lines.push(`${String(offsets[k][1]).padStart(10, '0')} ${String(offsets[k][0].generationNumber).padStart(5, '0')} n\r`);
      }
      i = j + 1;
    }
    push(enc(`${lines.join('\n')}\ntrailer\n`));
    const b = new Uint8Array(trailer.sizeInBytes());
    trailer.copyBytesInto(b, 0);
    push(b);
    push(enc(`\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    // Flux /XRef : le fichier d'origine en a un, notre section en porte un aussi. Il se référence
    // lui-même (numéro suivant le plus grand) ; /Size compte donc cet objet.
    const selfRef = PDFRef.of(trailer.get(PDFName.of('Size')).asNumber());
    trailer.set(PDFName.of('Size'), PDFNumber.of(selfRef.objectNumber + 1));
    const xs = PDFCrossRefStream.of(trailer, [], true);
    for (const [ref, at] of offsets) xs.addUncompressedEntry(ref, at);
    xrefAt = off;
    xs.addUncompressedEntry(selfRef, xrefAt);
    push(enc(`${selfRef.objectNumber} 0 obj\n`));
    const b = new Uint8Array(xs.sizeInBytes());
    xs.copyBytesInto(b, 0);
    push(b);
    push(enc(`\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }
  const out = new Uint8Array(off - base);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// pages : Map(indice de page → [{ s, o, u, v, len, size }]) en espace PDF (voir wordGeometry).
// Rend { mode: 'incremental', appendix } — à mettre bout à bout avec le fichier d'origine —
// ou, si la fin du fichier est illisible, { mode: 'full', bytes } : le fichier entier réécrit.
export async function buildTextUpdate(L, bytes, pages, { numPages } = {}) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, StandardFontEmbedder, StandardFonts } = L;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  const pageList = doc.getPages();
  if (numPages != null && pageList.length !== numPages) {
    throw new Error(`arbre des pages illisible (${pageList.length} pages trouvées, ${numPages} attendues)`);
  }
  const tail = readTail(bytes);
  // Les nouveaux objets prennent des numéros LIBRES dans le fichier d'origine : au-delà de son /Size.
  if (tail && tail.size > ctx.largestObjectNumber + 1) ctx.largestObjectNumber = tail.size - 1;

  const emb = StandardFontEmbedder.for(StandardFonts.Helvetica);
  const fontRef = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 255, Widths: winAnsiWidths(emb),
  }));
  const written = [[fontRef, ctx.lookup(fontRef)]];
  let qRef = null;
  let words = 0;
  const perPage = [];

  for (const [pi, list] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const pg = pageList[pi];
    if (!pg) throw new Error(`page ${pi + 1} absente de l'arbre des pages`);
    const leaf = pg.node;
    const clean = list.map((w) => ({ ...w, text: sanitizeWinAnsi(w.s, emb.encoding.canEncodeUnicodeCodePoint) }))
      .filter((w) => w.text);
    if (!clean.length) continue;

    // Contenu d'origine, tel quel : un flux, ou un tableau de flux (éventuellement indirect).
    const raw = leaf.get(PDFName.of('Contents'));
    let orig = [];
    if (raw instanceof PDFRef) {
      const o = ctx.lookup(raw);
      orig = o instanceof PDFArray ? o.asArray() : [raw];
    } else if (raw instanceof PDFArray) orig = raw.asArray();
    else if (raw) orig = [raw];
    // Le contenu d'origine peut laisser une matrice de transformation modifiée (« cm » sans « Q ») :
    // on l'encadre par q … Q, dans deux petits flux à part, sans toucher à ses octets.
    const wrapped = orig.length > 0;
    if (wrapped && !qRef) {
      qRef = ctx.register(ctx.stream('q\n'));
      written.push([qRef, ctx.lookup(qRef)]);
    }

    // Ressources : celles que la page voit (héritées du nœud parent le cas échéant), recopiées dans
    // un dictionnaire propre à la page, plus notre police. Les valeurs sont partagées, pas copiées.
    const res0 = leaf.Resources();
    const res = PDFDict.withContext(ctx);
    if (res0) for (const [k, v] of res0.entries()) res.set(k, v);
    const font0 = res0 ? ctx.lookupMaybe(res0.get(PDFName.of('Font')), PDFDict) : undefined;
    const fonts = PDFDict.withContext(ctx);
    if (font0) for (const [k, v] of font0.entries()) fonts.set(k, v);
    let key = FONT_KEY;
    while (fonts.has(PDFName.of(key))) key += 'x';
    fonts.set(PDFName.of(key), fontRef);
    res.set(PDFName.of('Font'), fonts);

    const { text, n } = pageStream(clean, emb, key, wrapped);
    if (!n) continue;
    const textRef = ctx.register(ctx.flateStream(ascii(text)));
    written.push([textRef, ctx.lookup(textRef)]);

    const nd = PDFDict.withContext(ctx);
    for (const [k, v] of leaf.entries()) nd.set(k, v);
    nd.set(PDFName.of('Contents'), ctx.obj(wrapped ? [qRef, ...orig, textRef] : [textRef]));
    nd.set(PDFName.of('Resources'), res);
    written.push([pg.ref, nd]);
    ctx.assign(pg.ref, nd);   // pour la voie « réécriture complète »
    words += n;
    perPage.push({ page: pi, words: n });
  }

  if (!tail) {
    const full = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    return { mode: 'full', bytes: full, words, perPage };
  }
  const T = ctx.trailerInfo;
  const trailer = PDFDict.withContext(ctx);
  trailer.set(PDFName.of('Size'), PDFNumber.of(ctx.largestObjectNumber + 1));
  if (T.Root) trailer.set(PDFName.of('Root'), T.Root);
  if (T.Info) trailer.set(PDFName.of('Info'), T.Info);
  if (T.ID) trailer.set(PDFName.of('ID'), T.ID);
  trailer.set(PDFName.of('Prev'), PDFNumber.of(tail.prev));
  const appendix = serialize(L, written, tail, trailer, bytes.length);
  return { mode: 'incremental', appendix, words, perPage };
}
