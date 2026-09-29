# OCR des plans — composants tiers et licences

Ce dossier fait tourner un OCR entièrement dans le navigateur : le plan ne quitte jamais l'ordinateur.
Il réunit quatre composants tiers, copiés tels quels (aucun CDN au moment de l'exécution).

| Fichier | Origine | Licence |
|---|---|---|
| `models/ch_PP-OCRv4_det_infer.onnx` | PaddleOCR (PP-OCRv4, détection DB), conversion ONNX livrée avec `rapidocr_onnxruntime` 1.4.4 | Apache-2.0 |
| `models/ch_PP-OCRv4_rec_infer.onnx` | PaddleOCR (PP-OCRv4, reconnaissance SVTR-LCNet + CTC), idem | Apache-2.0 |
| `models/ch_ppocr_mobile_v2.0_cls_infer.onnx` | PaddleOCR (classifieur d'orientation 0°/180°), idem | Apache-2.0 |
| `models/ppocr_keys.txt` | Dictionnaire de caractères extrait des métadonnées ONNX (`character`) du modèle de reconnaissance | Apache-2.0 |
| `vendor/ort/ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | onnxruntime-web 1.30.0 (npm), build « wasm » seul | MIT |
| `vendor/pdf-lib/pdf-lib.esm.min.js` | pdf-lib 1.17.1 (npm), build ESM minifié `dist/`, qui embarque pako, @pdf-lib/standard-fonts, @pdf-lib/upng, base64-arraybuffer, tslib et des classes de flux portées de pdf.js | MIT (mentions des composants inclus dans `vendor/pdf-lib/LICENSE`) |
| `engine.js` | Portage JavaScript du pipeline de RapidOCR (`rapidocr_onnxruntime` 1.4.4 : `ch_ppocr_det`, `ch_ppocr_rec`, `ch_ppocr_cls`, `main.py`), modifié — les écarts sont listés en tête du fichier | Apache-2.0 (œuvre dérivée) |

## Mentions

- **PaddleOCR** — Copyright (c) 2020 PaddlePaddle Authors. Licence Apache 2.0.
  <https://github.com/PaddlePaddle/PaddleOCR>
- **RapidOCR** — Copyright (c) 2021 RapidAI (SWHL). Licence Apache 2.0.
  <https://github.com/RapidAI/RapidOCR>
- **ONNX Runtime** — Copyright (c) Microsoft Corporation. Licence MIT, texte dans `vendor/ort/LICENSE`.
  <https://github.com/microsoft/onnxruntime>
- **pdf-lib** — Copyright (c) 2019 Andrew Dillon. Licence MIT, texte et composants inclus dans `vendor/pdf-lib/LICENSE`.
  <https://github.com/Hopding/pdf-lib>

Les autres fichiers du dossier (`pool.js`, `worker.js`, `raster.js`, `pdftext.js`, `sheetfix.js`) sont
propres au site. `pdftext.js` écrit la couche de texte invisible selon le principe d'OCRmyPDF (mode de
rendu 3), sans en reprendre de code.

Texte complet de la licence Apache 2.0 : `models/LICENSE`.

## Convention du dictionnaire

`ppocr_keys.txt` contient les 6623 caractères du modèle, un par ligne, dans l'ordre des métadonnées.
Comme dans `CTCLabelDecode` de RapidOCR, le code y ajoute l'indice 0 = « blank » CTC en tête et une
espace en fin : 1 + 6623 + 1 = 6625, la dimension de sortie du modèle de reconnaissance.

## Empreintes (SHA-256)

```
d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9  models/ch_PP-OCRv4_det_infer.onnx
48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b  models/ch_PP-OCRv4_rec_infer.onnx
e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c  models/ch_ppocr_mobile_v2.0_cls_infer.onnx
e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b  vendor/ort/ort-wasm-simd-threaded.mjs
3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2  vendor/ort/ort-wasm-simd-threaded.wasm
219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b  vendor/ort/ort.wasm.min.mjs
72c052d97b4d5d9fa6cdbdcb7ad709f03d4ddb1122390cb3afeba4d88651d969  vendor/pdf-lib/pdf-lib.esm.min.js
```
