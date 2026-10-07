# Google Play Store Listing & Data Safety Answers

Use these prepared responses when completing your Google Play Console store presence and declarations.

---

## 1. Store Presence Metadata

- **App Name (max 30 chars)**: LyricWave: Synced Lyrics
- **Short Description (max 80 chars)**:
  Real-time synchronized lyrics, OLED reel visualizer, and music recognition.
- **Full Description (max 4000 chars)**:
```text
LyricWave is your companion for real-time synchronized music lyrics, dynamic OLED wave visualizers, and instant acoustic recognition.

KEY FEATURES:
• OLED Synced Lyrics Reel: Watch lyrics glide across your screen with sub-millisecond precision, tailored word-by-word reveal, and rich ambient glow.
• Instant Song Recognition: Tap once to identify songs playing around you from vinyl, speakers, radio, or TV using advanced acoustic fingerprinting.
• Top Trending Music Charts: Discover hot daily songs across Pop, Hip-Hop, R&B, Latin, and Country, and launch synced lyrics with one tap.
• Music News & Culture: Catch breaking music industry headlines and album announcements curated from Rolling Stone and NME.
• Multi-Service Connection: Seamlessly follow playback with Spotify Live Sync or Last.fm scrobble tracking.
• 5 OLED Color Themes: Choose between Aurora, Neon Cyan, Album-Adaptive, Classic Vinyl, and Paper themes designed to conserve battery on OLED screens.
• Safe & Private: Audio is analyzed strictly in-memory for acoustic matching and is never saved or stored.
```

---

## 2. Google Play Data Safety Form Answers

Google compares these declarations against your Privacy Policy (`https://lyricwave.pages.dev/privacy.html`).

### Audio Data
- **Does your app collect or share audio data?**
  - **Yes**, the app collects audio recordings.
- **Is this data collected, shared, or both?**
  - **Shared** (transmitted over HTTPS to our acoustic processors ACRCloud / AudD solely to identify the track).
- **Is this data processed ephemerally?**
  - **Yes**. Audio is captured in a 5–10 second transient buffer solely to compute an acoustic fingerprint and is not stored permanently.
- **Is this data required for your app, or can users choose whether it's collected?**
  - **Optional / User initiated**: Microphone capture only activates when the user taps "Tap to Listen".
- **Why is this user data collected/shared?**
  - **App Functionality** (Music recognition).

### Account & Authentication Info (Spotify / Last.fm)
- **Does your app collect personal info?**
  - **No**. User accounts are authenticated client-side via Spotify OAuth 2.0 PKCE. Tokens remain in local device session storage and are never uploaded to LyricWave servers.

### Security Practices
- **Is data encrypted in transit?**
  - **Yes**, all network requests use HTTPS (TLS 1.3).
- **Can users request that their data be deleted?**
  - **Yes**. Local history and preferences can be deleted immediately using the "Reset to Defaults" option in Settings or by clearing browser/app storage.
