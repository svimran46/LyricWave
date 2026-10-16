#!/usr/bin/env bash
# Rebuild vendor/projectm/projectm.{mjs,wasm}: libprojectM 4 compiled to WebAssembly + WebGL 2,
# plus the tiny C bridge in lw_projectm.cpp.
#
#   scripts/projectm/build.sh [workdir]
#
# Needs git, cmake and network access (emsdk + projectM sources). Pinned versions below.
set -euo pipefail

EMSDK_VERSION=6.0.12
PROJECTM_COMMIT=349b7cc2db312d47cef6be24c6856ced6643a385

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/lyricwave-projectm}"
OUT="$ROOT/vendor/projectm"
mkdir -p "$WORK" "$OUT"
cd "$WORK"

if [ ! -d emsdk ]; then git clone --depth 1 https://github.com/emscripten-core/emsdk.git; fi
./emsdk/emsdk install "$EMSDK_VERSION"
./emsdk/emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source ./emsdk/emsdk_env.sh

if [ ! -d projectm ]; then
  git clone https://github.com/projectM-visualizer/projectm.git
fi
git -C projectm fetch --depth 1 origin "$PROJECTM_COMMIT"
git -C projectm checkout -q "$PROJECTM_COMMIT"
git -C projectm submodule update --init --recursive --depth 1
# The library itself never touches SDL; drop the SDL2 port (only projectM's own demo UI uses it).
sed -i.bak 's/            "SHELL:-s USE_SDL=2"//' projectm/CMakeLists.txt

emcmake cmake -S projectm -B projectm/build-wasm -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_SYSTEM_PROJECTM_EVAL=OFF -DENABLE_SYSTEM_GLM=OFF -DENABLE_PLAYLIST=OFF \
  -DENABLE_SDL_UI=OFF -DBUILD_TESTING=OFF -DENABLE_INSTALL=ON -DCMAKE_INSTALL_PREFIX="$WORK/pm-install"
cmake --build projectm/build-wasm -j"$(nproc 2>/dev/null || echo 4)"
cmake --install projectm/build-wasm

em++ -O3 -std=c++17 -I"$WORK/pm-install/include" "$ROOT/scripts/projectm/lw_projectm.cpp" \
  "$WORK/pm-install/lib/libprojectM-4.a" \
  projectm/build-wasm/vendor/glad/libglad.a \
  projectm/build-wasm/vendor/projectm-eval/projectm-eval/libprojectM_eval.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createProjectM -sENVIRONMENT=web \
  -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES2=1 -sFULL_ES3=1 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sNO_DISABLE_EXCEPTION_CATCHING \
  -sFILESYSTEM=0 -sASSERTIONS=0 \
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_lw_pm_init','_lw_pm_resize','_lw_pm_add_pcm','_lw_pm_max_samples','_lw_pm_render','_lw_pm_load_preset','_lw_pm_set_preset_duration','_lw_pm_set_beat_sensitivity','_lw_pm_set_locked','_lw_pm_destroy']" \
  "-sEXPORTED_RUNTIME_METHODS=['ccall','stringToNewUTF8','HEAPF32']" \
  -o "$OUT/projectm.js"

echo "Built $OUT/projectm.js + projectm.wasm"
