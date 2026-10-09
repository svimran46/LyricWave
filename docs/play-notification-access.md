# Google Play: Notification access (media sessions)

LyricWave's Android app declares a `NotificationListenerService` (`MediaListenerService`) **only** so it can call
`MediaSessionManager.getActiveSessions()` and follow the song playing in other music apps. The service ignores every
notification; song info comes from `MediaController` metadata (`NowPlayingMonitor`).

Use the text below in Play Console. Adjust wording to your own voice if you like, but keep it accurate.

## In-app prominent disclosure (already built)

Shown in the **Follow music on this phone** sheet (opened from **Set up** or **Music on this phone** on the **Now** tab)
*before* the user is sent to Android's Notification access screen. The sheet always appears first; there is no path
to the settings screen that skips it:

> LyricWave follows the song playing in any music app on this phone and keeps the lyrics in sync. No login needed.
> - Android calls this **Notification access**.
> - Used **only** to read the song title, artist and playback position.
> - It **never** reads your messages or other notifications.
> - Nothing is stored or uploaded, except title and artist sent to LRCLIB to find lyrics.
> - You can turn it off any time in Android settings.

Button: **Turn on Notification access**; the sheet can be closed (the feature is optional; the Now tab still offers
**Identify a song playing nearby** with the microphone, and Search/Charts work without it).

## App content → Data safety

- **Music files / "Other audio"**: not collected.
- **App activity → Other actions**: the currently playing song title/artist is *processed on device* and sent to LRCLIB only to fetch lyrics.
  This is ephemeral lookup, not stored by LyricWave → answer "processed ephemerally" where the form asks.
- **Messages / notifications**: not collected, not accessed.
- Data is encrypted in transit (HTTPS): Yes. Users can request deletion: Yes (Delete Account / Clear All Data in the app).

## If a reviewer asks why notification access is needed

> LyricWave is a synchronized-lyrics app. Its core feature shows lyrics in time with the song the user is playing in
> another music app (Spotify, YouTube Music, Apple Music, etc.). Android only exposes the active media session — song title,
> artist, duration and playback position — to apps with an enabled NotificationListenerService
> (MediaSessionManager.getActiveSessions requires it). LyricWave's listener service does not read, store or transmit any
> notification content; it exists solely to obtain media-session access. The permission is optional, requested from the
> Now tab after an in-app explanation, and users can use microphone recognition or search instead.

## Demo video / screenshots (if requested)

1. Open LyricWave → **Now** tab → tap **Set up** → show the explanation sheet.
2. Tap **Turn on Notification access** → enable LyricWave → go back.
3. Start a song in Spotify/YouTube Music → LyricWave shows synced lyrics; pause/seek in either app stays in sync.

## Testing sideloaded builds (Android 13+)

APKs installed outside Play have Notification access locked as a *restricted setting*. Testers must open
**Settings → Apps → LyricWave → ⋮ → Allow restricted settings** first. Play-installed builds are not affected.
