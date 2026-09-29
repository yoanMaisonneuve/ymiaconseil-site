// recheck.js — seconde lecture des mots courts dont le sens (droit ou couché) est douteux.
//
// Le moteur décide du sens d'une boîte par sa seule forme (règle de RapidOCR : couchée si h/l ≥ 1,5).
// Pour un mot d'un ou deux caractères, la forme ne suffit pas :
//   - un bout de cote verticale (« 100 », « 22.3 ») tient parfois dans une boîte à peine plus haute
//     que large. Lu droit, il donne un chiffre seul (« 8 », « 3 ») que detect.js prend pour le numéro
//     d'une étiquette de détail — mesuré sur A-300 : un renvoi vers 08 ou 03 menait sur une cote ;
//   - à l'inverse, un caractère droit mais étroit (le « E » d'une petite bulle) a une boîte assez
//     haute pour passer pour couchée, et detect.js ne le voit plus au-dessus de son numéro de feuille.
// On relit donc ces boîtes-là dans l'autre sens, et on ne change le verdict du moteur que sur une
// preuve nette. Pas de classifieur d'orientation ici : sur ces petites découpes, il se trompait de
// sens (« 22.3 » lu « sz ») ; on lit plutôt les deux quarts de tour et on garde le meilleur.
//
// Module sans DOM : recheck() reçoit la source de pixels et la fonction de lecture (le pool).

import { rot90ccw, rot180 } from './engine.js';

// Tirés des lectures du jeu d'essai (captures Westbury, 600 DPI), cas par cas :
const MIN_HW = 1.0;        // boîte droite à relire couchée : au moins aussi haute que large
const MAX_FLAT = 1.8;      // boîte couchée d'un caractère à relire droite : moins de 1,8 fois plus haute
const LONGER_CONF = 0.75;  // lecture couchée plus longue : « 100 » (0,79) contre « 8 » (0,94)
const LONGER_DROP = 0.2;   // … et pas beaucoup moins sûre que la lecture droite
const SURER_CONF = 0.95;   // lecture couchée différente, même longueur : il faut qu'elle soit
const SURER_GAP = 0.15;    // quasi certaine ET nettement plus sûre (« E » 0,994 contre « m » 0,993)

const chars = (s) => [...String(s || '').trim()].length;
const alnum = (s) => (String(s || '').match(/[0-9A-Za-z]/g) || []).length;

// Boîtes à relire : 'turn' = lue droite, à relire couchée ; 'flat' = lue couchée, à relire droite.
export function pickRecheck(raw) {
  const picks = [];
  raw.forEach((r, i) => {
    const n = chars(r.s), hw = (r.y1 - r.y0) / Math.max(1, r.x1 - r.x0);
    if (!r.vertical && n >= 1 && n <= 2 && hw >= MIN_HW) picks.push({ i, mode: 'turn' });
    else if (r.vertical && n === 1 && hw < MAX_FLAT) picks.push({ i, mode: 'flat' });
  });
  return picks;
}

// Verdicts. reads : pour 'turn', deux lectures (quart de tour anti-horaire, puis horaire) ; pour
// 'flat', une (la découpe droite). Modifie raw sur place, rend le journal des changements.
export function applyRecheck(raw, picks, reads) {
  const log = [];
  let k = 0;
  for (const p of picks) {
    const r = raw[p.i];
    const s0 = r.s.trim();
    if (p.mode === 'turn') {
      const a = reads[k++], b = reads[k++];
      // Anti-horaire : se lit de haut en bas (+90°, comme finalize) ; horaire : de bas en haut,
      // la cote DAO ordinaire (−90°).
      const t = (b && b.conf > (a ? a.conf : 0)) ? { ...b, ang: -Math.PI / 2 } : { ...a, ang: Math.PI / 2 };
      const s1 = String(t.s || '').trim();
      if (!s1) continue;
      // Une lecture couchée PLUS LONGUE : la boîte contient plusieurs caractères couchés, pas un
      // seul droit. Un caractère droit relu couché ne donne pas trois caractères sûrs.
      const longer = alnum(s1) > alnum(s0) && t.conf >= LONGER_CONF && t.conf >= r.conf - LONGER_DROP;
      // Même longueur : seulement une lecture différente, quasi certaine et nettement plus sûre.
      // Une lecture identique ne prouve rien (« 8 », « 0 » se lisent dans les deux sens).
      const surer = s1 !== s0 && t.conf >= SURER_CONF && t.conf - r.conf >= SURER_GAP;
      if (!longer && !surer) continue;
      log.push({ from: s0, to: s1, conf: [round(r.conf), round(t.conf)], why: longer ? 'couché, plus long' : 'couché, plus sûr', x0: r.x0, y0: r.y0 });
      Object.assign(r, { s: s1, conf: t.conf, vertical: true, ang: t.ang });
    } else {
      const u = reads[k++];
      // Remis droit seulement si la lecture droite dit la même chose : lu seulement couché, un
      // caractère étroit se trompe (J→1, Y→V, Z→7 mesurés) et deviendrait un faux haut de bulle.
      if (!u || String(u.s || '').trim() !== s0) continue;
      log.push({ from: s0, to: s0, conf: [round(r.conf), round(u.conf)], why: 'droit, confirmé', x0: r.x0, y0: r.y0 });
      Object.assign(r, { conf: Math.max(r.conf, u.conf), vertical: false, ang: 0 });
    }
  }
  return log;
}

const round = (v) => Math.round(v * 1000) / 1000;

// src : { region(x, y, w, h) } (pixels de la page, comme pour le moteur) ; readCrops : découpes →
// lectures (pool.readCrops). Les boîtes du moteur sont en pixels entiers de src.
export async function recheck(raw, src, readCrops) {
  const picks = pickRecheck(raw);
  if (!picks.length) return [];
  const crops = [];
  for (const p of picks) {
    const r = raw[p.i];
    const px = await src.region(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    if (p.mode === 'turn') {
      const a = rot90ccw(px);
      crops.push(a, rot180(a));
    } else crops.push(px);
  }
  // Sens imposé : aucune découpe ne passe par le classifieur d'orientation.
  for (const c of crops) c.vertical = false;
  const reads = await readCrops(crops);
  return applyRecheck(raw, picks, reads);
}
