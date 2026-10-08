# Implementation Plan (v2): LyricWave on Google Play via Trusted Web Activity (TWA)

We will package **LyricWave** for the **Google Play Store** as a **Trusted Web Activity**, built with **Bubblewrap** (the only packaging tool we use; PWABuilder is dropped to keep builds reproducible from the repo).

What TWA gives us:
- A real Android app (`.aab`) installed from Google Play, with its own icon and splash screen.
- No browser URL bar, once Digital Asset Links verification succeeds.
- Web updates pushed to `https://lyricwave.pages.dev` (or the custom domain, see Phase 0) appear in the app without a new store submission.
- Microphone capture, Wake Lock and Media Session work through Chrome's web APIs. The app is Chrome rendering our site, not native code, so we don't claim native performance anywhere.

---

## Phase 0: Decisions to lock in before building

> [!IMPORTANT]
> These are hard to change after the first Play release.

1. **Host / domain.** A TWA is permanently tied to its host. If we ship on `lyricwave.pages.dev` and later move, we need a new Play listing. **Decision needed:** register a custom domain now and point Cloudflare Pages at it, or consciously accept the `pages.dev` lock-in. This plan assumes the final host is called `HOST` below.
2. **Package ID.** `app.lyricwave.twa` (or a reverse-domain you own, e.g. `com.svimran46.lyricwave`). It can never change after the first upload. A reverse-domain of the custom domain is the cleanest choice.
3. **Manifest `id`.** Set to `/` (resolved against the start URL). It must **not** be the Android package name, because it is a URL and `app.lyricwave.twa` would resolve to `https://HOST/app.lyricwave.twa`. Choose once; changing it later changes the app's identity.
4. **Third-party terms.** Confirm we are allowed to display lyrics (licensing source), and that our use of Spotify and Last.fm names and logos follows their brand guidelines. Both are separate takedown and rejection risks.

---

## Phase 1: PWA manifest cleanup

### [MODIFY] `manifest.webmanifest`
- `id`: `"/"`
- `start_url`: `"/"` (or `"/?source=twa"` if we want analytics attribution; keep it consistent with `twa-manifest.json`)
- `display`: `"standalone"`, `display_override`: `["standalone", "minimal-ui"]`
  - `window-controls-overlay` removed: it is desktop-only and irrelevant in a TWA.
- `shortcuts`: "Identify Music" and "Top Charts" with real in-app URLs and icons.
- `categories`: `["music", "entertainment"]` (harmless metadata; the Play category is chosen in Play Console).
- `icons`: 192, 512, and a **maskable** 512 icon for Android adaptive launchers.
- `screenshots`: optional, for browser install prompts only. **Play listing screenshots are uploaded in Play Console**, not read from the manifest.

---

## Phase 2: Digital Asset Links

### [NEW] `public/.well-known/assetlinks.json`
Lets Chrome verify we own `HOST` and hide the URL bar.

- Must contain the SHA-256 certificate fingerprint(s) of the key that **signs the installed app**:
  - **Play App Signing key** (default for new apps): found in Play Console under *Setup → App signing → App signing key certificate*. This is the fingerprint that matters for anything installed from Play.
  - **Upload key** fingerprint (from our own keystore, `keytool -list -v`): include as a second entry so locally built or sideloaded test builds also work.
- **No placeholder ships to production.** With a wrong or placeholder fingerprint the app still installs, but the URL bar shows. This is a launch-checklist item, not just a note.
- Sequencing: the Play signing fingerprint only exists after the app is created in Play Console and a first build is uploaded. Plan: upload to internal testing, copy the fingerprint, update `assetlinks.json`, deploy, retest.

### [NEW] Cloudflare Pages routing safeguards
- Confirm `/.well-known/assetlinks.json` is served directly (HTTP 200, `Content-Type: application/json`, no redirect).
- If an SPA fallback rule (`_redirects` or similar) exists, exclude `/.well-known/*` so it isn't rewritten to `index.html`.
- Add a `_headers` rule for the file's content type if needed.

---

## Phase 3: Privacy policy and data disclosures

### [NEW] `privacy.html` (served at `https://HOST/privacy.html`)
The policy must match what the app actually does, because Google compares it to the Data Safety form. It should state plainly:

- Microphone audio is captured **only when the user starts identification**, and is used for music recognition.
- **The audio sample (or a fingerprint derived from it) is sent to our recognition providers, ACRCloud and AudD, to identify the song.** (Do not claim audio is "never shared with third parties"; it is shared with these processors for this purpose.)
- What we do **not** do: we don't record continuously, and we don't store audio on our own servers. (State provider retention honestly after checking each provider's terms, and link to their policies.)
- Spotify and Last.fm: what scopes we request, how tokens are stored (e.g. on-device only vs. server), how users can disconnect, and how to revoke access.
- What data is stored locally (history, settings) and how to delete it.
- Contact email and policy effective date.

Linked from the app UI and entered in Play Console under *App content → Privacy policy*.

### [NEW] Data Safety form (Play Console, drafted in `docs/play-listing.md`)
Prepare answers in advance, consistent with the privacy page: audio data collected and shared with processors for app functionality, account/auth data for Spotify/Last.fm if applicable, encryption in transit, deletion mechanism.

---

## Phase 4: TWA packaging with Bubblewrap

### [NEW] `twa-manifest.json`
- `packageId`: from Phase 0
- `host`: `HOST`
- `name`: `LyricWave`, `launcherName`: `LyricWave`
- `startUrl`: `/` (matches the web manifest)
- `display`: `standalone`
- `themeColor` / `backgroundColor` / `navigationColor`: `#0a0c10`
- `enableNotifications`: `false`
- `appVersionCode`: integer, **incremented on every Play upload**; `appVersionName`: human version
- `fallbackType`: `customtabs` (used if the TWA can't launch)
- `signingKey`: path to the upload keystore (kept **outside** the repo)
- `generatorApp`: `bubblewrap-cli`

### [NEW] `docs/android-release.md` (replaces the build wrapper script)
Bubblewrap needs a JDK and Android SDK, and its init flow is interactive, so a wrapper script would be brittle. Instead, document the few commands and prerequisites:

1. `npx @bubblewrap/cli init --manifest=https://HOST/manifest.webmanifest` (first time only; commit the resulting `twa-manifest.json`, not keystores or build output)
2. `npx @bubblewrap/cli build` (produces the signed `.aab`)
3. `npx @bubblewrap/cli update` after changing `twa-manifest.json` or the web manifest
4. Upload the `.aab` to Play Console, then bump `appVersionCode` for the next release.

### [MODIFY] `.gitignore`
- Ignore `*.keystore`, `*.jks`, `build/`, `app-release-*`, and generated Android project output.

### Keystore handling
- Generate the upload keystore once; **back it up** (password manager plus an offline copy). Losing it means a painful upload-key reset with Google.
- Never commit it or its passwords.

---

## Phase 5: Play Console process (start early; this drives the calendar)

- **Developer account type.** If this is a newly created personal account, Google requires a **closed test with a minimum number of testers for a minimum period** before production access. Verify the current numbers in Play Console and recruit testers early.
- **Target API level** must meet Google's current requirement (Bubblewrap's latest version normally does; confirm at build time).
- **Content rating questionnaire** (IARC).
- **Microphone permission justification**: core feature is song identification; explain in the listing and any permission declaration.
- **Store listing**: title, short and full description, feature graphic, phone screenshots (real app screens showing identification, lyrics, Reels), 512 px icon. Emphasize the app's own functionality to avoid a "thin website wrapper" rejection.
- **Ads/monetization, target audience, news/health declarations**: complete as applicable.

---

## Verification Plan

### Automated
- `npm test` passes (web engine unchanged).
- Validate `manifest.webmanifest` (Lighthouse PWA audit or equivalent) and that icons, including maskable, resolve.
- Validate `assetlinks.json` is well-formed JSON and lists the correct package name and fingerprints.
- Run `bubblewrap doctor` to confirm the toolchain.

### Manual
- Deploy and check `https://HOST/.well-known/assetlinks.json` returns 200 with `application/json` and no redirect or SPA rewrite.
- Run Google's **Digital Asset Links API** check for `HOST` and the package ID, rather than relying on HTTP status alone.
- Check `https://HOST/privacy.html` renders and matches the Data Safety form.
- Install a **release build from Play internal testing** on a real device and confirm:
  - no URL bar (Digital Asset Links verified)
  - microphone permission prompt and recognition work
  - Wake Lock, Media Session controls and OLED Reels work
  - Spotify and Last.fm OAuth round trips complete and return to the app
  - offline or failed-network behavior is sensible
- Confirm the `.aab` passes Play Console's pre-launch checks with no blocking warnings.

---

## Launch checklist

- [ ] Domain decision made; `HOST` final
- [ ] Package ID and manifest `id` chosen
- [ ] Privacy policy live; Data Safety form matches it
- [ ] Upload keystore backed up
- [ ] First `.aab` uploaded; Play App Signing fingerprint copied into `assetlinks.json` and deployed
- [ ] Digital Asset Links API check passes
- [ ] Closed testing requirement met (if applicable)
- [ ] Content rating, mic justification, listing assets complete
- [ ] `appVersionCode` bumped before every subsequent upload
