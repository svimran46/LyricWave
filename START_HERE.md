# START HERE: Tiger Desktop Pet

This project builds a desktop pet that looks and sounds like Tiger, my real orange cat who has passed away. It is built from my own photos, videos and one meow recording.

## Read in this order
1. `docs/tiger-pet-architecture.md` is the main plan: architecture, decisions, phases and acceptance criteria.
2. `docs/tiger-video-addendum.md` was written after the first file. **Where the two files disagree, the addendum wins** (it replaces the motion-generation step and the list of states).

## Folder layout (keep the original file names; the docs refer to them)
```
tiger-pet/
  START_HERE.md
  docs/    the two files above
  raw/photos/   15 JPGs (IMG_2026....jpg)
  raw/videos/   6 MP4s (VID_2026....mp4), including the 1-second clip with his sound
  raw/audio/    tiger_meow.wav (confirmed: his real meow)
```

## Rules
- Nothing in the docs has been run or tested. Treat tool names, model names and timestamps as hints and verify them. Timestamps in the addendum were read from 12-frame contact sheets, so extract frames with ffmpeg and check them before cutting any clip.
- Videos may be stored with rotation metadata. Honor it.
- Use audio only from `raw/audio/tiger_meow.wav`. Strip the audio from every video.
- Ask me before spending money on any paid API, and before installing system-level tools.
- Never write API keys into files. Use the OS keychain or environment variables.
- Work one phase at a time. After each phase, run it, show me evidence (screenshot or test output), list anything unmet, and wait for my approval.
- Keep the app quiet by default: sounds off, a quiet mode, and an easy way to hide him. This is a personal tribute and should be gentle to use.

## First task
Read both docs fully. Write `PLAN.md` that breaks Phase 1 and Phase 2 into tasks with tests. List any questions or missing tools (for example ffmpeg, Rust, Node, Python). Then build Phase 1 only, using Tauri 2 and TypeScript, with all pet data under `pets/tiger/`.
