/* Le menu de Navitek (Yoan, 18.11.2026 08:13 : « une petite bulle, trois lignes, qui ouvre un menu ; je sélectionne la page que je veux »).
   Une bulle fixe en bas à droite, sur toutes les pages de /navitek/ ; elle ouvre un tiroir sur le côté : la thèse, le robot, le cahier de
   recherche, les films, les autres robots ; sur la page de la thèse, ses chapitres. Source : navitek-recherche/menu_navitek.js, copiée par
   construire_these.py dans le site (/navitek/menu.js). Chaque générateur de page Navitek ajoute <script src="/navitek/menu.js" defer>. */
(function () {
  "use strict";
  if (window.__navitekMenu) return;
  window.__navitekMenu = true;

  var PAGES = [
    ["/navitek/these/", "La thèse", "Apprendre à marcher à un humanoïde imprimé"],
    ["/navitek/", "Le robot N0", "À imprimer : les pièces, le montage, le programme"],
    ["/navitek/recherche/", "Le cahier de recherche", "Chaque essai : la prédiction avant, le verdict après"],
    ["/navitek/telechargements/", "Téléchargements", "Le modèle de marche et ses données, par version et par date"],
    ["/navitek/reseaux/", "Les films", "Les meilleurs, le bêtisier, une journée en 45 s"],
    ["/navitek/n1/", "N1", "62 cm, des servos qui parlent"],
    ["/navitek/n2/", "N2", "Un mètre, des actionneurs imprimés (concept)"],
    ["/navitek/n3/", "N3", "1,5 m : ce qui s'imprime, ce qui ne s'imprime pas"]
  ];

  var css = [
    ".nvk-bulle{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9000;width:54px;height:54px;border-radius:50%;",
    "border:2px solid var(--gold,#d4a843);background:var(--navy,#0b1f3a);color:var(--gold,#d4a843);display:flex;align-items:center;justify-content:center;",
    "box-shadow:0 6px 18px rgba(11,31,58,.28);cursor:pointer;padding:0}",
    ".nvk-bulle:focus-visible{outline:3px solid var(--orange,#f26b1d);outline-offset:3px}",
    ".nvk-bulle span{display:block;width:22px;height:2.5px;background:currentColor;border-radius:2px;position:relative}",
    ".nvk-bulle span::before,.nvk-bulle span::after{content:'';position:absolute;left:0;width:22px;height:2.5px;background:currentColor;border-radius:2px}",
    ".nvk-bulle span::before{top:-7px}.nvk-bulle span::after{top:7px}",
    ".nvk-voile{position:fixed;inset:0;z-index:9001;background:rgba(11,31,58,.45);opacity:0;pointer-events:none;transition:opacity .2s}",
    ".nvk-voile.ouvert{opacity:1;pointer-events:auto}",
    ".nvk-tiroir{position:fixed;top:0;right:0;bottom:0;z-index:9002;width:min(340px,88vw);background:var(--paper,#fff);color:var(--ink-body,#2a2620);",
    "border-left:3px solid var(--gold,#d4a843);transform:translateX(105%);transition:transform .22s ease;display:flex;flex-direction:column;",
    "padding:calc(18px + env(safe-area-inset-top,0px)) 18px calc(18px + env(safe-area-inset-bottom,0px));overflow-y:auto;",
    "font-family:var(--body,'Lora',Georgia,serif)}",
    ".nvk-tiroir.ouvert{transform:none}",
    "@media (prefers-reduced-motion:reduce){.nvk-tiroir,.nvk-voile{transition:none}}",
    ".nvk-tete{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 14px}",
    ".nvk-tete b{font-family:var(--display,'Newsreader',Georgia,serif);font-size:19px;color:var(--navy,#0b1f3a);font-weight:600}",
    ".nvk-tete b em{font-style:normal;color:var(--gold-small,#8a6b18)}",
    ".nvk-fermer{border:1px solid var(--line,#e4e2dd);background:var(--tint,#f6f4f0);border-radius:6px;font:600 13px var(--mono,'JetBrains Mono',monospace);",
    "color:var(--navy,#0b1f3a);padding:6px 10px;cursor:pointer}",
    ".nvk-titre{font:600 11px var(--mono,'JetBrains Mono',monospace);letter-spacing:.12em;text-transform:uppercase;color:var(--gold-small,#8a6b18);margin:14px 0 6px}",
    ".nvk-tiroir ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}",
    ".nvk-tiroir a{display:block;text-decoration:none;color:var(--navy,#0b1f3a);padding:9px 10px;border-radius:6px;line-height:1.3}",
    ".nvk-tiroir a:hover,.nvk-tiroir a:focus-visible{background:var(--tint,#f6f4f0);outline:none}",
    ".nvk-tiroir a b{display:block;font-family:var(--display,'Newsreader',Georgia,serif);font-weight:600;font-size:17px}",
    ".nvk-tiroir a small{display:block;font-size:13px;color:var(--dim,#5c5c5c)}",
    ".nvk-tiroir a[aria-current]{background:var(--tint,#f6f4f0);box-shadow:inset 3px 0 0 var(--gold,#d4a843)}",
    ".nvk-tiroir .nvk-chap a{padding:6px 10px;font-size:14.5px}",
    ".nvk-pied{margin-top:auto;padding-top:16px;font-size:13px;color:var(--dim,#5c5c5c)}",
    ".nvk-pied a{display:inline;padding:0;color:var(--orange-texte,#b5490c)}"
  ].join("");

  function norm(p) { return p.replace(/index\.html$/, "").replace(/\/?$/, "/"); }

  function construire() {
    var st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);

    var ici = norm(location.pathname);
    var bulle = document.createElement("button");
    bulle.type = "button";
    bulle.className = "nvk-bulle";
    bulle.setAttribute("aria-label", "Ouvrir le menu de Navitek");
    bulle.setAttribute("aria-expanded", "false");
    bulle.setAttribute("aria-controls", "nvk-tiroir");
    bulle.innerHTML = "<span aria-hidden='true'></span>";

    var voile = document.createElement("div");
    voile.className = "nvk-voile";

    var tiroir = document.createElement("nav");
    tiroir.className = "nvk-tiroir";
    tiroir.id = "nvk-tiroir";
    tiroir.setAttribute("aria-label", "Les pages de Navitek");
    tiroir.setAttribute("aria-hidden", "true");
    tiroir.inert = true;

    var h = "<div class='nvk-tete'><b>Navitek <em>Robolabs</em></b><button type='button' class='nvk-fermer'>Fermer</button></div>";
    h += "<p class='nvk-titre'>Les pages</p><ul>";
    PAGES.forEach(function (p) {
      var cur = norm(p[0]) === ici;
      h += "<li><a href='" + p[0] + "'" + (cur ? " aria-current='page'" : "") + "><b>" + p[1] + "</b><small>" + p[2] + "</small></a></li>";
    });
    h += "</ul>";
    // les chapitres de la page courante (la thèse : ses h2 numérotés)
    var chaps = Array.prototype.slice.call(document.querySelectorAll("main h2[id][data-chapitre]"));
    if (chaps.length) {
      h += "<p class='nvk-titre'>Sur cette page</p><ul class='nvk-chap'>";
      chaps.forEach(function (c) {
        h += "<li><a href='#" + c.id + "'>" + c.getAttribute("data-chapitre") + "</a></li>";
      });
      h += "</ul>";
    }
    h += "<p class='nvk-pied'>Une recherche ouverte de Yoan Maisonneuve et Claude. <a href='/'>YM IA Conseil</a></p>";
    tiroir.innerHTML = h;

    document.body.appendChild(voile);
    document.body.appendChild(tiroir);
    document.body.appendChild(bulle);

    function ouvrir() {
      tiroir.classList.add("ouvert");
      voile.classList.add("ouvert");
      tiroir.inert = false;
      tiroir.setAttribute("aria-hidden", "false");
      bulle.setAttribute("aria-expanded", "true");
      var a = tiroir.querySelector("a[aria-current]") || tiroir.querySelector("a");
      if (a) a.focus();
    }
    function fermer(rendre) {
      tiroir.classList.remove("ouvert");
      voile.classList.remove("ouvert");
      tiroir.inert = true;
      tiroir.setAttribute("aria-hidden", "true");
      bulle.setAttribute("aria-expanded", "false");
      if (rendre) bulle.focus();
    }
    bulle.addEventListener("click", function () { tiroir.classList.contains("ouvert") ? fermer(true) : ouvrir(); });
    voile.addEventListener("click", function () { fermer(true); });
    tiroir.querySelector(".nvk-fermer").addEventListener("click", function () { fermer(true); });
    tiroir.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (a && a.getAttribute("href").charAt(0) === "#") fermer(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && tiroir.classList.contains("ouvert")) fermer(true); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", construire);
  else construire();
})();
