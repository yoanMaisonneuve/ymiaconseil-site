// worker.js — un moteur OCR (engine.js) dans un Web Worker de type module.
//
// Un seul fil d'exécution WASM par worker : GitHub Pages n'envoie pas les en-têtes COOP/COEP,
// donc pas de SharedArrayBuffer, donc pas de threads WASM. Le parallélisme vient de plusieurs
// workers (pool.js), chacun avec sa propre session onnxruntime.
//
// Rien ne sort d'ici vers le réseau : les seules requêtes sont celles des modèles et du runtime
// (fichiers statiques du site). Les pixels du plan arrivent et repartent par postMessage.
//
// Messages reçus → réponses (même id) :
//   { type:'init', id, models?, keys?, wasm?, opts? }  → { id, ok }       (models absents : on les télécharge ici)
//   { type:'det',  id, image }                          → { id, boxes }    (repère de l'image reçue)
//   { type:'read', id, crops }                          → { id, reads }    (découpes de makeCrop)
//   { type:'ocr',  id, image, opts? }                   → { id, items }    (page entière dans ce seul worker)

import * as ort from './vendor/ort/ort.wasm.min.mjs';
import { OcrEngine } from './engine.js';

const HERE = new URL('./', import.meta.url);
const MODELS = {
  det: 'models/ch_PP-OCRv4_det_infer.onnx',
  rec: 'models/ch_PP-OCRv4_rec_infer.onnx',
  cls: 'models/ch_ppocr_mobile_v2.0_cls_infer.onnx',
};

let engine = null;

async function fetchBytes(path) {
  const r = await fetch(new URL(path, HERE));
  if (!r.ok) throw new Error(`${path} : HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function init(msg) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', HERE).href;
  // Binaire WASM déjà téléchargé par le pool : un seul transfert de 14 Mo pour N workers.
  if (msg.wasm) ort.env.wasm.wasmBinary = msg.wasm;
  const m = msg.models || {};
  const [det, rec, cls, keys] = await Promise.all([
    m.det || fetchBytes(MODELS.det),
    m.rec || fetchBytes(MODELS.rec),
    m.cls || fetchBytes(MODELS.cls),
    msg.keys || fetch(new URL('models/ppocr_keys.txt', HERE)).then((r) => r.text()),
  ]);
  engine = new OcrEngine(ort, msg.opts || {});
  await engine.load({ det, rec, cls, keys });
  // Une lecture à vide, tout de suite : un dictionnaire qui ne va pas avec le modèle de lecture
  // (fichier tronqué, mauvaise version) se voit ici, pas après des minutes de repérage du texte.
  const blank = { width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4).fill(255) };
  await engine.recognize([blank]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await init(msg);
      self.postMessage({ id: msg.id, ok: true });
    } else if (msg.type === 'det') {
      const t = performance.now();
      const boxes = await engine.detect(msg.image);
      self.postMessage({ id: msg.id, boxes, ms: performance.now() - t });
    } else if (msg.type === 'read') {
      const t = performance.now();
      const reads = await engine.readCrops(msg.crops);
      self.postMessage({ id: msg.id, reads, ms: performance.now() - t });
    } else if (msg.type === 'ocr') {
      const items = await engine.recognizeImage(msg.image, msg.opts || {});
      self.postMessage({ id: msg.id, items, stats: items.stats });
    }
  } catch (err) {
    // Le message seul : c'est lui qu'affiche la page (la pile ne dit rien à l'utilisateur).
    self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
  }
};
