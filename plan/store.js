// store.js — tout ce que l'app garde, elle le garde dans le téléphone (IndexedDB).
// Rien ne part sur un serveur : les dessins d'atelier appartiennent au client.
//
//   plans  : la fiche d'un plan (nom, index de navigation, dernière position)
//   files  : les octets du PDF
//   bases  : les fonds de page déjà rendus, en image — pour rouvrir une feuille sans recalcul

const DB_NAME = 'plans-atelier';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('bases')) db.createObjectStore('bases');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('base de données bloquée par un autre onglet'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction annulée'));
    result = fn(t);
  }));
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listPlans() {
  const all = await tx(['plans'], 'readonly', (t) => req2p(t.objectStore('plans').getAll()));
  const list = await all;
  return list.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}

export async function getPlan(id) {
  return (await tx(['plans'], 'readonly', (t) => req2p(t.objectStore('plans').get(id))));
}

export async function getFile(id) {
  return (await tx(['files'], 'readonly', (t) => req2p(t.objectStore('files').get(id))));
}

export function savePlan(plan) {
  return tx(['plans'], 'readwrite', (t) => { t.objectStore('plans').put(plan); });
}

export function saveNewPlan(plan, bytes) {
  return tx(['plans', 'files'], 'readwrite', (t) => {
    t.objectStore('plans').put(plan);
    t.objectStore('files').put(bytes, plan.id);
  });
}

// Retire un plan du téléphone. Le PDF d'origine, lui, reste où l'utilisateur l'a rangé.
export function removePlan(id) {
  return tx(['plans', 'files', 'bases'], 'readwrite', (t) => {
    t.objectStore('plans').delete(id);
    t.objectStore('files').delete(id);
    const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
    t.objectStore('bases').delete(range);
  });
}

export async function getBase(id, page, bucket) {
  try {
    return (await tx(['bases'], 'readonly', (t) => req2p(t.objectStore('bases').get(`${id}:${page}:${bucket}`)))) || null;
  } catch {
    return null;
  }
}

export async function putBase(id, page, bucket, blob) {
  try {
    await tx(['bases'], 'readwrite', (t) => { t.objectStore('bases').put(blob, `${id}:${page}:${bucket}`); });
  } catch {
    // Quota plein : le fond sera simplement recalculé la prochaine fois.
  }
}

export async function askPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* sans gravité */ }
  return false;
}

// Empreinte courte du fichier : reconnaître un plan déjà importé sans le relire en entier.
export async function fingerprint(bytes, name) {
  const head = bytes.subarray(0, Math.min(bytes.length, 1 << 16));
  const tail = bytes.subarray(Math.max(0, bytes.length - (1 << 16)));
  const buf = new Uint8Array(head.length + tail.length);
  buf.set(head, 0); buf.set(tail, head.length);
  let hex = '';
  if (crypto && crypto.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    hex = [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    let h = 2166136261;
    for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 16777619); }
    hex = (h >>> 0).toString(16) + name.length.toString(16);
  }
  return `${hex}-${bytes.length.toString(36)}`;
}
