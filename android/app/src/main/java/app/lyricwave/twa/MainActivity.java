package app.lyricwave.twa;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends AppCompatActivity {

    private static final int PERMISSION_REQUEST_RECORD_AUDIO = 101;
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_START_URL = "https://" + APP_HOST + "/assets/index.html";

    private WebView webView;
    private NowPlayingMonitor nowPlayingMonitor;
    private boolean nowPlayingPushQueued;
    private PermissionRequest pendingAudioPermissionRequest;

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
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        // Configure WebViewAssetLoader for fast, secure local asset serving
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(APP_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
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
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (nowPlayingMonitor != null) nowPlayingMonitor.start();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (nowPlayingMonitor != null) nowPlayingMonitor.stop();
        // Never hold the screen on while the app is not visible.
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (webView != null) {
            webView.onPause();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
