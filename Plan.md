# Multi-project library, binary assets, and audio support

Status: implemented, verified, and checkpointed (2026-09-23)

This is internal engineering tracking. It records architecture and verification
state; it is not public author documentation.

## Objective

Replace the single mutable localStorage scenario with an IndexedDB-backed
project library. Make `.inkforge` a validated version-2 ZIP package, preserve
multiple imported scenarios with semantic-version replacement, and carry a
small deliberate image/audio asset set through storage, authoring, runtime,
and export/import.

The runtime keeps one project-local text VFS for YAML composition and Lua
mounting. All project-local image/audio consumers resolve through one active
project asset resolver. Audio is a JavaScript HTML-audio manager with a narrow
modular Lua facade and one-shot YAML activation.

## Settled contracts

### Project identity and library

```json
{
  "format": "inkforge-pack",
  "packVersion": 2,
  "project": {
    "id": "renderer-stage-showcase",
    "title": "Renderer Stage Showcase",
    "author": "Inkforge",
    "version": "0.1.0"
  },
  "files": ["scenario.yaml", "scripts/main.lua", "assets/map.svg"]
}
```

- `project.id`, semantic `project.version`, and `files` are required.
- `title`/`author` are optional and fall back to scenario metadata/project ID.
- IndexedDB stores identity, text VFS, typed asset records, `updatedAt`, and
  pinned state. localStorage stores only active project ID and migration-era
  lightweight state.
- The old `inkforge-project-v1` localStorage record migrates once. The bundled
  Lantern Below project is seeded as pinned. New project creates a generated-ID
  starter copy and never overwrites another project.
- Load project is an application-level library modal with title, author,
  version, updated time, active marker, load, and delete actions. The pinned
  starter cannot be deleted; deleting the active project selects it first.
- Editor changes are flushed before load/import/export/new/delete. Accepted
  imports are stored before activation; validation/storage failure preserves the
  current active project.

### Package and assets

- `.inkforge` v2 is a ZIP via `fflate`: root `manifest.json`, listed text
  sources, and listed binary assets.
- Imports validate format/version, identity/version, safe paths, required
  `scenario.yaml` and `scripts/main.lua`, listed entry existence, UTF-8 source,
  and supported asset extension/MIME.
- Unknown IDs are added and activated. Newer matching versions replace and
  activate. Equal/older versions remain unchanged and are reported.
- Supported images: `.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`.
- Supported audio: `.mp3`, `.ogg`, `.wav`.
- GIF, video, fonts, arbitrary binaries, and nested archives are out of scope.
- Asset records are `{ path, mime, size, data: Blob }`. `data:` URLs normalize
  to blobs; `blob:` URLs are session-only.
- `AssetResolver` caches object URLs, reports missing paths, and revokes URLs on
  restart/project switch. Tools, modals, canvas images, Author previews, and
  audio use it.

### Author explorer

- Source files remain selectable editor documents.
- `assets` is an expandable section listing every asset with filename, type, and
  size. Selecting one opens a preview document rather than the textarea.
- SVG has image and optional source preview; raster images show dimensions;
  audio uses native controls and metadata; invalid content displays a diagnostic.
- Author `+` imports supported local image/audio files as
  `assets/<basename>`, rejects unsupported files and duplicate paths, and saves
  successful imports to IndexedDB.

### Audio

```lua
local sound_id = game.audio.play("assets/click.ogg", {
  id = "click", loop = false, volume = 0.8
})
game.audio.stop("click")
game.audio.pause("click")
game.audio.resume("click")
game.audio.set_volume("click", 0.5)
game.audio.set_loop("click", true)
game.audio.stop_all()
```

- `AudioManager` owns HTML audio elements, generates IDs for omitted one-shot
  sounds, clamps volume to `0..1`, and disposes all audio on restart/switch.
- Autoplay/media failures use diagnostics/output.
- YAML supports one-shot `events.activate: { type: audio.play, asset, ... }`.
- No mixer groups, fades, ducking, or spatial audio in this slice.

## Tasklist and interim tracking

### Phase 0 — Baseline and contract

- [x] Preserve the existing renderer/tool/modal checkpoint as the starting tree.
- [x] Replace the prior Plan.md with this library/assets/audio plan.
- [x] Keep shell tools, authored modals, persistent UI, and projected viewport
      as separate concepts.

### Phase 1 — Project record and persistence

- [x] Add manifest v2 identity/types and typed Blob asset records.
- [x] Add IndexedDB project store and active-project localStorage key.
- [x] Add one-time v1 migration and pinned Lantern Below seeding.
- [x] Make New project an independent generated-ID copy.
- [x] Add Load project library modal, active metadata, fallback delete, and
      awaited editor flush boundaries.

Interim verification: `deno check src/main.ts`, `deno lint`, and browser smoke
checks for initial seed, multiple records, active loading, deletion fallback,
and reload persistence.

### Phase 2 — ZIP packaging and versioned imports

- [x] Add `fflate` ZIP v2 browser export/import.
- [x] Validate manifest identity/version, required sources, safe paths, entries,
      UTF-8 text, and supported asset types.
- [x] Implement unknown/newer/equal/older version behavior.
- [x] Make `tools/package.ts` require object manifests and dogfood tracked packs.
- [x] Rebuild tracked `.inkforge` template artifacts through the packer.

Interim verification: export/import text round-trip, newer replacement,
equal/older refusal, and `deno task pack templates/renderer-showcase`.

### Phase 3 — Shared asset pipeline and Author previews

- [x] Normalize data URLs and binary blobs into typed project assets.
- [x] Add resolver caching, missing diagnostics, and URL revocation.
- [x] Route tools, modals, canvas images, previews, and audio through resolver.
- [x] Fix imported VFS SVG/binary canvas image resolution.
- [x] Replace the no-op asset explorer row with enumeration, expansion,
      metadata, preview documents, and local import/duplicate rejection.

Interim verification: SVG/raster/audio preview, local WAV import, duplicate
rejection, and shared tool/modal/canvas resolution checks.

### Phase 4 — Audio runtime and Lua/YAML API

- [x] Add `AudioManager` and lifecycle cleanup.
- [x] Add modular `src/lua/facades/audio.ts` and narrow bridge callbacks.
- [x] Add YAML one-shot `audio.play` activation.
- [x] Verify play, generated/effective IDs, loop, volume clamp path,
      pause/resume, stop, stop-all, restart, and project-switch cleanup.

Interim verification: browser audio trace coverage in `tools/smoke.ts` with a
binary WAV asset carried through ZIP and IndexedDB.

### Phase 5 — Architecture record and completion

- [x] Update Architecture.md only after the contracts were implemented.
- [x] Remove stale single-project/v1 pack claims from architecture tracking.
- [x] Keep public documentation and a full docs tree out of scope.
- [x] Run type-check, tool-check, lint, renderer check, authoring check, smoke,
      packaging, and diff hygiene checks.
- [x] Commit this completed feature checkpoint.

## Verification matrix

| Area | Evidence |
| --- | --- |
| IndexedDB seed/migration | startup library path and migration implementation |
| Multi-project load | `tools/smoke.ts` project library/load/reload checks |
| Import replacement | smoke newer replacement plus equal/older refusal |
| Delete/fallback | smoke active-copy deletion selects pinned starter |
| ZIP v2 | smoke export/import manifest and entry round-trip |
| Text/assets | smoke VFS round-trip; authoring SVG/WAV previews/import |
| Shared resolver | authoring tool/modal blob icon and smoke canvas path |
| Audio | smoke WAV preview and Lua lifecycle trace |
| Renderer regressions | existing renderer and viewport smoke checks |
| Tooling | `deno task pack`, type-check, lint, diff-check |

## Current verification record

2026-09-23: Implementation is complete and committed.
`deno task smoke` passes 16/16 browser assertions with zero console errors,
page errors, or dialogs. `deno task check:authoring` passes the project-library,
asset preview/import, tools, modals, Lua registration, and reset checks.
The complete command matrix and commit review passed for this checkpoint.
