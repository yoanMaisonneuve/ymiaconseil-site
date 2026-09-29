// pool.js — répartit l'OCR d'UNE page sur plusieurs workers (worker.js).
//
// Pourquoi pas un worker par page : une page de 300 DPI fait ~50 tuiles, et l'utilisateur attend
// la première page avant de juger. On découpe donc la page elle-même :
//   1. détection : chaque tuile non blanche part vers le premier worker libre ;
//   2. fusion des boîtes coupées par les tuiles (ici, sur le fil principal : c'est léger) ;
//   3. lecture : les découpes, triées par allongement, partent par paquets vers les workers.
// Les pixels voyagent par postMessage (tampons transférés, pas copiés) ; rien ne sort du navigateur.

import { DEFAULTS, asSource, planTiles, isBlank, toImageBoxes, mergeBoxes, makeCrop, finalize } from './engine.js';

const HERE = new URL('./', import.meta.url);

export function defaultWorkerCount() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, hc - 1));
}

class Slot {
  constructor(url) {
    this.w = new Worker(url, { type: 'module' });
    this.seq = 0;
    this.wait = new Map();
    this.w.onmessage = (e) => {
      const p = this.wait.get(e.data.id);
      if (!p) return;
      this.wait.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    this.w.onerror = (e) => {
      for (const p of this.wait.values()) p.reject(new Error(e.message || 'worker OCR en erreur'));
      this.wait.clear();
    };
  }
  call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.wait.set(id, { resolve, reject });
      this.w.postMessage({ ...msg, id }, transfer);
    });
  }
  // Un worker terminé ne répond plus jamais : ses appels en attente sont rejetés ici, sinon
  // init() ou une lecture resteraient suspendus pour toujours.
  kill() {
    this.w.terminate();
    for (const p of this.wait.values()) p.reject(new Error('annulé'));
    this.wait.clear();
  }
}

// Pixels à céder à un worker : un tampon transféré est vidé chez l'expéditeur. Si la source a
// rendu une vue sur un plus grand tampon (la page entière), on copie d'abord la région.
const own = (data) => (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice());

// Chaque slot tire la tâche suivante dès qu'il est libre : les tuiles denses ne bloquent pas les autres.
async function drain(slots, tasks, run) {
  let next = 0;
  await Promise.all(slots.map(async (slot) => {
    while (next < tasks.length) {
      const i = next++;
      await run(slot, tasks[i], i);
    }
  }));
}

export class OcrPool {
  constructor({ workers = defaultWorkerCount(), workerUrl = new URL('worker.js', HERE), opts = {} } = {}) {
    this.n = workers;
    this.url = workerUrl;
    this.o = { ...DEFAULTS, ...opts };
    this.slots = [];
    // « Annuler » peut tomber pendant le téléchargement des modèles, AVANT que les workers existent :
    // terminate() coupe alors les téléchargements et marque le pool mort, pour qu'init() n'en crée
    // aucun ensuite (sinon N workers de ~0,3 Go chacun restaient en vie, et s'additionnaient).
    this.dead = false;
    this.ctl = new AbortController();
  }

  // Télécharge modèles et runtime UNE fois ici, puis en donne une copie à chaque worker.
  async init() {
    const { signal } = this.ctl;
    // Statut vérifié : une page d'erreur HTML (404) passerait sinon pour un modèle, et l'échec
    // n'arriverait qu'au chargement, sous la forme d'une erreur de protobuf incompréhensible.
    const fetchOk = async (p) => {
      const r = await fetch(new URL(p, HERE), { signal });
      if (!r.ok) throw new Error(`fichier du moteur introuvable sur le site : ${p} (HTTP ${r.status})`);
      return r;
    };
    const get = async (p) => new Uint8Array(await (await fetchOk(p)).arrayBuffer());
    const [det, rec, cls, wasm, keys] = await Promise.all([
      get('models/ch_PP-OCRv4_det_infer.onnx'),
      get('models/ch_PP-OCRv4_rec_infer.onnx'),
      get('models/ch_ppocr_mobile_v2.0_cls_infer.onnx'),
      get('vendor/ort/ort-wasm-simd-threaded.wasm'),
      fetchOk('models/ppocr_keys.txt').then((r) => r.text()),
    ]).catch((e) => { throw this.dead ? new Error('annulé') : e; });
    if (this.dead) throw new Error('annulé');
    this.slots = Array.from({ length: this.n }, () => new Slot(this.url));
    await Promise.all(this.slots.map((s) => s.call({
      type: 'init', models: { det, rec, cls }, keys, wasm: wasm.buffer, opts: this.o,
    })));
    // terminate() pendant le chargement des sessions : les slots sont déjà tués, on le dit.
    if (this.dead) throw new Error('annulé');
    return this;
  }

  // img : ImageData, ou source { width, height, region(x,y,w,h) → ImageData | Promise }.
  // Rend [{ s, conf, x0, y0, x1, y1, vertical, ang }] en pixels de l'image (voir engine.js).
  // opts de cet appel : tuilage, tuiles blanches, text_score, onProgress. Les seuils du réseau
  // (thresh, box_thresh, cls…) sont ceux donnés au constructeur, fixés dans les workers à init().
  async recognizeImage(img, opts = {}) {
    if (this.dead) throw new Error('annulé');
    const o = { ...this.o, ...opts };
    const src = asSource(img);
    const tiles = planTiles(src.width, src.height, o);
    const t0 = performance.now();

    // Boîtes rangées par tuile, pas par ordre d'arrivée : l'ordre des boîtes départage les découpes
    // de même allongement dans les lots de lecture, donc le résultat au dernier chiffre près.
    // Rangées ainsi, 1 ou 4 workers donnent exactement la même chose que le moteur seul.
    const perTile = tiles.map(() => []);
    let blank = 0, done = 0;
    await drain(this.slots, tiles, async (slot, t) => {
      const px = await src.region(t.x, t.y, t.w, t.h);
      if (isBlank(px, o)) blank++;
      else {
        const image = { width: px.width, height: px.height, data: own(px.data) };
        const r = await slot.call({ type: 'det', image }, [image.data.buffer]);
        perTile[t.index] = toImageBoxes(t, r.boxes, src.width, src.height);
      }
      o.onProgress?.({ stage: 'det', done: ++done, total: tiles.length });
    });
    const boxes = mergeBoxes(perTile.flat());
    const t1 = performance.now();

    // Mêmes lots que RapidOCR (et qu'OcrEngine.recognize) : découpes triées par allongement, par 6.
    // Un paquet = des lots entiers et consécutifs, donc le worker refait exactement ces lots-là.
    const crops = [];
    for (const b of boxes) crops.push(await makeCrop(src, b));
    const order = crops.map((_, i) => i).sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height);
    // Coût d'un lot ≈ nombre × largeur, et la largeur est celle du plus allongé (au moins 320 px) :
    // une ligne de note de 1500 px coûte cinq bulles. On équilibre donc les paquets par coût,
    // et les plus chers partent en premier — sinon le dernier worker finit seul.
    const batches = [];
    for (let i = 0; i < order.length; i += o.recBatch) {
      const idx = order.slice(i, i + o.recBatch);
      const r = Math.max(o.recW / o.recH, ...idx.map((k) => crops[k].width / crops[k].height));
      batches.push({ idx, cost: idx.length * Math.trunc(o.recH * r) });
    }
    const budget = batches.reduce((s, b) => s + b.cost, 0) / (this.slots.length * 6);
    const packs = [];
    let cur = null;
    for (const b of batches) {
      if (!cur || cur.cost >= budget) packs.push(cur = { idx: [], cost: 0 });
      cur.idx.push(...b.idx); cur.cost += b.cost;
    }
    packs.sort((a, b) => b.cost - a.cost);
    const reads = new Array(crops.length);
    let readDone = 0;
    await drain(this.slots, packs, async (slot, { idx }) => {
      // Tampons transférés : après envoi, seule la marque « vertical » sert encore ici (finalize).
      const list = idx.map((k) => ({ width: crops[k].width, height: crops[k].height, data: own(crops[k].data), vertical: crops[k].vertical }));
      const r = await slot.call({ type: 'read', crops: list }, list.map((c) => c.data.buffer));
      idx.forEach((k, j) => { reads[k] = r.reads[j]; });
      readDone += idx.length;
      o.onProgress?.({ stage: 'rec', done: readDone, total: crops.length });
    });

    const items = finalize(boxes, crops, reads, o);
    items.stats = { tiles: tiles.length, blank, boxes: boxes.length, detMs: t1 - t0, recMs: performance.now() - t1, workers: this.slots.length };
    return items;
  }

  // Relecture de quelques découpes déjà prêtes (seconde lecture d'ocr/recheck.js) :
  // [{ width, height, data, vertical }] → [{ s, conf, flip }], dans le même ordre.
  async readCrops(crops) {
    if (this.dead) throw new Error('annulé');
    const out = new Array(crops.length);
    const per = Math.max(this.o.recBatch, Math.ceil(crops.length / this.slots.length));
    const packs = [];
    for (let i = 0; i < crops.length; i += per) packs.push(crops.slice(i, i + per).map((_, j) => i + j));
    await drain(this.slots, packs, async (slot, idx) => {
      const list = idx.map((k) => ({ width: crops[k].width, height: crops[k].height, data: own(crops[k].data), vertical: crops[k].vertical }));
      const r = await slot.call({ type: 'read', crops: list }, list.map((c) => c.data.buffer));
      idx.forEach((k, j) => { out[k] = r.reads[j]; });
    });
    if (this.dead) throw new Error('annulé');
    return out;
  }

  terminate() {
    this.dead = true;
    this.ctl.abort();
    for (const s of this.slots) s.kill();
    this.slots = [];
  }
}
