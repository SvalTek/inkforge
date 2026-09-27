# Build and test

## Tasks

| Task | What it does |
|---|---|
| `deno task check` | Type-check the app entry (`src/main.ts`) |
| `deno task check:tools` | Type-check every script in `tools/` |
| `deno task build` | Production build into `dist/` |
| `deno task dev` | Build, serve `dist/` on `:4173`, rebuild on change |
| `deno task serve` | Serve an existing `dist/` build without rebuilding |
| `deno task pack -- <folder>` | Package a project folder as a sibling `.inkforge` |
| `deno task smoke` | Build, serve, and drive headless Chrome through the smoke checks |
| `deno task check:authoring` | Browser check for authored tools, modals and UI actions |
| `deno task check:renderer` | In-process canvas projection and layer checks |
| `deno task check:pack` | `.inkforge` version-precedence checks, and a drift guard that every committed pack matches its folder |
| `deno task docs:dev` | Run the VitePress docs site with live reload |
| `deno task docs:build` | Build the docs site into `dist/docs/` |
| `deno task docs:preview` | Preview the built docs site |
| `deno task fmt` / `deno task lint` | Format and lint the Deno sources |
| `deno task fmt:check` | Report formatting drift without writing, for verifying a change |

`dev` and `serve` accept `--port <n>`. `pack` accepts `--out <file.inkforge>`, `--bump major|minor|patch` and
`--force`.

**Line endings are pinned to LF.** `.gitattributes` sets `text=auto eol=lf`, so a checkout is LF on every operating
system while `text=auto` still leaves binary packs, audio and images byte-for-byte alone. This matters because `deno fmt`
writes LF: without the attribute a Windows checkout is CRLF and `deno task fmt:check` reports nearly every file as
unformatted, which is a line-ending false positive rather than real drift.

The docs site uses VitePress. Install its pinned dependencies once with `npm ci --prefix docs`; the application tasks
remain Deno-only.

## What the build does

`tools/build.ts` runs esbuild over `src/main.ts` and then assembles a static site:

1. **Bundle** — `src/main.ts` to `dist/assets/main.js`, ESM, browser platform, ES2020, minified. The
   `@luca/esbuild-deno-loader` plugin resolves `https:`, `npm:` and `jsr:` specifiers through Deno's module graph and
   the `deno.json` import map, so the app can depend on a pinned remote commit without vendoring it.
2. **Inline the Lua WASM** — wasmoon's `glue.wasm` is located via `import.meta.resolve("wasmoon")`, base64-encoded into
   a data URI, and injected as the `__INKFORGE_WASM_URI__` define. The bundle is therefore self-contained: no separate
   `.wasm` file to ship, and no way for it to go stale or fail to load.
3. **Decorators** — `experimentalDecorators` is restated in `tsconfigRaw` because esbuild does not read `deno.json`.
   Without it esbuild emits standard TC39 decorators, whose `(value, context)` signature does not match the legacy
   `(target, key, descriptor)` form the binding decorators expect, and the bindings silently install nothing.
4. **Static copy** — `index.html` to `dist/`, `templates/` to `dist/templates/`.
5. **Styles** — every `styles/*.css` partial is concatenated in filename order into `dist/style.css`, then minified
   by esbuild. The numeric prefixes are the ordering mechanism; a new partial must be named to sort where it belongs.
   The sources themselves are written to be read: one declaration per line, a header comment on each file saying what
   layer it is, and section comments inside. Declaration order within a rule is preserved because shorthand and
   longhand properties depend on it. A media query adds no specificity, so a `@media` block only overrides the base
   rules above it by coming after them — each file keeps its narrow-viewport blocks at the end for that reason.
   Minification happens at build time only, so the readable form costs nothing at runtime; `build({ minify: false })`
   leaves the concatenation unminified.

Output is a set of plain static files. Host `dist/` on any static host; no build step or server runtime is needed there.

## The checks

Four suites, two flavours. The browser ones prove the app works end to end; the in-process ones pin behaviour that is
awkward to observe through a page.

### `deno task smoke`

Builds, serves, and drives Chrome. Captures console messages, page errors and dialogs, and fails on unexpected ones.

| # | Assertion |
|---|---|
| 1 | Play boot (starter project) |
| 1a | Main loop ticks clean — no per-tick Lua errors |
| 2 | Lua boot and `require()` across files, and the authored meter id reaching the DOM |
| 3 | Canvas composition and runtime — hit-test, tween, timer |
| 4 | Author mode: switching, editing, persistence |
| 4a–4d | Editor tabs: open, close-active, reopen, close-last |
| 4e | Rapid edits are flushed before export |
| 4f | Lua completion and hover come from the API manifest |
| 5 | YAML project loading with `!import` composition |
| 6 | Import/export round-trip (`!import`, state effect, VFS identity) |
| 6a | Lua-authored projected scene and world pointer coordinates |
| 6b | Viewport bounds clip content and input |
| 6c | Responsive viewport fills remaining panel space |
| 6d | Binary audio asset preview and Lua lifecycle |
| 6e | Equal or older import is declined |
| 6f | Authored markup is rendered as text (XSS regression) |
| 6g | Authored error text is rendered as text |
| 6h | Markdown renders, and authored links are gated behind a confirmation dialog |
| 7 | New project restores the starter |
| 8 | A Lua timer repaints a bound meter with no command |
| 8a | Inventory definition actions validate payloads, isolate per-instance state, serialize pending calls, protect context from Lua mutation, expose detached metadata, and stop after game over |
| 8b | An NPC definition validates portrait and state defaults; an instance places it; a location lists the instance; `npcVar` gates on seeded state, `npcSet` and `inc` write it, and `GameNPCs` reads the authored half |
| 8c | A conversation owns the choice list and the command box, a dotted `call:` in an option receives its conversation context, options append to the transcript, a node with no options ends the exchange, a gate closing mid-exchange ends it, an option whose `then` ends the run ends the conversation too, a `discoverable` conversation is offered from an NPC's presence alone, two of them live at once warn and resolve to the first, a location action may be authored as `id: "talk:bell"`, and `GameConversations.start` / `.finish` drive the same state machine from Lua |
| 9 | Save a run, restart without overwriting it, and resume its state and inventory |
| 9a | Export a save as JSON, delete it, import it, and resume it |
| 9b | Importing over the active project's own save asks first, even after a boot that failed |

Assertion 8b runs its Lua legs from a **location** action, deliberately. A dotted `call:` such as `keeper.asked` only
resolves when the engine walks the name segment by segment, and it used to do that on the execution-context path alone — so
a dotted name from a contextless site (a location action, a UI `then:`) passed the boot check and then failed at the
moment it was reached. The two halves of that name are now resolved by one rule, and this assertion is the regression
guard for the contextless half.

Assertion 1a exists because a Lua error on every tick is invisible in a screenshot — it was written to catch a real
regression where the runtime leaked stack slots until it trapped. Assertion 8 covers the repaint model: a
`timers.setInterval` that changes a bound state variable must update a meter with no command, click or UI action, and
must cost one frame per mutation rather than one per animation frame.

Assertion 6h is what keeps authored prose from being restructured by accident: a one-line `text:` entry renders inline
markdown, so a line beginning `-` stays prose, while the same line inside a `|` block becomes a real list. The same check
proves a `javascript:` link renders literally with no script run, and that an `https:` link opens only after the
confirmation dialog. See [Markdown](../authoring/markdown.md).

Assertion 2 also reads the focus meter's rendered fill colour. A skin rule keyed to an authored id is dead in silence if
that id never reaches the DOM — the meter keeps rendering, on the default colour, and nothing complains — so the check
compares two meters' fills instead of asserting the attribute, which catches the hook going missing however it happens.

### `deno task check:authoring`

Drives Chrome through the authored-surface checks: YAML and Lua tool registration, icons, hover, modal recursion and
paging, UI actions, state controls and reset.

### `deno task check:renderer`

Runs `InkforgeCanvasRuntime` directly, with no browser. Covers layer order, projection hit-testing and the canvas math.
This is where canvas-loop and animation changes can be pinned deterministically.

### `deno task check:save`

Runs the snapshot round-trip in process, with no browser: the transcript cap, the save/export envelope, and the
tolerance of a hand-edited or imported file. A save can arrive from any browser or a text editor, so every field is
narrowed rather than trusted — a malformed tool definition, UI field or nested child is dropped so it costs that entry
instead of the whole resume, which is the failure mode only a test can reach.

### `deno task check:pack`

In-process checks of `.inkforge` version precedence — the SemVer comparison that decides whether an import lands — plus
a drift guard: every committed `templates/*.inkforge` is unzipped and compared, file by file, against the folder it was
built from, so a pack left behind by an edit fails here rather than shipping stale content.

## Working on the checks

The browser suites need a served build; `smoke` does the build and serve itself. When adding an assertion, prefer
asserting on **observable state that a user could see** — a terminal line, a meter's text, a frame count — rather than
on internals, because that is what makes a failure legible.

Two traps worth knowing:

- **Timing.** Asserting on the first paint of something driven by a timer is flaky, because boot often takes longer
  than the timer's interval. Capture the initial value, then wait for it to change.
- **Readiness.** Wait on `document.body.dataset.projectReady`, which a superseded boot deliberately does not set. It is
  the only correct signal that a boot committed.

## Packaging a project from disk

```sh
deno task pack -- templates/lantern-below
deno task pack -- my-project --out dist/my-project.inkforge
```

The folder must contain `manifest.json`, `scenario.yaml` and `scripts/main.lua`. Every path in the manifest is checked:
relative, forward slashes only, no `..`, no duplicates, no escapes outside the folder, and `assets/` entries must have a
supported extension. Paths are packaged as UTF-8 VFS files, assets as binary.

Packing also compares the result against the pack already at the output path, and refuses when the project files
changed while `project.version` did not — an import of that pack would be declined as `already v<version>`, so it would
ship a change nobody could install. `--bump patch|minor|major` raises the version and writes it into the folder's
`manifest.json`; `--force` repacks in place. The version bumped is `manifest.json`'s `project.version`, never
`scenario.yaml`'s `meta.version` — see [the package version is not the scenario
version](../authoring/project-format.md#the-package-version-is-not-the-scenario-version).

The packer also requires the configured Lua entry script, resolved from the composed scenario so `scripts.main` is
honoured rather than the conventional path. That check is skipped when the YAML does not compose: a project mid-edit
still packs, and the YAML error is reported at boot instead, which is what browser export and import already do.
