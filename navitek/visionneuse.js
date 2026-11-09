// La visionneuse de l'assemblage du Navitek N0. Chaque pièce (pieces/<pièce>.stl, dans le repère de l'assemblage) est posée
// par sa matrice (assemblage.json, écrite par cao/n0.py) ; vue éclatée, pièces cliquables, couleurs des deux bobines.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

export async function visionneuse(conteneur, base, options = {}) {
  const scene = new THREE.Scene();
  const rendu = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  rendu.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  conteneur.appendChild(rendu.domElement);
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  const controles = new OrbitControls(camera, rendu.domElement);
  controles.enableDamping = true;
  controles.minDistance = 120;
  controles.maxDistance = 2400;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const soleil = new THREE.DirectionalLight(0xffffff, 1.6);
  soleil.position.set(400, 500, 300);
  scene.add(soleil);
  const contre = new THREE.DirectionalLight(0xffffff, 0.55);
  contre.position.set(-300, 200, -400);
  scene.add(contre);

  const donnees = await (await fetch(base + "assemblage.json")).json();
  const chargeur = new STLLoader();
  const geos = {};
  const pieces = [...new Set(donnees.instances.map(i => i.piece))];
  let charges = 0;
  await Promise.all(pieces.map(async p => {
    const g = await chargeur.loadAsync(base + p + ".stl");
    g.computeVertexNormals();
    geos[p] = g;
    if (options.progres) options.progres(++charges / pieces.length);
  }));
  const robot = new THREE.Group();
  robot.rotation.x = -Math.PI / 2;      // z vers le haut (CAO) -> y vers le haut (three.js)
  scene.add(robot);
  const maillages = [];
  for (const inst of donnees.instances) {
    const achete = !inst.imprimee;
    const mat = new THREE.MeshStandardMaterial({ color: inst.couleur, roughness: achete ? 0.4 : 0.66, metalness: 0.02 });
    const m = new THREE.Mesh(geos[inst.piece], mat);
    m.matrixAutoUpdate = false;
    const M = new THREE.Matrix4().fromArray(inst.matrice).transpose();   // FreeCAD écrit la matrice par lignes
    m.userData = { inst, base: M.clone(), couleur: inst.couleur };
    m.matrix.copy(M);
    robot.add(m);
    maillages.push(m);
  }
  robot.updateMatrixWorld(true);
  const boite = new THREE.Box3().setFromObject(robot);
  const centre = boite.getCenter(new THREE.Vector3());
  const taille = boite.getSize(new THREE.Vector3());
  // l'éclaté : chaque pièce s'écarte du centre de son groupe (jambe, bras, tête, torse) et chaque groupe du centre du robot
  const centreLocal = new THREE.Vector3();
  new THREE.Box3().setFromObject(robot).getCenter(centreLocal);
  robot.worldToLocal(centreLocal);
  const centresGroupes = {};
  for (const m of maillages) {
    const b = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position).applyMatrix4(m.userData.base);
    m.userData.c = b.getCenter(new THREE.Vector3());
    const g = m.userData.inst.groupe;
    (centresGroupes[g] = centresGroupes[g] || []).push(m.userData.c);
  }
  for (const g in centresGroupes) {
    const s = new THREE.Vector3();
    centresGroupes[g].forEach(c => s.add(c));
    centresGroupes[g] = s.divideScalar(centresGroupes[g].length);
  }
  for (const m of maillages) {
    const cg = centresGroupes[m.userData.inst.groupe];
    const dirGroupe = cg.clone().sub(centreLocal).multiply(new THREE.Vector3(0.9, 1.25, 0.35));
    const dirPiece = m.userData.c.clone().sub(cg).multiply(new THREE.Vector3(1.6, 1.6, 0.9));
    m.userData.dir = dirGroupe.add(dirPiece);
  }
  const sol = new THREE.Mesh(new THREE.CircleGeometry(taille.x * 1.1, 72), new THREE.MeshStandardMaterial({ color: options.sol || 0xe7e3dc, roughness: 1 }));
  sol.rotation.x = -Math.PI / 2;
  sol.position.y = boite.min.y - 0.5;
  if (options.sansSol) sol.visible = false;
  scene.add(sol);

  let eclat = 0;
  let vueCourante = options.vue || "face";
  // Le devant du robot regarde +x dans la CAO (donc +x ici) ; la caméra recule assez pour voir tout le robot, éclaté compris.
  function cadrer(vue = vueCourante) {
    vueCourante = vue;
    const v = new THREE.Vector3(...({ face: [1, 0.22, 0.42], dos: [-1, 0.25, -0.4], cote: [0.08, 0.15, 1], dessus: [0.55, 1.5, 0.45] }[vue] || [1, 0.22, 0.42])).normalize();
    const h = Math.max(taille.y, taille.z) * (1 + eclat * 0.9);
    const d = (h * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect * 1.6);
    camera.position.copy(centre).addScaledVector(v, d);
    controles.target.copy(centre);
    controles.update();
  }
  function eclater(f) {
    eclat = f;
    for (const m of maillages) {
      const t = new THREE.Matrix4().makeTranslation(m.userData.dir.x * f, m.userData.dir.y * f, m.userData.dir.z * f);
      m.matrix.multiplyMatrices(t, m.userData.base);
    }
    sol.visible = f < 0.05 && !options.sansSol;
  }
  function surligner(piece) {
    for (const m of maillages) {
      const actif = !piece || m.userData.inst.piece === piece;
      m.material.color.set(actif ? m.userData.couleur : "#cfd3d9");
      m.material.transparent = !actif;
      m.material.opacity = actif ? 1 : 0.22;
      m.material.depthWrite = actif;
    }
  }
  const rayon = new THREE.Raycaster();
  const souris = new THREE.Vector2();
  let appui = null;
  rendu.domElement.addEventListener("pointerdown", e => { appui = [e.clientX, e.clientY]; });
  rendu.domElement.addEventListener("pointerup", e => {
    if (!appui || Math.hypot(e.clientX - appui[0], e.clientY - appui[1]) > 6) return;   // un glisser n'est pas un clic
    const r = rendu.domElement.getBoundingClientRect();
    souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    rayon.setFromCamera(souris, camera);
    const t = rayon.intersectObjects(maillages.filter(m => !m.material.transparent || !options.filtrer))[0];
    if (options.choisir) options.choisir(t ? t.object.userData.inst : null);
  });
  function taillage() {
    const w = conteneur.clientWidth, h = conteneur.clientHeight;
    rendu.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(() => { taillage(); }).observe(conteneur);
  taillage();
  cadrer(vueCourante);
  (function boucle() { controles.update(); rendu.render(scene, camera); requestAnimationFrame(boucle); })();
  return { eclater, surligner, cadrer, donnees, getEclat: () => eclat };
}
