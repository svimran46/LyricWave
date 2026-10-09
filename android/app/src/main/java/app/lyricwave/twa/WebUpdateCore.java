package app.lyricwave.twa;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Locale;
import java.util.Properties;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Pure-Java half of the in-app web updater: manifest parsing, signature and hash checks,
 * safe unzip and the install decision. No Android APIs, so it runs on a plain JVM in tests.
 *
 * An update is three files published by .github/workflows/web-update.yml:
 *   web-update.properties  version / minNativeVersion / sha256 / size of the bundle
 *   web-update.sig         ECDSA P-256 (SHA256withECDSA, DER) signature of the properties file
 *   web-bundle.zip         the web files (index.html, app.js, styles.css, ...)
 */
final class WebUpdateCore {

    static final int MAX_MANIFEST_BYTES = 16 * 1024;
    static final int MAX_SIGNATURE_BYTES = 1024;
    static final long MAX_BUNDLE_BYTES = 25L * 1024 * 1024;
    static final long MAX_EXTRACTED_BYTES = 60L * 1024 * 1024;
    static final int MAX_ENTRIES = 1000;

    enum Decision { INSTALL, UP_TO_DATE, NEEDS_NATIVE_UPDATE }

    static final class Manifest {
        final long version;
        final int minNativeVersion;
        final String sha256;
        final long size;

        Manifest(long version, int minNativeVersion, String sha256, long size) {
            this.version = version;
            this.minNativeVersion = minNativeVersion;
            this.sha256 = sha256;
            this.size = size;
        }
    }

    private WebUpdateCore() {}

    static Manifest parseManifest(byte[] bytes) throws IOException {
        Properties p = new Properties();
        p.load(new InputStreamReader(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8));
        try {
            long version = Long.parseLong(required(p, "version"));
            int minNative = Integer.parseInt(required(p, "minNativeVersion"));
            String sha = required(p, "sha256").toLowerCase(Locale.ROOT);
            long size = Long.parseLong(required(p, "size"));
            if (version <= 0) throw new IOException("bad version");
            if (!sha.matches("[0-9a-f]{64}")) throw new IOException("bad sha256");
            if (size <= 0 || size > MAX_BUNDLE_BYTES) throw new IOException("bad size");
            return new Manifest(version, minNative, sha, size);
        } catch (NumberFormatException e) {
            throw new IOException("bad number in manifest", e);
        }
    }

    private static String required(Properties p, String key) throws IOException {
        String v = p.getProperty(key);
        if (v == null || v.trim().isEmpty()) throw new IOException("manifest missing " + key);
        return v.trim();
    }

    /** True only if {@code signature} is a valid SHA256withECDSA signature of {@code data}. */
    static boolean verifySignature(byte[] data, byte[] signature, String publicKeyHex) {
        if (publicKeyHex == null || publicKeyHex.isEmpty()) return false;
        try {
            PublicKey key = KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(hexToBytes(publicKeyHex)));
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(data);
            return verifier.verify(signature);
        } catch (Exception e) {
            return false;
        }
    }

    static Decision decide(Manifest m, long currentVersion, int nativeVersionCode) {
        if (m.version <= currentVersion) return Decision.UP_TO_DATE;
        if (m.minNativeVersion > nativeVersionCode) return Decision.NEEDS_NATIVE_UPDATE;
        return Decision.INSTALL;
    }

    static String sha256Hex(File file) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        return bytesToHex(md.digest());
    }

    /**
     * Unzips {@code zip} into the empty directory {@code dest}. Rejects absolute paths, "..",
     * backslashes, too many entries or too many bytes, and a bundle without index.html.
     */
    static void extractZip(File zip, File dest) throws IOException {
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("cannot create " + dest);
        String destRoot = dest.getCanonicalPath() + File.separator;
        long total = 0;
        int entries = 0;
        byte[] buf = new byte[16 * 1024];
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) throw new IOException("too many entries");
                String name = entry.getName();
                if (!isSafeEntryName(name)) throw new IOException("unsafe entry " + name);
                File out = new File(dest, name);
                if (!out.getCanonicalPath().startsWith(destRoot)) throw new IOException("escapes dest " + name);
                if (entry.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("mkdir " + name);
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_EXTRACTED_BYTES) throw new IOException("bundle too large");
                        os.write(buf, 0, n);
                    }
                }
            }
        }
        if (!new File(dest, "index.html").isFile()) throw new IOException("bundle has no index.html");
    }

    static boolean isSafeEntryName(String name) {
        if (name == null || name.isEmpty() || name.startsWith("/") || name.indexOf('\\') >= 0
                || name.indexOf('\0') >= 0 || name.contains(":")) {
            return false;
        }
        for (String part : name.split("/")) {
            if (part.equals("..")) return false;
        }
        return true;
    }

    /** Resolves a request path inside {@code root}, or null if missing or outside it. */
    static File resolveInside(File root, String path) {
        if (root == null || path == null || !isSafeEntryName(path)) return null;
        try {
            File f = new File(root, path);
            String rootPath = root.getCanonicalPath() + File.separator;
            if (!f.getCanonicalPath().startsWith(rootPath) || !f.isFile()) return null;
            return f;
        } catch (IOException e) {
            return null;
        }
    }

    static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursively(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    static String mimeTypeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    static byte[] hexToBytes(String hex) {
        int len = hex.length();
        if ((len & 1) != 0) throw new IllegalArgumentException("odd hex length");
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            int hi = Character.digit(hex.charAt(i), 16);
            int lo = Character.digit(hex.charAt(i + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("bad hex");
            out[i / 2] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    static String bytesToHex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = digits[(bytes[i] >> 4) & 0xf];
            out[i * 2 + 1] = digits[bytes[i] & 0xf];
        }
        return new String(out);
    }
}
