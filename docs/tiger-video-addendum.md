# Tiger Pet: Video Addendum

This file adds to `tiger-pet-architecture.md` and **overrides** its Section 5 (step 6, "Motion generation") and the "Tiger's states" table in Section 7. Give Antigravity both files.

## What changed

Tiger's real videos contain walking, trotting, pouncing, stalking, grooming, rolling, loafing and sleeping. So the main method is now:

> **Cut Tiger out of his real video and use the real motion. Generate AI motion only for gaps.**

Real motion is more like him than anything generated, and it costs less. Generation is still needed for front-facing views and a few things no video shows (see "Gaps").

## Video inventory

All timestamps are approximate (±1 to 2 s) because I read them from 12-frame contact sheets, not frame by frame. Antigravity should verify them before cutting clips. Most videos are portrait phone clips stored as 1920×1080 with rotation metadata, so the tools must honor rotation. They are 60 fps, which is good for smooth loops.

| File | Length | Audio | What happens |
|---|---|---|---|
| `VID_20260825_134645218__1_.mp4` | 22.7 s | none | **0–7 s:** side-view walk, tail up, then trot toward the camera's left. **7–15 s:** crouches by a blue pole, stalking birds, tail swishing. **15–22 s:** sits with his back to the camera. Tiger is small in frame here. Landscape, 1776×1080. |
| `VID_20260906_114316096.mp4` | 11.3 s | yes | Close-up of Tiger **sleeping on his side**: slow breathing, paws forward, an ear twitch. Best material for the sleep state. The camera drifts and a dark bar crosses the top at times, so use the steadiest windows (about 2–5 s and 8–11 s). |
| `VID_20260909_162336752.mp4` | 31.5 s | yes | **0–3 s:** tail-up walk, close and large in frame. **3–18 s:** meets a grey-and-white kitten and, early on, a black cat (nose-to-nose sniffing). **~21 s:** crouched. **~23–25 s:** the camera is blocked by clothing and is unusable. **26–31 s:** tail-up crouch and walk. Several cats appear, so tracking must follow only Tiger. |
| `VID_20260916_180533584.mp4` | 11.4 s | yes | **0–2 s:** trot with a leap and a fast sprint (pounce). **3–6 s:** low crouch and loaf, side view, **wearing a red-orange collar**. **7–7.5 s:** blurred sprint. **After about 7.5 s the video is sideways** (the phone was rotated), so normalize it. |
| `VID_20260830_143131734__1___1_.mp4` | 1.0 s | **yes, Tiger's own sound** | Portrait clip stored sideways (rotation -90). Tiger is cut off at the right edge, head turning quickly, ears moving, then looking up at the camera. Close to the camera on rough concrete. Use for audio only. |
| `VID_20260916_180547357.mp4` | 29.6 s | yes | Loafing in side view, **licking his paw while seated (~2–3 s)**, tail swishes, a **stalking walk** with nose down (~12 s), walks away (~15 s), sits with his back to the camera (~17 s and ~22–30 s), and a **roll** (~20 s). |

## Decisions Antigravity should surface to me

1. **The collar:** it is visible in the September 16 videos but I did not see it in the earlier photos. The pet package should have a `collar: true/false` setting. Default `false`, using the earlier collar-free footage where possible.
2. **Meows:** I told you I couldn't hear audio, and that still holds. The owner confirmed that `VID_20260830_143131734__1___1_.mp4` is the only video with Tiger's own sound, so the loud bursts I found earlier in the other videos are **not** his voice (street noise, other cats, people, fabric). Do not use any audio from those videos.
   - The sound clip is only **1 second** long. Its spectrogram shows a short tonal call (a rising and falling harmonic stack at roughly 700 to 1200 Hz with higher overtones) from about **0.1 to 0.45 s**, which is the shape a meow has. After that, a lower steady tone around 250 to 270 Hz runs from about 0.45 to 0.8 s. I can't tell whether that is the tail of the meow or something else, such as a nearby voice.
   - I exported two WAV files in `tiger-audio/`: the full 1 s clip, and a trimmed 0.5 s candidate (0.05 to 0.55 s) with short fades. **Confirmed by the owner: the 0.05 to 0.55 s section is Tiger's meow.** It is saved as `tiger-audio/tiger_meow.wav` (the full clip is kept for reference).
   - **Visually the clip is not usable as a meow animation.** Tiger is mostly cut off at the right edge of the frame, turning his head fast, and his mouth is not visible. So the meow animation must be generated from the face photo, with the mouth timed to this sound.

## Revised states (built from video where possible)

| State | Source | Notes |
|---|---|---|
| walk_right and walk_left | v1 0–7 s, v3 0–3 s, v3 26–31 s | Side-view walk cycles. Extract a clean 1 to 2 stride loop and mirror for the other direction. v3's tail-up walk is the most characteristic and the largest in frame. |
| trot / pounce | v4 0–2 s | One-shot. Good for a happy reaction. |
| stalk | v1 7–15 s, v5 ~12 s | Crouch with tail swish. Use for a "playing" or "watching" behaviour. |
| idle_sit_back | v1 15–22 s, v5 22–30 s | Sitting with his back to the camera, head turning. Idle when he is "looking at the screen". |
| idle_sit_front | photo IMG_20260825_082627014 | No video shows him sitting facing the camera, so generate motion for this one. |
| groom (paw) | v5 2–3 s | Real paw lick. |
| groom (shoulder) | photos IMG_20260825_082831457, IMG_20260709_181037016 | Photos only, so generate if needed. |
| loaf / lounge | v4 3–6 s, v5 0–10 s | Lying and relaxed, tail swishing. |
| sleep | v2 | The best real loop. Do not generate this one. |
| roll_play | v5 ~20 s | One-shot. |
| scratch, wink_smug | photos only | Generate from the photos (IMG_20260709_180950472 and IMG_20260709_180946139). |
| talk portrait | photo IMG_20260625_085455688 | Face close-up for the chat bubble, generated blinks and mouth movement. |

## Gaps that still need generation (or new footage)

- Facing the camera: sitting, walking toward you, meowing (a real meow clip, if the classifier finds one, replaces generation).
- Scratching, winking, shoulder grooming, and any tricks.
- Transitions between lying and sitting.

## Changes to Pet Forge

Replace step 6 with this order of work:

1. **Ingest videos:** read rotation metadata, normalize orientation, drop unusable spans (blocked lens, extreme blur), and stabilize handheld shake.
2. **Track and matte Tiger:** pick Tiger with one click on a frame, track him through the clip with a video segmentation model (for example SAM 2), then refine fur edges with a matting model. In v3 the tracker must not jump to the kitten or the black cat.
3. **Normalize:** scale Tiger to a consistent height and anchor his feet to a ground line, so a walk cycle plays in place and the app moves the window.
4. **Cut loops:** find clean loops by comparing frames (a 1 to 2 stride walk loop, the sleep breathing loop), crossfade the seam, and resample from 60 fps to 24.
5. **Resolution check:** in the wide shots Tiger is small, so measure his pixel height and flag clips that would need upscaling. Prefer the closer clips (v3, v2, v4 0–2 s).
6. **Generate only the gaps:** use image-to-video from a cutout photo, with the identity check against the real footage. Ask me for a budget first.
7. **Audio:** use only `tiger-audio/tiger_meow.wav`, (already confirmed as Tiger's meow). There is a single 0.4 s sample, so a meow sound effect will sound repetitive. Make a few variants by pitch-shifting by a small amount (about ±6%) and varying volume slightly, check each by ear, and play them in rotation. Strip the audio from every other video. Generate the meow mouth animation from the face photo, timed to the sound (the call peaks at about 0.1 to 0.45 s). Add a setting to turn his sounds off, since they default to off in quiet mode.

## Updated phase order

- **Phase 2 (alive without AI video)** now uses real clips: walking along the bottom of the screen, loafing, sleeping at night, and the paw-lick groom. Only the sitting-front idle and talk portrait use stills until Phase 5.
- **Phase 5 (Pet Forge)** starts with the video steps above and treats generation as optional.

## Honest limits

- I looked at 12 frames per video, not every frame, so poses, timings and the lack of a front-facing sit are my best reading, not a full review.
- I could not hear the audio.
- Tiger is small in most of the wide shots, and the matted result at the app's target size may look soft until the pipeline is tuned.
- Handheld footage will need stabilization, and a moving background makes loop-cutting harder.
