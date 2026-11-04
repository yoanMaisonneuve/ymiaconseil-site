// i18n.js — la langue de l'app (03.11.2026 ; Yoan, 19:34 : la page Facebook de PlanJump, en anglais).
//
// Le français reste la source : chaque texte est sa propre clé, et il s'affiche tel quel si sa traduction manque.
// La langue : ?lang=en ou ?lang=fr (gardée sur l'appareil), sinon celle choisie avant, sinon celle du téléphone.
// Termes : renvoi = callout ; feuille = sheet ; coupe = section ; cote = dimension ; dessins d'atelier = shop drawings.

const CLE = 'pj-langue';

function choisir() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'fr') { localStorage.setItem(CLE, q); return q; }
    const m = localStorage.getItem(CLE);
    if (m === 'en' || m === 'fr') return m;
  } catch (_) { /* un navigateur sans stockage : la langue du téléphone */ }
  const n = (navigator.languages && navigator.languages[0]) || navigator.language || 'fr';
  return /^en\b/i.test(n) ? 'en' : 'fr';
}

export const LANGUE = choisir();

export const EN = {
  // L'accueil et les panneaux (index.html)
  "Plans d'atelier": 'Shop drawings',
  'Un clic sur un mur ouvre sa feuille. Un clic sur une coupe ouvre son détail.': 'Tap a wall to open its sheet. Tap a section to open its detail.',
  'Ouvrir un plan PDF': 'Open a PDF plan',
  "Une fois le plan ouvert, l'app fonctionne sans réseau, même dans un sous-sol de béton.": 'Once the plan is open, the app works with no signal, even in a concrete basement.',
  'Mes plans': 'My plans',
  'Comment ça marche': 'How it works',
  "Ouvre le PDF des dessins d'atelier. L'app le lit une fois et repère tous les renvois.": 'Open the PDF of your shop drawings. The app reads it once and finds every callout.',
  "Sur la vue d'ensemble, touche un mur (MR03) : tu arrives sur sa feuille.": 'On the overview, tap a wall (MR03): you land on its sheet.',
  "Sur l'élévation, touche une coupe (5 / 300) : tu arrives sur le détail 5 de la feuille A-300.": 'On the elevation, tap a section (5 / 300): you land on detail 5 of sheet A-300.',
  'Le gros bouton': 'The big',
  Retour: 'Back',
  'te ramène exactement où tu étais.': 'button takes you back to exactly where you were.',
  'Chargement…': 'Loading…',
  'Feuilles et détails': 'Sheets and details',
  'Lecture du plan…': 'Reading the plan…',
  'Dépose le PDF ici': 'Drop the PDF here',
  'Voir toute la feuille': 'See the whole sheet',
  "Vue d'ensemble": 'Overview',
  Fermer: 'Close',
  'Chercher : 18, MR03, A-302…': 'Search: 18, MR03, A-302…',
  // La visionneuse (app.js)
  'Préparation {a}/{b}': 'Preparing {a}/{b}',
  '{s} mm sur le plan = {po}': '{s} mm on the plan = {po}',
  'Le marqueur indique {f}, mais {l} est dessiné sur {g}.': 'The marker says {f}, but {l} is drawn on {g}.',
  'Détail {d}': 'Detail {d}',
  Feuille: 'Sheet',
  'Feuille {f}': 'Sheet {f}',
  'étiquette introuvable': 'label not found',
  'Détail {d} — il y en a {n} sur {f}': 'Detail {d}: there are {n} on {f}',
  'Détail {d}, feuille {f}': 'Detail {d}, sheet {f}',
  '{x}, {y} sur la feuille': '{x}, {y} on the sheet',
  'Détail {d} : étiquette introuvable sur {f}.': 'Detail {d}: label not found on {f}.',
  'Détail {d} : la bulle est vide sur le dessin. Déduit par élimination — à confirmer.': 'Detail {d}: the bubble is empty on the drawing. Worked out by elimination, please confirm.',
  'Détail {d} — INV. : à lire inversé.': 'Detail {d}, INV.: read it reversed.',
  'Détail {d} — SIM. : détail similaire.': 'Detail {d}, SIM.: similar detail.',
  'Celui du haut': 'The top one',
  'Celui du bas': 'The bottom one',
  'Celui de gauche': 'The left one',
  'Celui de droite': 'The right one',
  'Lequel ?': 'Which one?',
  'Mur {m}': 'Wall {m}',
  "Voir d'où il est appelé": 'See where it is called from',
  '{n} : aucun renvoi ne pointe ici.': '{n}: no callout points here.',
  '{n} — appelé depuis': '{n}: called from',
  '{n} renvoi': '{n} callout',
  '{n} renvois': '{n} callouts',
  'Feuille {f}…': 'Sheet {f}…',
  Murs: 'Walls',
  Résultats: 'Results',
  Feuilles: 'Sheets',
  '{n} détails': '{n} details',
  'Rien ne correspond.': 'Nothing matches.',
  'Aucun renvoi détecté dans ce plan : PDF numérisé (image) ou convention différente. La navigation par feuille fonctionne quand même.': 'No callouts found in this plan: scanned PDF (image) or a different convention. Sheet navigation still works.',
  'Masquer les renvois': 'Hide callouts',
  'Afficher les renvois': 'Show callouts',
  '{a} renvois de détail · {b} renvois de feuille': '{a} detail callouts · {b} sheet callouts',
  "Cotes à leur taille d'origine": 'Dimensions at original size',
  'Grossir les cotes': 'Enlarge dimensions',
  "{n} mesures repérées · grossies jusqu'à ×2 quand elles sont trop petites": '{n} dimensions found · enlarged up to ×2 when too small',
  'Cotes en millimètres': 'Dimensions in millimeters',
  'Cotes en pouces': 'Dimensions in inches',
  'Revenir aux cotes du plan': "Back to the plan's dimensions",
  'Ce plan est en mm · converties au 1/16 po près, en vert (le rouge du plan reste rouge)': "This plan is in mm · converted to the nearest 1/16 in, in green (the plan's red stays red)",
  "Laisser l'écran s'éteindre": 'Let the screen turn off',
  "Garder l'écran allumé": 'Keep the screen on',
  'Pratique quand on mesure avec les deux mains': "Handy when you're measuring with both hands",
  'Changer de plan': 'Change plan',
  'Retour à la liste de mes plans': 'Back to my plans',
  'Cotes en pouces, au 1/16 près. Touche une cote convertie pour voir sa valeur en mm.': 'Dimensions in inches, to the nearest 1/16. Tap a converted dimension to see its value in mm.',
  'Lecture des feuilles… {n}/{t}': 'Reading sheets… {n}/{t}',
  'Repérage des renvois…': 'Finding callouts…',
  "Ce fichier n'est pas un PDF.": 'This file is not a PDF.',
  'Enregistrement dans le téléphone…': 'Saving to the phone…',
  'Pas de place pour garder ce plan dans le téléphone. Il reste ouvert pour cette séance seulement.': 'No room to keep this plan on the phone. It stays open for this session only.',
  'Ce PDF est protégé par un mot de passe.': 'This PDF is password protected.',
  'Lecture impossible.': 'Could not read it.',
  "Impossible d'ouvrir ce plan.": 'Could not open this plan.',
  'Plan introuvable dans ce téléphone.': 'Plan not found on this phone.',
  'Plan en millimètres : menu ⋮ → « Cotes en pouces ».': 'Plan in millimeters: menu ⋮ → "Dimensions in inches".',
  '{n} renvois repérés. Touche un mur ou une coupe.': '{n} callouts found. Tap a wall or a section.',
  'Aucun renvoi repéré dans ce plan. Navigation par feuille seulement.': 'No callouts found in this plan. Sheet navigation only.',
  "Aucun plan pour l'instant. Ouvre le PDF des dessins d'atelier : il sera gardé ici, prêt à rouvrir sans réseau.": 'No plans yet. Open the PDF of your shop drawings: it stays here, ready to reopen with no signal.',
  'Options du plan': 'Plan options',
  Ouvrir: 'Open',
  'Retirer de ce téléphone': 'Remove from this phone',
  "Le fichier PDF d'origine n'est pas touché": 'The original PDF file is not touched',
  'Retirer « {p} » de ce téléphone ?': 'Remove "{p}" from this phone?',
  "PlanJump vient d'être mis à jour.": 'PlanJump was just updated.',
};

export function t(fr, v) {
  let s = LANGUE === 'en' && EN[fr] !== undefined ? EN[fr] : fr;
  if (v) for (const k of Object.keys(v)) s = s.split(`{${k}}`).join(v[k]);
  return s;
}

// « Le 1er, le 2e » : un ordinal ne se traduit pas par une table.
export const rang = (n) => (LANGUE === 'en' ? `No. ${n}` : `Le ${n}${n === 1 ? 'er' : 'e'}`);

/** Les textes écrits dans index.html : chaque morceau de texte et chaque attribut est cherché dans la table. */
export function traduirePage() {
  document.documentElement.lang = LANGUE;
  if (LANGUE !== 'en') return;
  document.title = 'PlanJump';
  const net = (s) => s.trim().replace(/\s+/g, ' ');
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const noeuds = [];
  while (w.nextNode()) noeuds.push(w.currentNode);
  for (const n of noeuds) {
    if (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
    const cle = net(n.textContent);
    // L'espace autour du texte reste : « Le gros bouton <b>Retour</b> te ramène… » se lit d'un seul tenant.
    if (cle && EN[cle] !== undefined) n.textContent = n.textContent.replace(n.textContent.trim(), EN[cle]);
  }
  for (const a of ['aria-label', 'placeholder', 'title']) {
    for (const e of document.querySelectorAll(`[${a}]`)) {
      const cle = net(e.getAttribute(a));
      if (EN[cle] !== undefined) e.setAttribute(a, EN[cle]);
    }
  }
}

export function changerLangue(l) {
  try { localStorage.setItem(CLE, l); } catch (_) { /* tant pis : la langue revient au téléphone */ }
  const u = new URL(location.href);
  u.searchParams.set('lang', l);
  location.href = u.href;
}
