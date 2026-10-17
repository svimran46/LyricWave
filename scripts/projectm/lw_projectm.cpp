// LyricWave <-> libprojectM bridge for the browser (WebGL 2 via Emscripten).
// Exposes a tiny C API to JavaScript: init on a canvas, feed PCM, render, load presets.
#include <emscripten.h>
#include <emscripten/html5.h>
#include <projectM-4/projectM.h>

static projectm_handle g_pm = nullptr;
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_ctx = 0;

EM_JS(void, lw_js_switch_requested, (int hard_cut), {
  if (Module.onPresetSwitchRequested) Module.onPresetSwitchRequested(!!hard_cut);
});

EM_JS(void, lw_js_switch_failed, (const char* message), {
  if (Module.onPresetSwitchFailed) Module.onPresetSwitchFailed(UTF8ToString(message));
});

static void on_switch_requested(bool is_hard_cut, void*) { lw_js_switch_requested(is_hard_cut ? 1 : 0); }
static void on_switch_failed(const char*, const char* message, void*) { lw_js_switch_failed(message ? message : ""); }

extern "C" {

EMSCRIPTEN_KEEPALIVE int lw_pm_init(const char* canvas_selector, int width, int height, int mesh_x, int mesh_y) {
  if (g_pm) return 0;
  EmscriptenWebGLContextAttributes attrs;
  emscripten_webgl_init_context_attributes(&attrs);
  attrs.majorVersion = 2;
  attrs.minorVersion = 0;
  attrs.alpha = 0;
  attrs.depth = 0;
  attrs.stencil = 0;
  attrs.antialias = 0;
  attrs.premultipliedAlpha = 0;
  attrs.preserveDrawingBuffer = 0;
  attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
  g_ctx = emscripten_webgl_create_context(canvas_selector, &attrs);
  if (g_ctx <= 0) return -1;
  emscripten_webgl_make_context_current(g_ctx);
  // Float textures for the motion-vector grid (see projectM docs/emscripten.rst).
  emscripten_webgl_enable_extension(g_ctx, "OES_texture_float");
  emscripten_webgl_enable_extension(g_ctx, "OES_texture_float_linear");
  emscripten_webgl_enable_extension(g_ctx, "EXT_color_buffer_float");

  g_pm = projectm_create();
  if (!g_pm) return -2;
  projectm_set_window_size(g_pm, width, height);
  projectm_set_mesh_size(g_pm, mesh_x > 0 ? mesh_x : 48, mesh_y > 0 ? mesh_y : 32);
  projectm_set_fps(g_pm, 60);
  projectm_set_aspect_correction(g_pm, true);
  projectm_set_preset_duration(g_pm, 30.0);
  projectm_set_soft_cut_duration(g_pm, 3.0);
  projectm_set_hard_cut_enabled(g_pm, false);
  projectm_set_beat_sensitivity(g_pm, 1.0f);
  projectm_set_preset_switch_requested_event_callback(g_pm, on_switch_requested, nullptr);
  projectm_set_preset_switch_failed_event_callback(g_pm, on_switch_failed, nullptr);
  return 0;
}

EMSCRIPTEN_KEEPALIVE void lw_pm_resize(int width, int height) {
  if (g_pm) projectm_set_window_size(g_pm, width, height);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_add_pcm(const float* samples, unsigned int count_per_channel, int channels) {
  if (g_pm) projectm_pcm_add_float(g_pm, samples, count_per_channel, channels == 2 ? PROJECTM_STEREO : PROJECTM_MONO);
}

EMSCRIPTEN_KEEPALIVE unsigned int lw_pm_max_samples() {
  return projectm_pcm_get_max_samples();
}

EMSCRIPTEN_KEEPALIVE void lw_pm_render() {
  if (!g_pm) return;
  emscripten_webgl_make_context_current(g_ctx);
  projectm_opengl_render_frame(g_pm);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_load_preset(const char* data, int smooth) {
  if (g_pm) projectm_load_preset_data(g_pm, data, smooth != 0);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_set_preset_duration(double seconds) {
  if (g_pm) projectm_set_preset_duration(g_pm, seconds);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_set_beat_sensitivity(float s) {
  if (g_pm) projectm_set_beat_sensitivity(g_pm, s);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_set_locked(int locked) {
  if (g_pm) projectm_set_preset_locked(g_pm, locked != 0);
}

EMSCRIPTEN_KEEPALIVE void lw_pm_destroy() {
  if (g_pm) {
    projectm_destroy(g_pm);
    g_pm = nullptr;
  }
  if (g_ctx > 0) {
    emscripten_webgl_destroy_context(g_ctx);
    g_ctx = 0;
  }
}

}  // extern "C"
