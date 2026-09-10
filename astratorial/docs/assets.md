# Visual assets

The three landing-page photographs were generated for this project with the Codex ImageGen tool. They are illustrative examples, not evidence of a reconstructed user workspace.

| Asset | Prompt direction |
| --- | --- |
| `public/images/hero.png`, `espresso.png` | Warm editorial photograph of a pod espresso machine, ceramic cup, pods, glass creamer and plant on a cream kitchen counter; sunlit neutral palette, no text. |
| `public/images/cooking.png` | Warm editorial photograph of a bowl of tomato and basil pasta in a cream home kitchen, fresh ingredients nearby, no text. |
| `public/images/assembly.png` | Warm editorial photograph of a pale oak side table being assembled upside down, hardware and illustrated instructions nearby, no people or text overlay. |

The browser’s example 3D scenes are original procedural Three.js geometry. They are deliberately labeled illustrative examples. Generated tutorials instead load a GLB produced from the captured workspace and reviewed plan.

`public/basis/basis_transcoder.js` and `.wasm` are copied from the installed Three.js Basis Universal support files for local KTX2 decoding. Preserve the included third-party license notice. Three.js is MIT licensed; Basis Universal is Apache 2.0 licensed.

The cloud worker builds its generic human from the pinned MakeHuman core assets listed by `worker/assets/fetch_tutor.py`. Its asset manifest and license must be retained with worker builds and distributed GLBs. No paid asset purchase or personalized likeness is used.
