# projectM for LyricWave

- `projectm.js` + `projectm.wasm`: [libprojectM](https://github.com/projectM-visualizer/projectm) 4
  (commit `349b7cc2`), compiled with Emscripten 6.0.12 to WebAssembly + WebGL 2, together with the
  small bridge in `scripts/projectm/lw_projectm.cpp`. Rebuild with `scripts/projectm/build.sh`.
  License: LGPL-2.1 (`LICENSE-projectM.txt`). The library is loaded as a separate, replaceable module.
- `presets.json`: 50 presets from projectM's
  [Cream of the Crop](https://github.com/projectM-visualizer/presets-cream-of-the-crop) pack
  (commit `0180df21`), five per category. Each was rendered headlessly through this exact WASM build
  and kept only if it compiled, rendered in budget, and was neither black, washed out nor static.
  License notes: `LICENSE-presets.md`.
