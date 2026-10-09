# In-app updates (Android)

The Android app shows the web files (HTML/JS/CSS) bundled inside the APK. To ship UI changes
without a new APK, every push to `main` publishes a **signed web bundle**, and installed apps
download it in the background.

## How it works

1. `.github/workflows/web-update.yml` runs `node scripts/web-update.mjs build` on each push to
   `main` that touches the web app, and uploads three files to the `web-latest` release:
   `web-update.properties` (version, required APK version, sha256, size), `web-update.sig`
   (ECDSA P-256 signature of the properties file) and `web-bundle.zip`.
2. On launch/resume (at most every 30 min) `WebUpdater.java` downloads the properties and
   signature, verifies the signature with the public key compiled into the APK, checks the
   version is newer, downloads the zip, checks its sha256 and unpacks it into app storage.
3. The app shows **"A new version of LyricWave is ready" → Reload**. If ignored, the update
   applies on the next cold start. **Settings → About** shows the version and a **Check** button.
4. Files missing from a bundle fall back to the APK's copy. Installing a new APK discards all
   downloaded bundles, so a fresh APK always starts from its own files.

Versions are commit timestamps (`git log -1 --format=%ct`), stamped both on the bundle and on
the APK's own files (`BuildConfig.BUILT_IN_WEB_VERSION`), so a bundle only replaces the APK's
files when it comes from a newer commit.

## One-time setup

```bash
node scripts/web-update.mjs keygen
```

This writes `android/web-update-public.pem` (commit it) and `web-update-private.pem`
(gitignored). Then:

1. GitHub → **Settings → Secrets and variables → Actions → New repository secret**:
   name `WEB_UPDATE_PRIVATE_KEY`, value = the whole contents of `web-update-private.pem`.
2. Back up `web-update-private.pem` in your password manager and delete the local copy.
3. Push to `main` and install the resulting APK (`twa-latest` release) **once**. From then on,
   web changes reach the app without reinstalling.

Until the public key is committed the updater is off and the app behaves as before.
Don't regenerate the key (`keygen --force`) unless it leaked: apps with the old key then stop
accepting updates until they install an APK with the new one.

## When you still need a new APK

Changes to the Java code (`android/app/src/main/java/...`), the manifest or permissions.
**Bump `versionCode`** in `android/app/build.gradle` when you do: each bundle records the
`versionCode` it was built with as `minNativeVersion`, so older APKs keep their current files
and the app tells the user to download the new APK instead of loading web code that calls
native features they don't have.

Once the app is on Google Play, native updates can also use Play's In-App Updates API.
