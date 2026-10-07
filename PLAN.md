# Tiger Desktop Pet: Implementation Plan (Phases 1 & 2)

Based on `tiger-pet-architecture.md` and `tiger-video-addendum.md` (Addendum precedence applied).

---

## 1. System Environment Audit & Prerequisites

### Tool Availability Audit
| Tool | Status | Version / Path | Notes |
|---|---|---|---|
| **Python** | Available | 3.13.1 (`python`) | Ready for `pet-forge` and asset processing scripts |
| **Node.js** | Available | v22.14.0 (`node`) | Ready for Tauri frontend and Vite tooling |
| **npm** | Available | 10.9.2 (`npm.cmd`) | Note: invoke via `npm.cmd` due to Windows PowerShell execution policy |
| **ffmpeg** | Available | 7.1-essentials (`ffmpeg`) | Ready for video frame extraction and audio trimming |
| **Rust / Cargo** | **MISSING** | Not installed | **Required for Tauri 2**. Needs `rustup` + MSVC C++ Build Tools |
| **Visual Studio C++ Build Tools** | **MISSING** | Not detected | Required by Rust `x86_64-pc-windows-msvc` target for linking |
| **Disk Space** | **CRITICAL WARNING** | **0.92 GB Free on C:** | Rust + MSVC + Tauri compilation requires at least 4–8 GB free disk space |

### Assets Status
- `raw/photos/` (15 JPGs): Not yet in workspace.
- `raw/videos/` (6 MP4s): Not yet in workspace.
- `raw/audio/tiger_meow.wav`: Not yet in workspace.
- *For Phase 1 shell testing:* A fallback / temporary cutout representation will be used until raw photos are placed into `raw/`.

---

## 2. Phase 1: Desktop Shell (Tauri 2 + TypeScript)

### Goal & Acceptance Criteria
- Transparent, borderless, always-on-top desktop window showing Tiger.
- **Draggable**: Drag anywhere on Tiger's body to move him across the desktop, clamped to viewport.
- **Click-through**: Only Tiger's opaque pixels register mouse events (clicks, drags); transparent pixels allow clicks to pass through to underlying desktop applications.
- **System Tray**: System tray icon with `Show`, `Hide`, `Quiet Mode`, `Settings` (placeholder), and `Quit`.
- **Pet Package Structure**: Pet data organized under `pets/tiger/` following the manifest schema.
- **Exit**: Cleanly quit from the tray menu.

---

### Phase 1 Task Breakdown

#### Task 1.1: Project Setup & Tauri 2 Configuration
- Initialize Tauri 2 project with TypeScript + Vite frontend.
- Configure `tauri.conf.json`:
  - Window configuration:
    - `transparent: true`
    - `decorations: false`
    - `alwaysOnTop: true`
    - `skipTaskbar: true`
    - `shadow: false`
    - Default size: ~320x420 px
  - Setup System Tray with context menu items (`Show`, `Hide`, `Quiet Mode`, `Settings`, `Quit`).
  - Configure native system permissions for window manipulation and tray.

#### Task 1.2: Pet Package Layout (`pets/tiger/`)
Create the standard pet package folder structure:
```
pets/tiger/
  pet.json          # Pet manifest (id, fps, anchor, states, collar flag)
  portrait.webp     # Static close-up / cutout
  cutout.webp       # Static cutout for Phase 1 idle pose
  persona.md        # Persona instructions
  masks/            # Alpha mask data for hit-testing
  atlas/            # Sprite atlas placeholder
```
- Set default `collar: false` in `pet.json` per addendum decision #1.

#### Task 1.3: Click-Through & Alpha-Mask Hit Testing
- On Windows, transparent webviews can pass mouse clicks to background windows when clicking transparent areas.
- Tauri 2 provides `set_ignore_cursor_events(true/false)`.
- Implement cursor hit-testing:
  - Track pointer movements over the window.
  - Check pixel alpha value under the cursor via canvas/mask data.
  - If alpha == 0 (transparent background), toggle `ignore_cursor_events(true)` so the OS passes mouse interactions directly to underlying windows.
  - If alpha > 0 (Tiger's body), enable cursor events (`ignore_cursor_events(false)`) to allow dragging, clicking, and hover.

#### Task 1.4: Dragging and Viewport Constraints
- Implement drag handling on Tiger's body using Tauri's native `startDragging()` window API or custom coordinate delta dragging.
- Ensure dragging does not interfere with click detection.
- Persist window desktop coordinates to local settings so Tiger remembers his position across app restarts.
- Clamp coordinates to screen bounds so Tiger cannot be dragged off-screen.

#### Task 1.5: System Tray & Window Control
- Register tray menu items:
  - `Show Tiger`
  - `Hide Tiger`
  - `Quiet Mode` (toggle)
  - `Settings`
  - `Quit`
- Implement tray event handler to show/hide the main window and terminate the app cleanly on `Quit`.

---

### Phase 1 Verification & Tests
1. **Window Transparency Test**: Verify window has zero background color/border, showing only Tiger floating above desktop icons.
2. **Click-Through Test**:
   - Click directly on Tiger: registered by app (starts drag or logs click).
   - Click 10px outside Tiger's body: clicks through to folder/desktop/browser underneath.
3. **Drag Test**: Drag Tiger across screen; verify smooth movement and boundary clamping.
4. **Tray Controls Test**:
   - Click "Hide Tiger" -> Window disappears.
   - Click "Show Tiger" -> Window restores to previous position.
   - Click "Quit" -> App process terminates cleanly without hanging background processes.

---

## 3. Phase 2: "Alive Without AI Video"

*(Incorporates `tiger-video-addendum.md` overrides: uses real video loops where available, procedural motion, speech bubble, pokes, circadian rhythm).*

### Goal & Acceptance Criteria
- Tiger feels alive running purely on real cutouts/clips without waiting for AI video generation.
- Real cutouts with procedural micro-motions (subtle breathing scale, gentle ear/tail shifts, soft ground shadow).
- Real video loops (extracted from raw videos per addendum):
  - `walk_left` & `walk_right`: extracted from `VID_20260909_162336752` / `VID_20260825_134645218__1_.mp4`.
  - `loaf` / `lounge`: extracted from `VID_20260916_180533584` / `VID_20260916_180547357`.
  - `sleep`: extracted from `VID_20260906_114316096.mp4`.
  - `groom_paw`: extracted from `VID_20260916_180547357`.
  - `idle_sit_front`: static photo cutout with procedural breathing until Phase 5.
- State machine with weighted transitions and 150ms crossfades between states.
- Speech bubble component rendered above Tiger with sassy dialogue triggers.
- Interactive Poke reaction (clicking Tiger triggers startle / ear flick / smug stare reaction).
- Time-of-day circadian rhythm: active daytime, afternoon lounging, dims & sleeps from 21:30 to 06:00.
- Runs continuously for at least 1 hour with zero visual glitches or memory leaks.

---

### Phase 2 Task Breakdown

#### Task 2.1: State Machine & Clip Player
- Build TypeScript state machine supporting:
  - States: `idle_sit_front`, `walk_right`, `walk_left`, `loaf`, `sleep`, `groom_paw`, `stalk`, `react_poke`.
  - Weighted random transitions with minimum dwell times (prevent twitching).
  - Crossfading renderer (PixiJS / Canvas 2D dual-buffer crossfade with 150ms interpolation).
  - One-shot interrupts: `react_poke` interrupts idle and smoothly returns to rest pose.

#### Task 2.2: Video Frame Extraction & Matting Pipeline
- Extract frames from raw videos using `ffmpeg` honoring orientation metadata:
  - Normalize rotation.
  - Downsample from 60 fps to 24 fps.
  - Scale to standard pet height (~420px).
- Pack frames into WebP sprite sheets / frame sequences with alpha.
- Build loop seam crossfades for smooth cyclic playback.

#### Task 2.3: Procedural Motion Layer
- For static poses (such as `idle_sit_front`), apply subtle procedural lifelike transforms:
  - Breathing cycle: sine-wave vertical stretch (1.00 to 1.018 y-scale, ~3.5s cycle).
  - Ground contact shadow with dynamic expansion matching breathing.
  - Micro-drift / eye blink pacing.

#### Task 2.4: Circadian Rhythm (Time of Day Engine)
- Monitor local clock:
  - **Morning / Day (06:00 - 14:00)**: Higher weights for `idle_sit_front`, `walk`, `stalk`.
  - **Afternoon (14:00 - 21:30)**: Higher weights for `loaf`, `groom_paw`.
  - **Night (21:30 - 06:00)**: Forces `sleep` state, dims brightness by 30%.
  - If poked while asleep at night: plays grumpy one-shot wake reaction, complains in speech bubble, returns to sleep.

#### Task 2.5: Speech Bubble & Interaction UI
- Speech bubble component rendered dynamically above Tiger with SVG pointer.
- Auto-sizing, typewriter text reveal, timeout dismiss, and click-to-dismiss.
- Non-blocking layout (bubble allows click-through outside its content).
- Poke interaction: clicking on Tiger triggers immediate `react_poke` state and a random sassy remark.

#### Task 2.6: Sound Effects (Meow Engine)
- Use only confirmed meow audio (`raw/audio/tiger_meow.wav` / `tiger-audio/tiger_meow.wav`).
- Implement pitch variation (±6%) and volume variation to prevent repetition fatigue.
- Sound settings toggle in tray menu; muted by default (Quiet Mode enabled by default).

---

### Phase 2 Verification & Tests
1. **State Transition Test**: Unit test verifying state machine weights, minimum dwell durations, and valid transition graph.
2. **Crossfade Visual Test**: Seamless 150ms crossfade between different clip sequences without black flash or alpha clipping.
3. **Poke Reaction Test**: Clicking Tiger while idling immediately triggers `react_poke` animation and returns to rest.
4. **Circadian Rhythm Test**: Mock system time across day, afternoon, and night; verify appropriate state weights and dimming at night.
5. **Stability & Memory Leak Test**: Run animation loop for 60 minutes in automated test harness, tracking DOM node count, canvas context stability, and JS heap memory.

---

## 4. Key Questions & Blockers for User

1. **Rust & C++ Build Tools Installation Approval**:
   - Tauri 2 requires `rustc` and `cargo` along with Visual Studio C++ Build Tools.
   - Per project guidelines ("Ask me before installing system-level tools"), please confirm if you would like me to assist in installing `rustup` and the required C++ build tools, or if you prefer an alternative shell approach (e.g. Electron with transparent window).
2. **Disk Space Constraint on Drive C:**:
   - Drive C: currently has only **0.92 GB** available. Installing Rust and the C++ build tools requires at least 4–8 GB free space.
   - (Note: `C:\Users\User\Downloads\kali-linux-2026.2-live-amd64.iso` is ~5.5 GB). Please advise if space can be cleared or if an alternate drive path can be used for tool installations.
3. **Location of Raw Media Files**:
   - The docs reference `raw/photos/` (15 JPGs), `raw/videos/` (6 MP4s), and `raw/audio/tiger_meow.wav`.
   - These are not currently present in the project directory or Downloads. Please provide or point to where these files are located.
