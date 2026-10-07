# Tiger Desktop Pet: Architecture and Build Brief

Hand this whole file to Antigravity as the project brief. Ask it to write a `PLAN.md` first, then build one phase at a time and prove each phase's acceptance criteria before moving on.

## 1. Goal

A desktop pet for Windows and macOS that looks like Tiger, my real orange tabby, because it is built from his real photos. He lives in a transparent, always-on-top window, acts out his real behaviours, chats with sass and humour, sets reminders, and teaches me a language.

Non-goals for v1: multi-pet support, a cloud backend, accounts, billing, a 3D model.

This is an independent design. It is inspired by the public description of Furever Dock (desktop companion, daily rhythm, tricks, reminders, chat, memory). Do not copy their code or assets, and do not guess their internals.

## 2. Key decisions

| Area | Choice | Why |
|---|---|---|
| App shell | Tauri 2 (Rust + system webview) | Small installer, transparent always-on-top windows. Furever's download filenames look like Tauri's default naming, which is a guess only. Electron also works. |
| UI and rendering | TypeScript + PixiJS (or plain canvas) | Draws pre-rendered animation frames with transparency. |
| Character look | Real photos, cut out, then short AI-generated motion loops | Highest likeness. A cartoon or generic 3D model will not look like him. |
| Animation format | WebP frame sequences packed in atlases, with alpha | Video-with-alpha support differs between Windows and macOS webviews. Frames are safe everywhere. |
| Brain | LLM through a provider interface, using my own API key | No backend needed for personal use. |
| Storage | SQLite on the local machine | Memory, reminders, lesson progress. All data stays on my computer. |
| Pet creation | A separate Python CLI called `pet-forge` | Offline, repeatable, and reusable for any pet later. |

## 3. System overview

```
 photos/videos ──► pet-forge (Python CLI) ──► pet package (pets/tiger/)
                                                  │
                          ┌───────────────────────▼──────────────────────┐
                          │ Tauri app                                     │
                          │  Rust core: window, tray, click-through,      │
                          │  notifications, autostart, SQLite, secrets    │
                          │  ───────────────────────────────────────────  │
                          │  Webview (TypeScript)                         │
                          │   ├ Renderer (PixiJS, plays clips)            │
                          │   ├ State machine + behaviour scheduler       │
                          │   ├ Brain (persona, memory, tools, LLM)       │
                          │   ├ Lesson engine (spaced repetition)         │
                          │   └ UI (speech bubble, chat, settings)        │
                          └───────────────────────────────────────────────┘
```

## 4. Pet package format

Everything about a pet lives in one folder, so the app never hard-codes Tiger.

```
pets/tiger/
  pet.json        manifest
  atlas/          WebP frame atlases, one set per clip
  masks/          1-bit alpha masks used for click hit-testing
  persona.md      personality and speech style
  portrait.webp   face close-up for chat
```

```json
{
  "id": "tiger", "name": "Tiger", "fps": 24, "height_px": 420,
  "anchor": {"x": 0.5, "y": 1.0},
  "states": {
    "idle_sit":   {"clips": ["sit_a", "sit_blink", "sit_tailflick"], "weight": 5},
    "groom":      {"clips": ["groom_a"], "weight": 2},
    "scratch":    {"clips": ["scratch_a"], "weight": 2},
    "sleep":      {"clips": ["sleep_a"], "weight": 0, "night_only": true},
    "wink_smug":  {"clips": ["wink_a"], "oneshot": true},
    "react_poke": {"clips": ["startle_a"], "oneshot": true}
  },
  "transitions": [
    {"from": "idle_sit", "to": "groom", "clip": "t_sit_to_groom"},
    {"from": "*", "to": "*", "fallback": "crossfade_150ms"}
  ]
}
```

## 5. Pet Forge (photos to pet package)

A CLI with resumable steps, each writing to disk so a failed step does not redo earlier ones.

1. **Ingest:** copy photos, auto-crop the camera frame borders (the black rounded frames and the "NOTHING / PHONE (3A)" label), and undo the rotated or tilted shots.
2. **Quality filter:** drop blurry frames (variance of Laplacian) and near-duplicates. Keep the original-quality version of the noisy duplicate.
3. **Matting:** cut Tiger out with a fur-aware matting model (SAM 2 plus a matting model such as BiRefNet or ViTMatte). Fix colour fringing from the grey concrete (colour decontamination), and output premultiplied alpha. Fur edges are the hardest part, so produce a review image of each cutout on dark, light and orange backgrounds.
4. **Pose tagging:** label each photo with a pose (sit, groom, scratch, lounge, sleep, face) using a vision model, and let me correct the labels in a small review UI.
5. **Identity check:** compute embeddings of Tiger's face and coat from the best photos. Every generated frame later is scored against them, so the cat does not drift into a different cat.
6. **Motion generation:** for each state, feed one cutout photo into an image-to-video model with a short motion prompt (examples in section 7), 3 to 5 seconds, and keep the camera locked. Candidates include Veo, Kling, Runway, Luma, or an open-weights model such as Wan. Check current models, prices and terms, and use whichever gives the best likeness. It needs API keys and costs money per clip, so ask me for a budget before spending.
7. **Video to alpha frames:** re-matte every generated frame, then fix flicker between frames.
8. **Loop closing:** find the best loop point by comparing frames, then crossfade the seam. All clips start and end near a shared rest pose for their family (sitting poses share one, lying poses share another).
9. **Pack:** resize to about 420 px tall, export WebP frames, pack atlases, write masks and `pet.json`.
10. **QA report:** a contact sheet per clip, the identity score, loop-seam score, and file sizes. Anything under threshold is flagged for me to review.

Best raw material: any videos of Tiger. Matting real video gives real motion, including walking, yawning and tail-up, which no photo shows. Use these in step 6 instead of generating whenever possible.

## 6. Desktop shell

- **Window:** about 300 by 400 px, transparent, borderless, always on top, hidden from the taskbar. Show a tray icon with Show, Hide, Quiet mode, Settings and Quit.
- **Click-through:** only Tiger's own pixels take clicks, and the empty transparent area passes clicks to the apps below. Use the per-frame alpha mask for hit-testing. This differs by OS (macOS transparent windows need the private-API flag, and Windows needs layered-window handling), so test on both.
- **Drag and drop:** drag to move, remember the position per monitor, and keep him inside the screen after resolution changes.
- **Autostart:** an optional "start with computer" setting.
- **Secrets:** store the API key in the OS keychain, never in plain text.
- **Notifications:** native OS notifications for reminders.
- **Packaging:** Windows installer and a macOS universal build, with code signing and an auto-updater as later work.

## 7. Animation engine

A state machine plays one clip at a time. Rules:

- Weighted random choice of the next idle state, with a minimum dwell time so he does not fidget constantly.
- Between two states, play a transition clip if one exists, otherwise a 150 ms crossfade. Phase 2 generates real transition clips.
- One-shot reactions (poke, correct answer, wrong answer, reminder) interrupt idle states and return to the nearest rest pose.
- Time of day: awake in the morning, more groom and sleep in the afternoon, asleep from about 21:30 to 06:00 (he dims and stays asleep unless poked, then complains).
- A tiny procedural layer on top of any clip (breathing scale, slight shadow) so even a still frame feels alive.

**Tiger's states, built from his real photos:**

| State | Source photo | Motion prompt idea |
|---|---|---|
| idle_sit | IMG_20260825_082627014 | Sitting upright, looking at camera, slow blink, one ear flick, tail tip twitch |
| groom | IMG_20260825_082831457, IMG_20260709_181037016 | Licks his shoulder, pauses, looks up |
| scratch | IMG_20260709_180950472, IMG_20260709_180944874 | Lying on side, hind leg scratches, head tilted up |
| wink_smug | IMG_20260709_180946139 | The squint or wink with raised paw, a smug look for "correct" or sass |
| lounge | IMG_20260709_181041811, IMG_20260709_175944839 | Lying relaxed, eyes follow something, small ear turns |
| sleep | IMG_20260830_150800234, IMG_20260830_150806222, IMG_20260627_183030757 | Slow breathing, tiny paw twitch |
| talk portrait | IMG_20260625_085455688 | Face close-up for the chat bubble: blink, whisker twitch, small mouth movement |
| react_poke | derived from idle_sit | Startled ear flick, then a smug stare |

Not covered by any photo, so generate or find in video: walking, standing, tail up, eating, meowing, yawning, kneading, and high-five or other tricks.

## 8. Brain (chat, memory, tools)

- **Provider interface:** `chat(messages, tools) → stream`, with a Claude implementation first and room for others. Use a small fast model for chat and a larger one only for lesson generation if needed.
- **Persona (`persona.md`):** Tiger is sassy, funny and a little smug, and replies in one or two short sentences. He teaches me my chosen language. He is a playful tribute to my real cat and does not claim to be him. I will fill in five true habits of the real Tiger so the jokes are grounded in him.
- **Memory:** store facts I tell him, a rolling summary of recent chats, and reminders in SQLite. Show a "What Tiger remembers" screen where I can edit or delete anything.
- **Tools the model can call:** `set_reminder`, `set_timer`, `start_lesson`, `play_state(name)`, `set_mood(name)`, `remember(fact)`, `quiet_mode(minutes)`. Tool calls drive the animation engine, so the cat's body matches his words.
- **Safety:** reminders and tool calls are confirmed in the bubble, and he never sends data anywhere except the LLM call.

## 9. Language lessons

- Language-agnostic decks stored as CSV (`word, reading, meaning, example`), with a default starter deck I can replace.
- Spaced repetition using SM-2 or FSRS, with progress stored locally.
- Question types: pick the meaning, pick the word, type the answer, listen-and-pick (using the OS text-to-speech for pronunciation).
- Tiger reacts to every answer with an animation plus a sassy line (right: smug wink, wrong: judging stare), a streak counter, and daily goal nudges.
- Lessons appear in the bubble or a small panel above him, never a full-screen app.

## 10. Reminders, rhythm, wellbeing

- A daily rhythm like a real cat: greeting in the morning, break reminders every 45 minutes by default (configurable), bedtime at night.
- Natural-language reminders ("remind me in 10 minutes to drink water") through the `set_reminder` tool.
- **Quiet mode:** one click hides or sleeps him for an hour or a day, so he is there when I want him and out of the way when I do not.

## 11. Phases and acceptance criteria

1. **Shell:** Tauri app with a transparent, draggable, always-on-top window showing one static cutout of Tiger. Click-through works on both OSes. *Done when:* I can drag him, click only his body, and quit from the tray.
2. **Alive without AI video:** state machine using only the real photo cutouts with procedural motion and crossfades, speech bubble, pokes, time of day, tray menu. *Done when:* he runs for an hour without visual glitches.
3. **Brain:** chat, persona, memory, reminders, API key in the keychain. *Done when:* a reminder fires on time and he remembers a fact after a restart.
4. **Lessons:** deck import, spaced repetition, reactions. *Done when:* a 10-question lesson completes and tomorrow's review is scheduled.
5. **Pet Forge:** photos to pet package for at least idle_sit, groom, scratch, sleep, with the QA report. *Done when:* the generated clips pass identity and loop thresholds and I approve the contact sheets.
6. **Polish and ship:** installers, signing, autostart, updater, settings screen. *Done when:* a clean machine can install and run him.
7. **Later:** walking and transitions from video, more tricks, other pets, optional backend, optional 3D.

## 12. Risks and honest caveats

- **Likeness drift:** generated video can change markings or proportions. The identity score and my manual review are the safeguard, and real video of Tiger beats generated motion every time.
- **Fur edges:** matting can leave halos or flicker. Budget time for tuning, and review on several backgrounds.
- **Poses:** all clips are from his actual photos, so he cannot walk or do tricks until there is video or generated motion for them.
- **Cost:** video generation costs money per clip. Set a budget before running step 6.
- **Model names and prices change.** Verify the current options before choosing.
- **Feelings:** a realistic replica of a pet who has passed can be comforting and can also be hard on some days. That is why quiet mode is part of v1.

## 13. First prompt to give Antigravity

> Read `START_HERE.md`, then read `docs/tiger-pet-architecture.md` and `docs/tiger-video-addendum.md` fully (the addendum overrides the main file where they disagree). Write a `PLAN.md` that breaks Phase 1 and Phase 2 into tasks with tests, then build Phase 1 only. Use Tauri 2 and TypeScript. Put all pet data in `pets/tiger/` following the manifest format. After finishing, run the app, show me a screenshot, and list anything that does not meet the Phase 1 acceptance criteria. Do not start Phase 2 until I approve.
