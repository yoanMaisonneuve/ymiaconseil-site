// raster.js — une page PDF vue comme une image qu'on lit par morceaux, sans jamais l'avoir entière.
//
// À 600 DPI, une feuille de 36 × 24 po fait 21 600 × 14 400 px : 1,2 Go en RGBA, et au-delà de la
// surface maximale d'un canvas (~268 Mpx dans Chrome). Le moteur OCR n'a besoin que de régions
// (tuiles de 1536 px, puis une découpe par mot) : on rend donc la page par BLOCS avec pdf.js
// (viewport décalé, comme app.js pour ses zooms), on garde les derniers blocs rendus, et on
// recompose chaque région demandée à partir d'eux.
//
// Les demandes arrivent à peu près dans l'ordre des tuiles (ligne par ligne) : un cache de quelques
// bandes suffit, chaque bloc n'est rendu qu'une ou deux fois.

export class PageRaster {
  // page : PDFPageProxy ; scale : pixels par point ; opts.budget : octets de blocs gardés en mémoire.
  constructor(page, scale, { blockW = 2048, blockH = 512, budget = 192e6, annotationMode, cancelled } = {}) {
    this.page = page;
    this.scale = scale;
    this.viewport = page.getViewport({ scale });
    this.width = Math.round(this.viewport.width);
    this.height = Math.round(this.viewport.height);
    this.bw = blockW;
    this.bh = blockH;
    this.budget = budget;
    this.annotationMode = annotationMode;
    this.cancelled = cancelled || (() => false);
    this.cache = new Map();      // « bx,by » → { data, w, h } ; ordre d'insertion = ordre d'usage
    this.pending = new Map();    // rendus en cours, pour ne pas rendre deux fois le même bloc
    this.bytes = 0;
    this.chain = Promise.resolve();
    this.renders = 0;
    this.canvas = document.createElement('canvas');
  }

  // pdf.js dessine sur le fil principal : un rendu à la fois, les autres attendent leur tour.
  block(bx, by) {
    const key = `${bx},${by}`;
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
    if (this.pending.has(key)) return this.pending.get(key);
    const p = this.chain.then(() => this.render(bx, by)).then((b) => {
      this.pending.delete(key);
      this.cache.set(key, b);
      this.bytes += b.data.length;
      for (const [k, old] of this.cache) {
        if (this.bytes <= this.budget) break;
        this.cache.delete(k);
        this.bytes -= old.data.length;
      }
      return b;
    }, (e) => { this.pending.delete(key); throw e; });
    this.chain = p.catch(() => {});
    this.pending.set(key, p);
    return p;
  }

  async render(bx, by) {
    if (this.cancelled()) throw new Error('annulé');
    const x = bx * this.bw, y = by * this.bh;
    const w = Math.min(this.bw, this.width - x), h = Math.min(this.bh, this.height - y);
    const c = this.canvas;
    c.width = w; c.height = h;
    // Lissage forcé. Au-delà de la résolution d'une image, pdf.js coupe le lissage (pixels dupliqués,
    // fidèle à l'écran mais en escalier). Pour l'OCR c'est mauvais dès qu'on agrandit plus de 2× :
    // mesuré sur la page d'essai à 200 DPI lue à 600, 3 bulles de détail sur 12 lues en escalier,
    // 8 sur 12 en bilinéaire. Même contexte que celui que pdf.js prendra (mêmes options), dont on
    // neutralise le réglage du lissage ; le lissage par défaut du canvas est bilinéaire.
    if (!this.ctx) {
      this.ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
      Object.defineProperty(this.ctx, 'imageSmoothingEnabled', { configurable: true, get: () => true, set: () => {} });
    }
    const viewport = this.page.getViewport({ scale: this.scale, offsetX: -x, offsetY: -y });
    // Fond blanc comme l'app : une image à fond transparent se lirait comme du noir.
    const task = this.page.render({ canvas: c, viewport, background: '#ffffff', annotationMode: this.annotationMode });
    await task.promise;
    const data = this.ctx.getImageData(0, 0, w, h).data;
    this.renders++;
    return { data, w, h, x, y };
  }

  // Région [x, x+w) × [y, y+h) en RGBA, dans un tampon neuf : le pool le transfère au worker.
  async region(x, y, w, h) {
    if (this.cancelled()) throw new Error('annulé');
    const out = new Uint8ClampedArray(w * h * 4);
    const bx0 = Math.floor(x / this.bw), bx1 = Math.floor((x + w - 1) / this.bw);
    const by0 = Math.floor(y / this.bh), by1 = Math.floor((y + h - 1) / this.bh);
    const jobs = [];
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) jobs.push(this.block(bx, by));
    for (const b of await Promise.all(jobs)) {
      const cx0 = Math.max(x, b.x), cx1 = Math.min(x + w, b.x + b.w);
      const cy0 = Math.max(y, b.y), cy1 = Math.min(y + h, b.y + b.h);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      const n = (cx1 - cx0) * 4;
      for (let r = cy0; r < cy1; r++) {
        const s = ((r - b.y) * b.w + (cx0 - b.x)) * 4;
        out.set(b.data.subarray(s, s + n), ((r - y) * w + (cx0 - x)) * 4);
      }
    }
    return { width: w, height: h, data: out };
  }

  release() {
    this.cache.clear();
    this.pending.clear();
    this.bytes = 0;
    this.canvas.width = 0; this.canvas.height = 0;
  }
}
