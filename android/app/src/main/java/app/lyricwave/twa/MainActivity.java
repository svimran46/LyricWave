package app.lyricwave.twa;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.provider.Settings;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends AppCompatActivity {

    /** WebView getUserMedia (mic) permission flow — see WebChromeClient.onPermissionRequest. */
    private static final int PERMISSION_REQUEST_RECORD_AUDIO = 101;
    /** Native audio-reactive (Visualizer) permission flow, requested via the bridge. */
    private static final int PERMISSION_REQUEST_AUDIO_REACTIVE = 102;
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_START_URL = "https://" + APP_HOST + "/assets/index.html";

    private WebView webView;
    private NowPlayingMonitor nowPlayingMonitor;
    private boolean nowPlayingPushQueued;
    private PermissionRequest pendingAudioPermissionRequest;

    // ---- audio-reactive (beat / vocal sync) — all fields below are touched on the UI thread only,
    // except the volatile flags which the bridge threads may read. ----
    private View contentRoot;
    private AudioReactiveMonitor audioMonitor;
    /** JS called startAudioReactive() and has not stopped it; drives auto-resume in onResume. */
    private volatile boolean audioReactiveWanted;
    private volatile boolean resumed;
    private volatile boolean destroyed;
    /** JS is waiting for window.__lyricwaveAudioPermission(...). */
    private boolean audioPermissionPending;

    /** Downloads signed web bundles so UI changes don't need a new APK (see WebUpdater). */
    private WebUpdater webUpdater;

    /** True only for the bundled app origin served by WebViewAssetLoader. */
    static boolean isAppHost(String host) {
        return APP_HOST.equals(host);
    }

    /** lyricwave://callback?... — the Spotify OAuth redirect coming back from the Custom Tab. */
    static boolean isAuthCallback(Uri uri) {
        return uri != null && "lyricwave".equals(uri.getScheme()) && "callback".equals(uri.getHost());
    }

    /** Only Spotify's real authorize endpoint may be opened by the page bridge. */
    static boolean isSpotifyAuthorizeUrl(Uri uri) {
        return uri != null && "https".equals(uri.getScheme())
                && "accounts.spotify.com".equals(uri.getHost())
                && "/authorize".equals(uri.getPath());
    }

    /** Start URL, carrying the OAuth callback query (code/state/error) when present. */
    static String startUrlFor(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (isAuthCallback(data) && data.getEncodedQuery() != null) {
            return APP_START_URL + "?" + data.getEncodedQuery();
        }
        return APP_START_URL;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // NOTE: the screen is NOT kept on unconditionally. The web app asks for it
        // only while lyrics are playing via the LyricWaveNative bridge below.

        // targetSdk 35+ always draws edge-to-edge (status/nav bar colors are ignored), so
        // opt in explicitly with light-on-dark bar icons and pad the content by the insets.
        EdgeToEdge.enable(this,
                SystemBarStyle.dark(Color.TRANSPARENT),
                SystemBarStyle.dark(Color.TRANSPARENT));

        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);

        // Keep the web content clear of the status bar, navigation bar, display cutouts and
        // the on-screen keyboard. The root's dark background shows behind the bars.
        View root = (View) webView.getParent();
        contentRoot = root;
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        // Serve the app from the newest verified web update, falling back to the APK's assets.
        // Same origin either way, so localStorage and the native bridge checks are unchanged.
        webUpdater = new WebUpdater(this);
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", webUpdater.pathHandler())
                .build();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " LyricWaveNativeApp/1.0");

        // Enable hardware accelerated rendering
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Minimal native bridge: the only capability exposed is toggling keep-screen-on,
        // because the Screen Wake Lock API is not available inside Android WebView.
        webView.addJavascriptInterface(new NativeBridge(), "LyricWaveNative");

        // Follows the phone's music apps via media sessions (needs notification access).
        nowPlayingMonitor = new NowPlayingMonitor(this, this::queueNowPlayingPush);

        // Beat / vocal analysis of the phone's audio output. Idle (no Visualizer) until JS starts it.
        audioMonitor = new AudioReactiveMonitor(this::pushAudioFrame);

        // Configure WebViewClient for local asset interception and external URL routing
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();

                // Only the bundled app runs inside the WebView. Spotify login uses a Custom Tab.
                if (isAppHost(host)) {
                    return false;
                }

                // Only hand ordinary web/mail links to other apps; swallow anything else
                // (intent:, javascript:, file:, custom schemes) so pages can't launch arbitrary components.
                String scheme = uri.getScheme();
                if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)
                        && !"mailto".equalsIgnoreCase(scheme)) {
                    return true;
                }

                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    startActivity(intent);
                } catch (ActivityNotFoundException ignored) {
                    // No app can handle it; stay put rather than loading a foreign page in-app.
                }
                return true;
            }

            @RequiresApi(api = Build.VERSION_CODES.O)
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Without this override a WebView renderer crash kills the whole app.
                if (webView != null) {
                    ViewGroup parent = (ViewGroup) webView.getParent();
                    if (parent != null) parent.removeView(webView);
                    webView.destroy();
                    webView = null;
                }
                recreate();
                return true;
            }
        });

        // Microphone is the only web permission this app needs, and only the bundled
        // app origin may receive it. Everything else is denied.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                Uri origin = request.getOrigin();
                boolean fromApp = origin != null && isAppHost(origin.getHost());
                boolean wantsAudio = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        wantsAudio = true;
                        break;
                    }
                }

                if (!fromApp || !wantsAudio) {
                    request.deny();
                    return;
                }

                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }

                if (pendingAudioPermissionRequest != null) {
                    pendingAudioPermissionRequest.deny();
                }
                pendingAudioPermissionRequest = request;
                ActivityCompat.requestPermissions(MainActivity.this,
                        new String[]{Manifest.permission.RECORD_AUDIO},
                        PERMISSION_REQUEST_RECORD_AUDIO);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingAudioPermissionRequest) {
                    pendingAudioPermissionRequest = null;
                }
            }
        });

        // Register modern OnBackPressedCallback
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        // Load the self-contained local web app bundle (with OAuth params on a cold-start callback)
        webView.loadUrl(startUrlFor(getIntent()));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Returning from the Spotify login tab: hand code/state to the web app's callback handler.
        if (webView != null && isAuthCallback(intent.getData())) {
            webView.loadUrl(startUrlFor(intent));
        }
    }

    /** Exposed to page JS as window.LyricWaveNative. Keep this surface tiny. */
    /** Push the current track to the page (coalesced to at most one pending push). */
    private void queueNowPlayingPush() {
        if (nowPlayingPushQueued || webView == null) return;
        nowPlayingPushQueued = true;
        webView.postDelayed(() -> {
            nowPlayingPushQueued = false;
            if (webView == null || nowPlayingMonitor == null) return;
            String json = nowPlayingMonitor.snapshotJson();
            webView.evaluateJavascript(
                    "window.__lyricwaveNowPlaying && window.__lyricwaveNowPlaying(" + json + ")", null);
        }, 150);
    }

    // ---------------------------------------------------------------------------------------
    // Audio-reactive support (contract C1)
    // ---------------------------------------------------------------------------------------

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Main thread. Delivers one analysed frame to the page; coalescing/throttling is done upstream. */
    private void pushAudioFrame(@NonNull AudioReactiveMonitor.Frame frame) {
        if (!resumed || destroyed || webView == null) return;
        webView.evaluateJavascript(
                "window.__lyricwaveAudioFrame && window.__lyricwaveAudioFrame(" + frame.toJson() + ")", null);
    }

    /** Main thread. Starts the Visualizer now if resumed, otherwise defers to onResume. */
    private boolean startAudioReactiveOnUi() {
        if (destroyed || audioMonitor == null) return false;
        if (!AudioReactiveMonitor.isSupported() || !hasRecordAudioPermission()) return false;
        audioReactiveWanted = true;
        if (!resumed) return true; // onResume starts it
        if (audioMonitor.start()) return true;
        audioReactiveWanted = false; // device refused; don't retry on every resume
        return false;
    }

    /** Runs {@link #startAudioReactiveOnUi()} on the UI thread and waits briefly for the answer. */
    private boolean startAudioReactiveBlocking() {
        if (Looper.myLooper() == Looper.getMainLooper()) return startAudioReactiveOnUi();
        final boolean[] result = new boolean[1];
        final CountDownLatch done = new CountDownLatch(1);
        final AtomicBoolean abandoned = new AtomicBoolean(false);
        runOnUiThread(() -> {
            try {
                // The caller gave up waiting: don't start a Visualizer nobody is listening to.
                if (abandoned.get()) return;
                result[0] = startAudioReactiveOnUi();
            } catch (RuntimeException e) {
                result[0] = false;
            } finally {
                done.countDown();
            }
        });
        boolean finished;
        try {
            finished = done.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            finished = false;
        }
        if (!finished) {
            abandoned.set(true);
            return false;
        }
        return result[0];
    }

    /** Main thread. Tells the page whether RECORD_AUDIO is now granted. */
    private void deliverAudioPermissionResult() {
        audioPermissionPending = false;
        if (destroyed || webView == null) return;
        webView.evaluateJavascript("window.__lyricwaveAudioPermission && window.__lyricwaveAudioPermission("
                + hasRecordAudioPermission() + ")", null);
    }

    /**
     * Accepts "#RGB", "#RRGGBB" (leading '#' optional). Returns an opaque ARGB int, or null when the
     * input is not a valid colour. Pure Java so it can be unit-tested without Android.
     */
    static Integer parseChromeColor(String hex) {
        if (hex == null) return null;
        String h = hex.trim();
        if (h.startsWith("#")) h = h.substring(1);
        if (h.length() == 3) {
            h = "" + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        }
        if (h.length() != 6) return null;
        for (int i = 0; i < 6; i++) {
            if (Character.digit(h.charAt(i), 16) < 0) return null;
        }
        try {
            return 0xFF000000 | Integer.parseInt(h, 16);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Maps the bridge's haptic kind to a HapticFeedbackConstants value for the given API level, or -1. */
    @SuppressLint("InlinedApi")
    static int hapticConstantFor(String kind, int sdkInt) {
        if (kind == null) return -1;
        boolean r = sdkInt >= Build.VERSION_CODES.R;
        switch (kind) {
            case "light":
                return HapticFeedbackConstants.CLOCK_TICK;
            case "confirm":
                return r ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
            case "success":
                return r ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.KEYBOARD_TAP;
            case "reject":
                return r ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
            default:
                return -1;
        }
    }

    /** Main thread. Paints the area behind the transparent system bars and sets the bar icon tint. */
    private void applyChromeColor(int color, boolean lightBackground) {
        if (destroyed) return;
        if (contentRoot != null) contentRoot.setBackgroundColor(color);
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(lightBackground);
        controller.setAppearanceLightNavigationBars(lightBackground);
    }

    /** Tells the page about an update check; status is one of the WebUpdater.STATUS_* values. */
    private void pushWebUpdateStatus(String status, boolean manual) {
        runOnUiThread(() -> {
            if (destroyed || webView == null) return;
            webView.evaluateJavascript("window.__lyricwaveWebUpdate && window.__lyricwaveWebUpdate({status:'"
                    + status + "',manual:" + manual + "})", null);
        });
    }

    private class NativeBridge {
        /** True once "Notification access" is enabled for LyricWave. */
        @JavascriptInterface
        public boolean hasMediaAccess() {
            return nowPlayingMonitor != null && nowPlayingMonitor.hasAccess();
        }

        /** Opens the system screen where the user can grant notification access. */
        @JavascriptInterface
        public void openMediaAccessSettings() {
            runOnUiThread(() -> {
                ComponentName cn = nowPlayingMonitor.getListenerComponent();
                Intent intent;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, cn.flattenToString());
                } else {
                    intent = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
                }
                try {
                    startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));
                    } catch (ActivityNotFoundException ignored) {
                        // Very old / unusual ROM without the settings screen.
                    }
                }
            });
        }

        /** Play / pause / seek the followed music app (only "play", "pause", "seek" are accepted). */
        @JavascriptInterface
        public void mediaControl(final String action, final double positionMs) {
            if (nowPlayingMonitor == null || action == null) return;
            runOnUiThread(() -> nowPlayingMonitor.control(action, (long) positionMs));
        }

        /** JSON snapshot: {access, active, package, title, artist, album, artUri, durationMs, positionMs, isPlaying}. */
        @JavascriptInterface
        public String getNowPlaying() {
            if (nowPlayingMonitor == null) return "{\"access\":false,\"active\":false}";
            return nowPlayingMonitor.snapshotJson();
        }

        /** Opens Spotify's authorize page in a Chrome Custom Tab (never inside the WebView). */
        @JavascriptInterface
        public void openSpotifyLogin(final String url) {
            final Uri uri = Uri.parse(url);
            if (!isSpotifyAuthorizeUrl(uri)) return;
            runOnUiThread(() -> {
                try {
                    new CustomTabsIntent.Builder().build().launchUrl(MainActivity.this, uri);
                } catch (ActivityNotFoundException e) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException ignored) {
                        // No browser at all; nothing we can do.
                    }
                }
            });
        }

        @JavascriptInterface
        public void setKeepScreenOn(final boolean keepOn) {
            runOnUiThread(() -> {
                if (keepOn) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        /** Hides the status and navigation bars while the reel is fullscreen (swipe shows them briefly). */
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(() -> {
                if (destroyed) return;
                WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                if (on) {
                    controller.setSystemBarsBehavior(
                            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    controller.hide(WindowInsetsCompat.Type.systemBars());
                } else {
                    controller.show(WindowInsetsCompat.Type.systemBars());
                }
            });
        }

        // ---- Sprint 2 (contract C1): audio-reactive beat/vocal sync, haptics, system-bar colour ----

        /** True if this device can run the Visualizer (class present, not repeatedly failing). */
        @JavascriptInterface
        public boolean audioReactiveSupported() {
            try {
                return AudioReactiveMonitor.isSupported();
            } catch (RuntimeException e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean hasAudioPermission() {
            try {
                return hasRecordAudioPermission();
            } catch (RuntimeException e) {
                return false;
            }
        }

        /**
         * Asks for RECORD_AUDIO. The answer arrives later as window.__lyricwaveAudioPermission(bool).
         * Uses its own request code so it cannot be confused with the WebView getUserMedia flow.
         */
        @JavascriptInterface
        public void requestAudioPermission() {
            runOnUiThread(() -> {
                try {
                    if (destroyed) return;
                    if (hasRecordAudioPermission()) {
                        deliverAudioPermissionResult();
                        return;
                    }
                    audioPermissionPending = true;
                    // If the mic flow already has the dialog up, its result will resolve us too.
                    if (pendingAudioPermissionRequest == null) {
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{Manifest.permission.RECORD_AUDIO},
                                PERMISSION_REQUEST_AUDIO_REACTIVE);
                    }
                } catch (RuntimeException e) {
                    deliverAudioPermissionResult();
                }
            });
        }

        /**
         * Starts the Visualizer (if permitted and the device allows it). Returns false otherwise.
         * Frames then arrive via window.__lyricwaveAudioFrame while the activity is resumed.
         */
        @JavascriptInterface
        public boolean startAudioReactive() {
            try {
                return startAudioReactiveBlocking();
            } catch (RuntimeException e) {
                return false;
            }
        }

        @JavascriptInterface
        public void stopAudioReactive() {
            runOnUiThread(() -> {
                audioReactiveWanted = false;
                if (audioMonitor != null) audioMonitor.stop();
            });
        }

        /** kind: 'light' | 'confirm' | 'success' | 'reject'. Unknown kinds are ignored. */
        @JavascriptInterface
        public void haptic(final String kind) {
            final int type = hapticConstantFor(kind, Build.VERSION.SDK_INT);
            if (type < 0) return;
            runOnUiThread(() -> {
                try {
                    if (!destroyed) getWindow().getDecorView().performHapticFeedback(type);
                } catch (RuntimeException ignored) {
                    // Haptics are best-effort.
                }
            });
        }

        /** JSON: {versionName, versionCode, webVersion, builtInWebVersion, updatesEnabled, updateReady}. */
        @JavascriptInterface
        public String getAppVersionInfo() {
            WebUpdater u = webUpdater;
            if (u == null) return "{}";
            return "{\"versionName\":\"" + BuildConfig.VERSION_NAME.replaceAll("[^0-9A-Za-z._-]", "")
                    + "\",\"versionCode\":" + BuildConfig.VERSION_CODE
                    + ",\"webVersion\":" + u.servingVersion()
                    + ",\"builtInWebVersion\":" + u.builtInVersion()
                    + ",\"updatesEnabled\":" + u.isEnabled()
                    + ",\"updateReady\":" + u.isUpdateReady() + "}";
        }

        /** Checks for a web update now; the result arrives via window.__lyricwaveWebUpdate. */
        @JavascriptInterface
        public void checkForWebUpdate() {
            WebUpdater u = webUpdater;
            if (u != null) u.check(true, MainActivity.this::pushWebUpdateStatus);
        }

        /** Switches to the downloaded update and reloads the app. */
        @JavascriptInterface
        public void applyWebUpdate() {
            runOnUiThread(() -> {
                if (destroyed || webView == null || webUpdater == null) return;
                if (!webUpdater.applyReadyUpdate()) return;
                webView.clearCache(false);
                webView.loadUrl(APP_START_URL);
            });
        }

        /** hex: "#RGB" or "#RRGGBB". Ignored if malformed. */
        @JavascriptInterface
        public void setChromeColor(final String hex, final boolean lightBackground) {
            final Integer color = parseChromeColor(hex);
            if (color == null) return;
            final int argb = color;
            runOnUiThread(() -> {
                try {
                    applyChromeColor(argb, lightBackground);
                } catch (RuntimeException ignored) {
                    // Cosmetic only.
                }
            });
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_RECORD_AUDIO) {
            if (pendingAudioPermissionRequest != null) {
                if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    pendingAudioPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    pendingAudioPermissionRequest.deny();
                }
            }
            pendingAudioPermissionRequest = null;
            // The bridge's audio-reactive request may have piggy-backed on this dialog.
            if (audioPermissionPending) deliverAudioPermissionResult();
        } else if (requestCode == PERMISSION_REQUEST_AUDIO_REACTIVE) {
            // An empty result means the request was interrupted. If the WebView mic dialog is the
            // one in flight, its own result will resolve us; otherwise report what we have now.
            boolean interrupted = grantResults.length == 0;
            if (!(interrupted && pendingAudioPermissionRequest != null)) {
                deliverAudioPermissionResult();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (nowPlayingMonitor != null) nowPlayingMonitor.start();
        if (audioReactiveWanted && audioMonitor != null) {
            if (!hasRecordAudioPermission() || !audioMonitor.start()) {
                audioReactiveWanted = false; // revoked or refused; JS falls back to lyric rhythm
            }
        }
        if (webView != null) {
            webView.onResume();
        }
        // Background check for a newer web bundle (throttled inside WebUpdater).
        if (webUpdater != null) webUpdater.check(false, this::pushWebUpdateStatus);
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
        // Release the Visualizer while hidden (battery); onResume restarts it if JS still wants it.
        if (audioMonitor != null) audioMonitor.stop();
        if (nowPlayingMonitor != null) nowPlayingMonitor.stop();
        // Never hold the screen on while the app is not visible.
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        audioReactiveWanted = false;
        if (audioMonitor != null) audioMonitor.stop();
        if (webUpdater != null) webUpdater.shutdown();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
