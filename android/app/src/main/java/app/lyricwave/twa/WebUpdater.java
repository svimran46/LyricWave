package app.lyricwave.twa;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * In-app updates for the web part of the app (HTML / JS / CSS), so a UI change does not need
 * a new APK. Signed bundles are published by .github/workflows/web-update.yml; this class
 * downloads, verifies and unpacks them into filesDir/web-updates/&lt;version&gt;/.
 *
 * A downloaded bundle is served (through {@link ServingPathHandler}) from the next cold start,
 * or immediately when the page calls LyricWaveNative.applyWebUpdate(). Files missing from the
 * bundle fall back to the APK's assets. Installing a new APK discards all downloaded bundles,
 * so the APK's own files always win right after an APK update.
 */
final class WebUpdater {

    /** Release assets of the public repo; see .github/workflows/web-update.yml. */
    static final String BASE_URL = "https://github.com/svimran46/LyricWave/releases/download/web-latest/";

    static final String STATUS_CHECKING = "checking";
    static final String STATUS_UP_TO_DATE = "up-to-date";
    static final String STATUS_READY = "ready";
    static final String STATUS_NEEDS_APP_UPDATE = "needs-app-update";
    static final String STATUS_ERROR = "error";
    static final String STATUS_DISABLED = "disabled";

    interface Listener {
        /** Called on a background thread. */
        void onStatus(String status, boolean manual);
    }

    private static final String PREFS = "web_update";
    private static final String KEY_ACTIVE_VERSION = "active_version";
    private static final String KEY_APK_STAMP = "apk_stamp";
    private static final String KEY_LAST_CHECK = "last_check";
    private static final long AUTO_CHECK_INTERVAL_MS = 30L * 60 * 1000;

    private final File root;
    private final SharedPreferences prefs;
    private final long builtInVersion;
    private final int nativeVersionCode;
    private final String publicKeyHex;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean checking = new AtomicBoolean(false);
    private final ServingPathHandler pathHandler;

    /** Version currently served to the WebView (built-in version when serving APK assets). */
    private volatile long servingVersion;

    WebUpdater(Context context) {
        Context app = context.getApplicationContext();
        root = new File(app.getFilesDir(), "web-updates");
        prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        builtInVersion = BuildConfig.BUILT_IN_WEB_VERSION;
        nativeVersionCode = BuildConfig.VERSION_CODE;
        publicKeyHex = BuildConfig.WEB_UPDATE_PUBLIC_KEY;
        pathHandler = new ServingPathHandler(new WebViewAssetLoader.AssetsPathHandler(app));

        resetIfApkChanged(app);
        long active = prefs.getLong(KEY_ACTIVE_VERSION, 0);
        File dir = bundleDir(active);
        if (isEnabled() && active > builtInVersion && new File(dir, "index.html").isFile()) {
            pathHandler.root = dir;
            servingVersion = active;
        } else {
            servingVersion = builtInVersion;
            active = 0;
        }
        deleteAllBundlesExcept(active, active);
    }

    /** Path handler for "/assets/": the active bundle first, then the APK's assets. */
    WebViewAssetLoader.PathHandler pathHandler() {
        return pathHandler;
    }

    boolean isEnabled() {
        return publicKeyHex != null && !publicKeyHex.isEmpty();
    }

    long servingVersion() {
        return servingVersion;
    }

    long builtInVersion() {
        return builtInVersion;
    }

    /** A verified bundle newer than the one being served is unpacked and waiting. */
    boolean isUpdateReady() {
        long active = prefs.getLong(KEY_ACTIVE_VERSION, 0);
        return active > servingVersion && new File(bundleDir(active), "index.html").isFile();
    }

    /** Switches the WebView's files to the waiting bundle. The caller reloads the page. */
    boolean applyReadyUpdate() {
        if (!isUpdateReady()) return false;
        long active = prefs.getLong(KEY_ACTIVE_VERSION, 0);
        pathHandler.root = bundleDir(active);
        servingVersion = active;
        return true;
    }

    /** Auto checks run at most every 30 minutes; manual checks always run. */
    void check(boolean manual, Listener listener) {
        if (!isEnabled()) {
            if (manual) listener.onStatus(STATUS_DISABLED, true);
            return;
        }
        long now = System.currentTimeMillis();
        if (!manual && now - prefs.getLong(KEY_LAST_CHECK, 0) < AUTO_CHECK_INTERVAL_MS) return;
        if (!checking.compareAndSet(false, true)) {
            if (manual) listener.onStatus(STATUS_CHECKING, true);
            return;
        }
        if (manual) listener.onStatus(STATUS_CHECKING, true);
        executor.execute(() -> {
            String status;
            try {
                status = runCheck();
                prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();
            } catch (Exception e) {
                status = STATUS_ERROR;
            } finally {
                checking.set(false);
            }
            listener.onStatus(status, manual);
        });
    }

    void shutdown() {
        executor.shutdownNow();
    }

    private String runCheck() throws IOException {
        if (isUpdateReady()) return STATUS_READY;

        byte[] manifestBytes;
        byte[] signature;
        try {
            manifestBytes = fetch(BASE_URL + "web-update.properties", WebUpdateCore.MAX_MANIFEST_BYTES);
            signature = fetch(BASE_URL + "web-update.sig", WebUpdateCore.MAX_SIGNATURE_BYTES);
        } catch (FileNotFoundException e) {
            return STATUS_UP_TO_DATE; // nothing published yet
        }
        if (!WebUpdateCore.verifySignature(manifestBytes, signature, publicKeyHex)) {
            throw new IOException("bad signature");
        }
        WebUpdateCore.Manifest m = WebUpdateCore.parseManifest(manifestBytes);

        long current = Math.max(servingVersion, prefs.getLong(KEY_ACTIVE_VERSION, 0));
        switch (WebUpdateCore.decide(m, current, nativeVersionCode)) {
            case UP_TO_DATE:
                return STATUS_UP_TO_DATE;
            case NEEDS_NATIVE_UPDATE:
                return STATUS_NEEDS_APP_UPDATE;
            default:
                break;
        }

        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("cannot create " + root);
        File zip = new File(root, "download.zip");
        File tmp = new File(root, ".tmp-" + m.version);
        try {
            download(BASE_URL + "web-bundle.zip", zip, m.size);
            if (!m.sha256.equals(WebUpdateCore.sha256Hex(zip))) throw new IOException("sha256 mismatch");
            WebUpdateCore.deleteRecursively(tmp);
            WebUpdateCore.extractZip(zip, tmp);
            File dest = bundleDir(m.version);
            WebUpdateCore.deleteRecursively(dest);
            if (!tmp.renameTo(dest)) throw new IOException("rename failed");
            prefs.edit().putLong(KEY_ACTIVE_VERSION, m.version).commit();
        } finally {
            //noinspection ResultOfMethodCallIgnored
            zip.delete();
            WebUpdateCore.deleteRecursively(tmp);
        }
        // Keep the new bundle and the one the WebView may still be reading from.
        deleteAllBundlesExcept(m.version, servingVersion);
        return STATUS_READY;
    }

    private void resetIfApkChanged(Context app) {
        long stamp;
        try {
            stamp = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            stamp = 0;
        }
        if (prefs.getLong(KEY_APK_STAMP, -1) != stamp) {
            WebUpdateCore.deleteRecursively(root);
            prefs.edit().clear().putLong(KEY_APK_STAMP, stamp).commit();
        }
    }

    private File bundleDir(long version) {
        return new File(root, String.valueOf(version));
    }

    private void deleteAllBundlesExcept(long keepA, long keepB) {
        File[] children = root.listFiles();
        if (children == null) return;
        for (File c : children) {
            String name = c.getName();
            if (name.equals(String.valueOf(keepA)) || name.equals(String.valueOf(keepB))) continue;
            WebUpdateCore.deleteRecursively(c);
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        int code = c.getResponseCode();
        if (code == HttpURLConnection.HTTP_NOT_FOUND) {
            c.disconnect();
            throw new FileNotFoundException(url);
        }
        if (code != HttpURLConnection.HTTP_OK) {
            c.disconnect();
            throw new IOException("HTTP " + code + " for " + url);
        }
        return c;
    }

    private static byte[] fetch(String url, int maxBytes) throws IOException {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                if (out.size() + n > maxBytes) throw new IOException("response too large: " + url);
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    private static void download(String url, File dest, long expectedSize) throws IOException {
        HttpURLConnection c = open(url);
        long total = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > expectedSize) throw new IOException("bundle larger than manifest says");
                out.write(buf, 0, n);
            }
        } finally {
            c.disconnect();
        }
        if (total != expectedSize) throw new IOException("bundle size mismatch");
    }

    /** Serves "/assets/&lt;path&gt;" from the active bundle when it has the file, else from the APK. */
    static final class ServingPathHandler implements WebViewAssetLoader.PathHandler {
        private final WebViewAssetLoader.PathHandler fallback;
        volatile File root;

        ServingPathHandler(WebViewAssetLoader.PathHandler fallback) {
            this.fallback = fallback;
        }

        @Nullable
        @Override
        public WebResourceResponse handle(@NonNull String path) {
            File file = WebUpdateCore.resolveInside(root, path);
            if (file != null) {
                try {
                    return new WebResourceResponse(WebUpdateCore.mimeTypeFor(path), null, 200, "OK",
                            Collections.singletonMap("Cache-Control", "no-cache"),
                            new FileInputStream(file));
                } catch (IOException ignored) {
                    // fall through to the APK copy
                }
            }
            return fallback.handle(path);
        }
    }
}
