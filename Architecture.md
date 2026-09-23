# Inkforge Adventure Studio — Target Architecture

Status: baseline port complete; renderer viewport-boundary correction verified — see section 17
Source reference: `../inkforge-local/` (READ-ONLY)
Target: `inkforge/` (this repository)

This document describes the architecture of the ported `inkforge/` project. It is
derived from, and must remain behaviorally faithful to, the read-only source in
`../inkforge-local/`:
- `index.html` (15 lines) — application shell, all DOM ids/classes
- `style.css` (18 physical lines, minified, cumulative override layers)
- `app.js` (289 physical lines) — engine, VFS, YAML composition, Wasmoon bridge, editor
- `canvas-runtime.js` (572 lines) — canvas compositor, interaction, animation, timers, main loop
- `templates/lantern-below/**` — starter project (YAML + Lua)
- `templates/renderer-showcase/**` and `templates/renderer-showcase.inkforge` — internal renderer
  showcase source and packed verification fixture

Where a fact in this document can be checked against the source, a `file:line`
reference is given. Implementation agents must treat source line references as the
authority and this document as the plan.

---

## 1. Purpose, scope, non-goals

### Purpose

`inkforge/` is a pure client-side browser SPA that provides:
- a text-adventure **engine** (YAML-authored locations, items, actions, state, inventory),
- an **authoring editor** (file tree, tabs, gutter, cursor, format label, diagnostics),
- a **canvas compositor** (`InkforgeCanvasRuntime`: scenes, nodes, drawing, hit-testing,
  pointer events, animations, timers, main loop),
- a **Lua scripting bridge** via Wasmoon (WASM Lua 5.4) with a `game.*` API,
- a **project pack format** for export/import of a whole project (`.inkforge`).

The repository also contains **Deno-based development and build tooling** used only
on the developer machine / CI.

### Scope

- Browser runtime code is authored as TypeScript under `src/`, bundled to ESM with esbuild.
- Deno tooling under `tools/` builds and serves the static app.
- Production output is **static assets only** in `dist/`.

### Non-goals (explicit)

- **No SSR, no backend, no API server, no database, no server state.** The Deno server
  is a static file server for local development/serving only.
- **No React** (or any UI framework). The source uses direct DOM manipulation; the port
  preserves that.
- **Do not replace or remove Wasmoon/Lua.** Lua execution via Wasmoon is a preserved feature.
- **No change to the on-disk project format** or the `.inkforge` pack format.
- **Deno APIs must not leak into browser code.** `src/**` must not reference `Deno.*`,
  `npm:`, `jsr:`, or Node built-ins. Only `tools/**` may use Deno APIs.
- **No compatibility wrappers** and no leftover `app.js` / `canvas-runtime.js` copies
  in `inkforge/` (see section 13).

---

## 2. Source of truth and behavior-preservation principles

1. `../inkforge-local/` is the behavioral source of truth. When this document and the
   source disagree, the source wins and this document must be corrected.
2. **Port, do not redesign.** Module boundaries are new; observable behavior is not.
3. **Preserve bytes where it matters.** The CSS cascade order and the `CANVAS_LUA_API`
   Lua string are preserved byte-for-byte (see sections 8 and 12).
4. **Preserve the DOM contract.** All ids, classes, and generated markup listed in
   section 14 must exist exactly as in `index.html` and the render functions.
5. **Preserve semantics of the engine.** `check`, `execute`, `move`, `dispatch`,
   `available`, UI override resolution, and event ordering are unchanged.
6. **Four documented deviations** (section 15): three consolidations forced by removing the
   duplicate wrappers in the original `app.js`, plus one explicit, user-requested editor-tab
   enhancement. Every other observable difference is a bug.
7. **Types are documentation, not behavior.** The TypeScript type layer (section 5) must
   not change runtime shape; it only constrains it.

---

## 3. High-level architecture

The browser runtime and the Deno tooling are strictly separated. Browser code never
imports from `tools/`, and `tools/` never runs in the browser.

```
                          DEVELOPER MACHINE / CI (Deno 2.9.5)
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  tools/                                                                   │
   │    build.ts   ── esbuild(npm:esbuild) ──► dist/                           │
   │    server.ts  ── Deno static file server ──► http://localhost:PORT        │
   │    serve.ts / dev.ts ── orchestrate build + server                        │
   │    smoke.ts   ── playwright-core + system Chrome ──► browser assertions   │
   │                                                                           │
   │  inputs:  src/**.ts  styles/*.css  index.html  templates/**               │
   └───────────────┬───────────────────────────────────────────────────────────┘
                   │ build: bundle + copy (esbuild + Deno fs)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  dist/  (STATIC ASSETS — the only production artifact)                    │
   │    index.html  assets/main.js  style.css  templates/**                  │
   └───────────────┬───────────────────────────────────────────────────────────┘
                   │ HTTP GET (static)
                   ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  BROWSER (no Deno APIs, no server state)                                  │
   │                                                                           │
   │   index.html ── loads dist/assets/main.js (ESM bundle)                    │
   │      │                                                                    │
   │      ├─ src/app/*      boot + DOM wiring                                  │
   │      ├─ src/engine/*   conditions / directives / engine / ui-state        │
   │      ├─ src/project/*  starter + VFS normalization + storage              │
   │      ├─ src/yaml/*     YAML load + !import/!mixin composition             │
   │      ├─ src/vfs/*      path resolution                                    │
   │      ├─ src/lua/*      Wasmoon boot + CANVAS_LUA_API + global bridge      │
   │      ├─ src/canvas/*   InkforgeCanvasRuntime (draw/hit/anim/timers)       │
   │      ├─ src/editor/*   gutter/cursor/format                               │
   │      ├─ src/ui/*       render + UI actions                                │
   │      └─ src/import-export/*  .inkforge pack                               │
   │                                                                           │
   │   dynamic imports at runtime from jsDelivr CDN:                           │
   │     https://cdn.jsdelivr.net/npm/yaml@2.6.0/+esm                          │
   │     https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm                      │
   └──────────────────────────────────────────────────────────────────────────┘
```

Key rule: everything inside the BROWSER box is portable, dependency-free browser
JavaScript. Everything inside the DEVELOPER MACHINE box is Deno-only and never shipped.

---

## 4. Target module map

Provenance column: source line ranges in the read-only reference. `(live)` marks the
effective declaration where the source contains duplicates; `(dead)` marks superseded
declarations that must NOT be ported (see section 13).

| Path | Responsibility | Provenance |
| --- | --- | --- |
| `src/main.ts` | Browser entry point: `createApp()`, then `app.initialise()` exactly once. | `app.js:68` (immediate `initialiseProject()` call), `app.js:1` |
| `src/app/context.ts` | `AppContext` / `AppView` types: the shared app surface (`dom`, `project`, `scenario`, `runtime`, `canvas`, `lua`, `engine`, `output`, `current`, `openFiles`) and the facade method signatures. | derived (section 5) |
| `src/app/dom.ts` | `queryDom` (typed element map, including the `.tabs` container) and the `$` / `$all` DOM query helpers. | `app.js:1` |
| `src/app/app.ts` | `createApp`: builds the single `AppContext` facade (`initialise`, the consolidated `start`, `restart`, `showView`, `switchFile`, `syncEditor`, `lineNumbers`, `persist`, `render`, `runUiAction`, `newProject`, `exportPack`, `importPack`), and binds events once. | `app.js:2`–`app.js:5`, `app.js:66`–`app.js:75` |
| `src/app/boot.ts` | `bootRuntime`: construct `InkforgeCanvasRuntime`, tear down the prior canvas/Lua runtime, call `createLuaEngine`, wire `setUpdate` and the canvas/timer/afterFrame hooks. | `app.js:258`–`app.js:288` (live `bootLua` body) |
| `src/app/events.ts` | All DOM event wiring: `#code` input/keyup/scroll, `.file` (tabs are bound by `renderTabs`), `.nav`, command forms, restart/run, export/import/new, inventory close. | `app.js:32` (dead), `app.js:72` (live), `app.js:33`–`app.js:41` |
| `src/engine/events.ts` | `emit` and `createOutput` (push an output event and set `runtime.canvasViewDirty`). | `app.js:11` (dead), `app.js:246` (live) |
| `src/engine/conditions.ts` | `check(condition, runtime)` predicate evaluator (`and`/`or`/`not`/`hasItem`/`var` comparisons). | `app.js:12` |
| `src/engine/directives.ts` | `lines()` normalizer, `itemName`, `move`, and the `execute(list, deps)` directive interpreter. | `app.js:9`, `app.js:13`, `app.js:15` |
| `src/engine/ui-state.ts` | `applyUi`, `resolveField`, `uiFields`, `uiElement` (UI override resolution). | `app.js:14`, `app.js:18`–`app.js:20` |
| `src/engine/engine.ts` | `createEngine`: builds the `EngineApi` facade (`check`/`move`/`execute`/`available`/`dispatch`) over `conditions.ts` and `directives.ts`. | `app.js:13`, `app.js:16`, `app.js:17` |
| `src/project/project.ts` | `TEMPLATE_PATHS` and `normalizeProject` (VFS normalization + legacy field mirroring). | `app.js:60`–`app.js:61` |
| `src/project/starter.ts` | `TEMPLATE_BASE` and `loadStarterProject`: fetch all `TEMPLATE_PATHS` into a VFS. | `app.js:4` (dead), `app.js:63` (live) |
| `src/project/storage.ts` | `PROJECT_KEY`, `saveProject` / `loadSavedProject` under `inkforge-project-v1`. | `app.js:2`, `app.js:5` |
| `src/vfs/vfs.ts` | `resolveProjectPath`: import path resolution and root-escape protection. | `app.js:61`, `app.js:62` |
| `src/yaml/loader.ts` | Lazy dynamic import of `yaml@2.6.0`. | `app.js:6` |
| `src/yaml/compose.ts` | `composeScenario` plus the recursive `resolve`/`load` for `!import`/`!mixin`/`<<`. | `app.js:62`, `app.js:64`–`app.js:65` |
| `src/lua/loader.ts` | `loadWasmoon`: dynamic import of the remote `wasmoon@1.16.0` ESM build. | `app.js:265` |
| `src/lua/lua-api.ts` | Assembles the byte-preserved `CANVAS_LUA_API` bootstrap from the shared layer and facade modules. | `app.js:98`–`app.js:244` |
| `src/lua/shared.ts` | Shared Lua JSON serialization and callback registry used by the facades. | derived from `app.js:98`–`:131` |
| `src/lua/facades/output.ts` | `game.output` Lua facade. | derived from `app.js:98`–`:244` |
| `src/lua/facades/state.ts` | `game.state` Lua facade. | derived from `app.js:98`–`:244` |
| `src/lua/facades/ui.ts` | `game.ui` Lua facade. | derived from `app.js:98`–`:244` |
| `src/lua/facades/canvas.ts` | Canvas callbacks, node/scene/animation handles, and `game.canvas` facade. | derived from `app.js:98`–`:244` |
| `src/lua/facades/timer.ts` | Timer handles and `game.timer` facade. | derived from `app.js:98`–`:244` |
| `src/lua/facades/events.ts` | Lua callback entry points for canvas and timer events. | derived from `app.js:98`–`:244` |
| `src/lua/bridge.ts` | `createLuaEngine`: `LuaFactory` creation, `mountFile` for every `*.lua`, registration of Lua globals (`__ui_*`, `__output`, `__state_*`, `__canvas_command`, `__timer_*`), `doString`/`doFile`, callback capture. | `app.js:259`–`app.js:288` |
| `src/canvas/runtime.ts` | `InkforgeCanvasRuntime` class: scenes, nodes, draw, pointer, timers, animations, loop. | `canvas-runtime.js:1`–`canvas-runtime.js:560` |
| `src/canvas/math.ts` | Canvas point mapping, local point, hit tests, matrix multiply/invert/transform. | `canvas-runtime.js:470`–`canvas-runtime.js:559` |
| `src/canvas/projection.ts` | Flat, isometric, and oblique viewport projections; forward/inverse point mapping, depth keys, and projected node transforms. | new renderer foundation |
| `src/canvas/easings.ts` | Easing table attached as `InkforgeCanvasRuntime.easings`. | `canvas-runtime.js:562`–`canvas-runtime.js:570` |
| `src/editor/editor.ts` | `lineNumbers` (gutter), `updateCursor` (readout), `syncEditor` (flush + persist), the path-based `switchFile`, and the dynamic open-tab management: `DEFAULT_OPEN_FILES`, `tabLabel`, `renderTabs`, `closeFile` (section 15(iv)). | `app.js:28`, `app.js:33`, `app.js:41`, `app.js:71`, `app.js:72` |
| `src/ui/render.ts` | `render`, `renderUi`, `renderInventory`, `inspectItem`, `openInventory`. | `app.js:22` (dead), `app.js:247` (live), `app.js:23`–`app.js:26` |
| `src/ui/actions.ts` | `runUiAction` dispatch (inventory/command/instructions/Lua callback). | `app.js:21` |
| `src/import-export/pack.ts` | `exportPack` and `importPack` (`.inkforge`). | `app.js:37`–`app.js:39` |
| `src/types/index.ts` | Barrel re-export of the type model. | derived (section 5) |
| `src/types/project.ts` | `Project`, `ProjectVfs`, persisted shape. | `app.js:3`, `app.js:61` |
| `src/types/vfs.ts` | VFS map type and path helpers. | `app.js:61`–`app.js:62` |
| `src/types/scenario.ts` | Scenario document: meta/state/player/ui/definitions/instances/locations/scripts. | `templates/lantern-below/scenario.yaml` + `app.js:27` |
| `src/types/ui.ts` | UI element, field, override, action shapes. | `app.js:14`, `app.js:18`–`app.js:22`, `templates/lantern-below/ui.yml` |
| `src/types/engine.ts` | Runtime state, inventory, event, location/action/item shapes. | `app.js:13`–`app.js:17` |
| `src/types/events.ts` | Event union (`output`, `location:enter`, `inventory:add`, `inventory:remove`, `ui:update`, `game:over`). | `app.js:11`, `app.js:13`–`app.js:15`, `app.js:246` |
| `src/types/canvas.ts` | Scene, node, viewport, projection, layer, animation, timer, pointer-event, binding types. | `canvas-runtime.js:92`–`canvas-runtime.js:107`, `canvas-runtime.js:220`–`canvas-runtime.js:281`; renderer foundation |
| `src/types/lua.ts` | Lua engine, Lua value, callback reference types. | `app.js:258`–`app.js:288` |
| `src/types/editor.ts` | Editor state (current path, format, cursor). | `app.js:28`, `app.js:71`, `app.js:72` |
| `src/deps/remote.ts` | CDN URL constants (`YAML_ESM_URL`, `WASMOON_ESM_URL`) and `loadEsm`, which keeps the specifier in a variable so the CDN URL stays a runtime import. | `app.js:6`, `app.js:265` |
| `tools/paths.ts` | Shared path constants: `ROOT`, `DIST`, `SRC`, `STYLES`, `TEMPLATES`, `INDEX_HTML`. | new (tooling) |
| `tools/build.ts` | esbuild bundle (`src/main.ts` -> `dist/assets/main.js`) + static copy + CSS partial concatenation. | new (tooling) |
| `tools/dev.ts` | Watch/rebuild + serve orchestration. | new (tooling) |
| `tools/serve.ts` | `deno task serve` entry (serves an existing `dist/`). | new (tooling) |
| `tools/server.ts` | Deno static file server (correct MIME types, `no-store` caching). | new (tooling) |
| `tools/smoke.ts` | Playwright smoke harness: build, serve, drive headless Chrome, assert the checks. | new (tooling) |
| `deno.json` | Tasks, imports, `compilerOptions` (`lib: ["dom","dom.iterable","dom.asynciterable","esnext","deno.ns"]`), and the `fmt`/`lint` excludes. | new (tooling) |
| `index.html` | Application shell, DOM ids/classes; `<script type="module" src="/assets/main.js">`. | `index.html:1`–`index.html:15` |
| `styles/*.css` | Ordered CSS partials; concatenated to `dist/style.css`. | `style.css:1`–`style.css:18` (section 12) |
| `templates/lantern-below/**` | Starter project copied verbatim into `dist/`. | `templates/lantern-below/**` |
| `templates/renderer-showcase/**` | Internal Lua/YAML renderer fixture copied into `dist/templates/renderer-showcase/`; it is not the starter project or public API documentation. | current showcase slice |
| `templates/renderer-showcase.inkforge` | Packed copy of the showcase VFS for import/export verification. | current showcase slice |
| `.gitignore` | Ignores `dist/` and `node_modules/`. | new (tooling) |
| `README.md` | Contributor-facing run/build/test summary. | new (docs) |
| `dist/` | Generated static output. Not authored, not committed by hand. | generated |

---

## 5. Type model summary

Rule: **no `any`.** Dynamic data (Lua values, YAML documents) is typed as `unknown`
and narrowed. Index signatures are used for dynamic maps.

| Type | File | Mirrors runtime shape |
| --- | --- | --- |
| `Project` | `types/project.ts` | `{ scenario: string; script: string; assets: string[]; vfs: ProjectVfs }` — mirrors the project after `normalizeProject` (`app.js:61`). |
| `ProjectVfs` | `types/vfs.ts` | `Record<string, string>` keyed by VFS path (`scenario.yaml`, `scripts/main.lua`, ...). |
| `Scenario` | `types/scenario.ts` | Parsed/composed document: `meta`, `startLocation`, `state`, `player`, `ui`, `definitions`, `instances`, `locations`, `scripts`. |
| `UiElement` / `UiField` / `UiOverride` / `UiAction` | `types/ui.ts` | Mirrors `applyUi`/`uiElement`/`uiFields` (`app.js:14`, `app.js:18`–`app.js:20`) and `ui.yml`. |
| `RuntimeState` | `types/engine.ts` | `{ location, state, inventory, events, over, ui: { hidden: Set<string>, overrides, elements } }` (`app.js:66`). |
| `GameEvent` | `types/events.ts` | Discriminated union of all pushed events. |
| `CanvasScene` / `CanvasNode` / `CanvasViewport` / `CanvasAnimation` / `CanvasTimer` / `CanvasBinding` / `CanvasPointerEvent` | `types/canvas.ts` | Mirrors `createScene`/`addNode`/`createTween`/`timer`/`dispatch` (`canvas-runtime.js:92`, `:109`, `:257`, `:220`, `:206`). |
| `LuaValue` / `LuaEngine` / `LuaCallbackRef` | `types/lua.ts` | Mirrors Wasmoon usage (`app.js:258`–`app.js:288`); `LuaValue` is `unknown` with narrowing helpers. |
| `EditorState` | `types/editor.ts` | `{ current: string; format: 'YAML' | 'LUA'; cursor: { line: number; col: number } }`. |

Additional rules:
- YAML and Lua boundary values enter as `unknown`; convert with explicit narrowing
  helpers, never casts to `any`.
- Dynamic maps (`definitions.item`, `instances.item`, `locations`, `vfs`) use
  `Record<string, T>` index signatures.
- `Set<string>` is retained for `runtime.ui.hidden` (behavioral parity with the source).

---

## 6. Runtime data flow

### Boot and load

```
main.ts
  └─ app.initialise()                              [app/app.ts:51]
       ├─ saved = loadSavedProject()               [project/storage.ts, app.js:75]
       ├─ starter = await loadStarterProject()     [project/starter.ts, app.js:63] (fetch TEMPLATE_PATHS)
       ├─ project = normalizeProject(saved ?? starter)   [project/project.ts, app.js:61]
       ├─ if project.scenario contains the bundled-starter markers -> reset to starter  [app.js:75]
       ├─ current = 'scenario.yaml'; code.value = project.vfs[current]  [app.js:75]
       ├─ lineNumbers()                            [editor/editor.ts]
       └─ await start()                            [app/app.ts:66 consolidated]
```

### `start` pipeline (single consolidated function)

```
start()                                            [app/app.ts:73, from app.js:66 -> :70 -> :74]
  ├─ project = normalizeProject(project)
  ├─ if project.vfs[current] !== undefined: project.vfs[current] = code.value
  │    (sync ONLY the current editor file; the old wrapper70 additionally overwrote
  │     scenario.yaml with the editor buffer, corrupting the project when a non-scenario
  │     file was open — see section 15)
  ├─ project.scenario = project.vfs['scenario.yaml']
  ├─ project.script   = project.vfs['scripts/main.lua']
  ├─ if scenario empty -> clear UI, return
  ├─ scenario = await composeScenario(project.vfs)  [yaml/compose.ts, app.js:64-65]
  │    ├─ yaml = await loadYaml()        [yaml/loader.ts, app.js:6]
  │    ├─ parse scenario.yaml with !import/!mixin custom tags
  │    ├─ resolve() recursively: !import -> load(path); !mixin/<< -> merge base
  │    └─ circular import -> Error("Circular import: ...")
  ├─ validate startLocation + scenario.locations[startLocation]
  ├─ runtime = { location, state, inventory, events, over, ui }   [app.js:66]
  ├─ output = createOutput(runtime); engine = createEngine(...)   [engine/events.ts, engine/engine.ts]
  ├─ await bootRuntime(app, scenario, hooks)     [app/boot.ts, app.js:258]
  ├─ engine.move(runtime.location)               [app.js:13]
  └─ render()                                    [ui/render.ts, app.js:23]
```

### Command dispatch

```
dispatch(raw)                                      [app.js:17]
  ├─ clear runtime.events
  ├─ look/l           -> execute(location.text); render()
  ├─ exit match       -> check(exit.if) ? move(to) : warning; render()
  ├─ "take <x>"       -> execute({give}); remove from loc.items; output; render()
  ├─ "@<action>"      -> check(action.if) ? execute(action.then); render()
  └─ else             -> output("Unknown command: ...", "warning"); render()
```

`move(id)` sets `runtime.location`, clears `runtime.conversation`, pushes
`location:enter`, then `execute(location.text)` (`app.js:13`).

### UI action flow

```
renderUi() [app.js:247] builds elements, binds [data-ui] onclick -> runUiAction
runUiAction(element) [app.js:21]
  ├─ action.type 'inventory.open' -> openInventory
  ├─ action.type 'command'        -> dispatch(action.command)
  ├─ action.type 'instructions'   -> execute(action.then); render()
  └─ action.callback + runtime.lua -> lua.global.get(callback)(); render()
```

### Lua -> app flow

Lua calls `game.*` -> `__canvas_command` / `__timer_command` / `__output` / `__state_*`
/ `__ui_*` -> JSON strings parsed on the JS side -> `engine.command` / `engine.timer`
/ `output` / `applyUi`. See section 8.

---

## 7. Canvas subsystem

`InkforgeCanvasRuntime` (`canvas-runtime.js:1`–`:560`) remains the rendering kernel,
split into `src/canvas/runtime.ts`, `src/canvas/math.ts`, `src/canvas/projection.ts`,
and `src/canvas/easings.ts`. The right panel contains one physical viewport canvas
between independent flat UI regions: `#surfaceHeader` above it and `#gameHud` plus
actions below it. The viewport canvas fills only the remaining panel space; there is
no camera abstraction. Projection is the logical-coordinate-to-viewport mapping.

### Class responsibilities

- Construction/destruction: `constructor(host, hooks)` (`:2`), `destroy()` (`:14`).
- Main loop: `setUpdate` (`:25`), `schedule` (`:30`), `tick` (`:35`), `hasClockWork` (`:47`),
  `resetClock` (`:52`). `dt` is clamped to `[0, 0.1]` seconds (`:37`).
- Command dispatch: `command(command)` switch over `scene.create`, `scene.clear`,
  `scene.remove`, `node.add`, `node.set`, `node.translate`, `node.remove`, `event.set`,
  `event.remove`, `animation.create`, `animation.keyframes`, `animation.control` (`:56`–`:90`).
- Scene lifecycle: `createScene` (`:92`), `addNode` (`:109`), `removeNode` (`:122`).
- Surfaces: `mountSurfaces` (`:131`), `bind` (`:153`); the host resize observer
  redraws fitting when the responsive viewport changes size.
- Pointer: `pointerMove` (`:164`), `pointerDown` (`:182`), `pointerUp` (`:192`), `dispatch` (`:206`).
- Timers: `timer` (`:220`), `timerRemaining` (`:240`), `timerActive` (`:241`), `advanceTimers` (`:243`).
- Animations: `createTween` (`:257`), `createKeyframes` (`:271`), `controlAnimation` (`:283`),
  `advanceAnimations` (`:295`), `applyAnimation` (`:315`), `interpolate` (`:342`).
- Drawing: `draw` (`:347`), `drawScene` (`:349`), `children` (`:390`), `drawNode` (`:394`),
  `drawShape` (`:409`), `paint` (`:442`), `fillStroke` (`:454`), `px`/`py` (`:455`–`:456`),
  `image` (`:458`).

### Scene / node model

- Scene (`createScene`, `:92`): `{ id, viewport {width:960,height:720,fit:'contain',projection?},
  projection, layers, background:'transparent', accessibleLabel, nodes: Map, order: string[],
  canvas, context, view, hitStack, hoverNode, pointerNode }`.
- Node (`addNode`, `:109`): defaults `{ visible:true, opacity:1, x:0, y:0, rotation:0,
  scale:1, interactive:true, ...source, parentId }`; optional `layer`, `space`, `z`, `elevation`,
  and `depth` select composition behavior; `children` is deleted and recursed.
- Node shapes drawn (`drawShape`, `:409`): `rect` (rounded via `roundRect`), `circle`/`marker`
  (arc), `line`/`path` (polyline, closed for `path`), `text` (fill/strokeText), `image`/`sprite`
  (with optional `frame` sub-rect). `originX`/`originY` are fractions of width/height.
- With no layer declarations, draw order remains `scene.order`, children after parents. Declared
  layers sort by `order`; a layer with `sort:'depth'` uses the active projection depth key with
  stable insertion-order tie breaking. Device pixel ratio remains capped at 2 (`:354`).
- `flat` is the identity projection and is the default. `isometric` and `oblique` project world
  roots; screen-space roots bypass projection. Root projection preserves the existing local
  node transform and child-parent matrix behavior.
- `hitStack` is rebuilt every `drawScene`; only nodes with `events`, `interactive !== false`,
  and `opacity > 0` are pushed (`:403`–`:404`).
- `drawScene` clips after the fit transform to the logical `{0,0,width,height}` viewport
  rectangle. This keeps contain letterbox space and cover-cropped scene space outside the
  drawable scene boundary even though the physical canvas fills the host.

### Matrix / hit-testing (`src/canvas/math.ts`)

- `canvasPoint` (`:470`) maps client coords to virtual scene coords using `scene.view` and
  returns `null` when the point is outside the logical viewport rectangle. Letterbox,
  cropped, and captured pointer positions therefore cannot activate offscreen content.
- `localPoint` (`:479`) maps a world point into a node's local space via inverse matrix.
- `hit` (`:485`) walks `hitStack` back-to-front; `contains` (`:494`) does per-shape tests:
  circle (radius + padding), polygon (`polygon`, `:519`), line (`segmentDistance`, `:528`,
  tolerance = lineWidth/2 + padding), else axis-aligned rect with padding.
- `nodeMatrix` (`:534`), `multiply` (`:541`), `invert` (`:549`), `transform` (`:559`).
- `hit` overrides on a node (`node.hit`) can override type/size/points/padding.
- Projection helpers in `src/canvas/projection.ts` provide `project`, `unproject`, `depth`, and
  projected transform operations. Inverse matrix hit-testing therefore works for projected
  geometry without changing the existing shape hit rules.
- `dispatch` preserves virtual viewport `x/y` and node-local `localX/localY`, and adds
  inverse-projected ground-plane `worldX/worldY/worldZ` values. `worldZ` is `0` because a
  2D pointer cannot infer elevation; the Lua `__canvas_event` bridge carries all fields.

### Animations

- Tween (`createTween`, `:257`): interpolates listed keys from current node values to
  `values`, `duration` min 0.001, default easing `linear`, `repeat_count` default 0,
  `yoyo` supported. `applyAnimation` (`:315`) uses the easing table.
- Keyframes (`createKeyframes`, `:271`): frames sorted by `at`, interpolated between
  neighbouring frames.
- `interpolate` (`:342`): numeric lerp; non-numeric switches at `progress >= 1`.
- Controls: `pause`/`resume`/`cancel`/`finish` (`controlAnimation`, `:283`).

### Timers

- `create` (`:220`): `{ delay, remaining: immediate?0:delay, callback, repeating,
  repeatCount (-1 = infinite), iteration, active, paused }`.
- `advanceTimers` (`:243`): fires callback, reschedules repeats (`remaining += max(delay,0.001)`),
  deletes one-shot timers. Controls: `pause`/`resume`/`restart`/`cancel`.

### mountSurfaces and ensure/remove hooks

`mountSurfaces(surfaceElements)` (`:131`):
- clears the host with `replaceChildren()`,
- for each `text` element appends `<div class="ui-text">`,
- for each `canvas` element appends `<canvas class="game-canvas" data-scene="<id>"
  aria-label="<label>">` and binds the matching scene if present,
- redraws.

The host is the viewport region, not the whole right panel. CSS allocates its remaining
height after the header and before the flat HUD/action region, with `min-height: 0` and
`overflow: hidden` so flex/grid sizing cannot make the canvas escape the viewport. Each
mounted canvas fills that host as the physical clipping surface; logical scene fitting,
logical clipping, and pointer-boundary rejection remain runtime invariants.

`ensureSurface(id, label)` / `removeSurface(id)` are runtime hooks supplied by
`src/app/boot.ts` (the `InkforgeCanvasRuntime` hooks object it builds; originally
`app.js:271`–`:272`): they add/remove a `canvas` UI element in
`runtime.ui.elements` so the surface persists across renders.

---

## 8. Lua bridge

Booted by `src/app/boot.ts` (canvas construction + runtime hooks) and `src/lua/bridge.ts`
(engine + globals), with the remote module loaded by `src/lua/loader.ts`; from
`app.js:258`–`app.js:288`.

### Globals registered on the Lua engine

| Global | JS behavior |
| --- | --- |
| `__ui_create` | `applyUi({ create: JSON.parse(payload) })` |
| `__ui_set` | `applyUi({ set: { [id]: JSON.parse(payload) } })` |
| `__ui_show` / `__ui_hide` / `__ui_remove` | `applyUi({ show/hide/remove })` |
| `__output` | `output(text)` |
| `__state_get` / `__state_set` | read/write `runtime.state[path]` |
| `__canvas_command` | `engine.command(JSON.parse(payload))` |
| `__timer_command` | `engine.timer(JSON.parse(payload))` |
| `__timer_remaining` / `__timer_active` | `engine.timerRemaining(id)` / `engine.timerActive(id)` |

### Boot sequence

1. Tear down any prior runtime: `activeCanvasRuntime.destroy()` and `activeLua.global.close()`
   (`app.js:259`–`app.js:261`).
2. `scriptPath = scenario?.scripts?.main || 'scripts/main.lua'`; read source from
   `files.vfs[scriptPath]`; throw `Script not found: <path>` if absent (`app.js:262`–`:263`).
3. If source is empty, return (`app.js:264`).
4. `LuaFactory` from `wasmoon@1.16.0`; `mountFile(path, content)` for **every** `*.lua`
   in `files.vfs` (`app.js:265`–`:266`).
5. `createEngine({ injectObjects: true })`; store as `activeLua` and `runtime.lua`
   (`app.js:267`–`:268`).
6. Construct `InkforgeCanvasRuntime($('#gameSurface'), hooks)` with hooks `callLua`,
   `ensureSurface`, `removeSurface`, `asset`, `event`, `timer`, `afterFrame`
   (`app.js:269`–`:277`). `asset(path)` returns a data/blob URL if the VFS value is one,
   otherwise the raw path.
7. Register all globals above (`app.js:279`–`:285`).
8. `await lua.doString(CANVAS_LUA_API); await lua.doFile(scriptPath)` (`app.js:286`).
9. Capture `__canvas_event` and `__timer_event` as `runtime.canvasEvent` / `runtime.timerEvent`
   (`app.js:287`).
10. `update = lua.global.get('update')`; `engine.setUpdate(typeof update === 'function' ? update : null)`
    (`app.js:288`).

### `CANVAS_LUA_API` (verbatim)

`CANVAS_LUA_API` (`app.js:98`–`app.js:244`) is assembled from `src/lua/shared.ts` and
`src/lua/facades/*.ts`. The assembled Lua chunk **must remain byte-for-byte identical** to
the source, including indentation and escaping. The modules divide the API into the
`output`, `state`, `ui`, `canvas`, and `timer` facades, while shared serialization and
callback/event support remains separate. Together they define:

- `quote` / `json` serializers (with `error('Cannot encode '..kind)` for unsupported types).
- Callback registry: `callbacks`, `callback_ref`, `prepare_events`, `prepare_node`.
- Handles: `animation_handle`, `node_handle`, `scene_handle`, `timer_handle`.
- `game` table with `output`, `state`, `ui`, `canvas`, `timer`.
- `game.canvas.create(spec)` -> `__canvas_command({op:'scene.create', scene})` -> `scene_handle`.
- `game.canvas.node(sceneId, nodeId)` -> `node_handle`.
- `game.timer.after(delay, cb, opts)` / `game.timer.every(delay, cb, opts)`.
- `__canvas_event(reference, sceneId, nodeId, type, x, y, worldX, worldY, worldZ, localX,
  localY, button, pointerType, altKey, ctrlKey, shiftKey)` and `__timer_event(reference,
  timerId, iteration)`. `x/y` are virtual viewport coordinates; `worldX/worldY/worldZ` are
  inverse-projected ground-plane coordinates (`worldZ` is `0`); `localX/localY` are node-local.

Only this `CANVAS_LUA_API` bootstrap is live. The older non-canvas `game={...}` bootstrap
string embedded in the dead `bootLua` at `app.js:78`–`app.js:95` is **dead** and must not be ported.

### Update loop / callbacks

- `engine.setUpdate(update)` schedules the RAF loop; each `tick` calls `hooks.callLua(update, dt)`.
- Pointer events are dispatched by the canvas runtime through `hooks.event(callback, event)`,
  which calls `runtime.canvasEvent(...)`; if `runtime.canvasViewDirty` is set, `render()` runs
  (`app.js:274`).
- Timers call `hooks.timer(callback, id, iteration)` -> `runtime.timerEvent(...)`; same dirty
  check (`app.js:275`).
- `afterFrame` flushes `runtime.canvasViewDirty` -> `render()` (`app.js:276`).

---

## 9. VFS + YAML composition

### VFS

- `TEMPLATE_PATHS` (`app.js:60`) lists the nine starter files:
  `scenario.yaml`, `state.yml`, `player.yml`, `ui.yml`, `definitions.yml`,
  `instances.yml`, `locations.yml`, `scripts/main.lua`, `scripts/threshold.lua`.
- `normalizeProject(project)` (`src/project/project.ts`, `app.js:61`) normalizes any
  project into a VFS:
  - if `project.vfs` missing, seeds `{'scenario.yaml': project.scenario||'', 'scripts/main.lua': project.script||''}`;
  - mirrors `scenario`/`script` from the VFS back to the legacy fields;
  - ensures `assets` is an array.
- All VFS keys are full relative paths with extensions. There is **no** key `'scenario'`.

### Path resolution (`resolveProjectPath`, `src/vfs/vfs.ts`, `app.js:62`)

- Absolute imports (`/foo`) resolve from the project root; relative imports resolve from the
  importing file's directory (`from.split('/').slice(0,-1)`).
- `.` is dropped; `..` pops one segment and throws `Import escapes project root: <raw>`
  if it would pop past the root.
- Returns the joined path.

### Composition (`composeScenario`, `app.js:64`–`:65`)

- `yaml.parseDocument(source, { customTags: [{tag:'!import'}, {tag:'!mixin'}] })`.
- `!import` resolves to `{ $import: String(value) }`; `!mixin` to `{ $mixin: String(value) }`.
- `resolve(value, from)`:
  - arrays -> resolve each item;
  - primitives -> returned as-is;
  - `{ $import }` -> `load(resolveProjectPath($import, from))`;
  - mixins: `[value.$mixin, value['<<']]` merged in order via `Object.assign` (base must be a
    mapping, else `Mixin must resolve to a mapping: <mixin>`);
  - remaining keys resolved recursively, with `$mixin`/`<<` skipped.
- `load(path)`:
  - throws `Circular import: a → b → a` if `path` is already in `visiting`;
  - throws `Imported file not found: <path>` if `files.vfs[path] === undefined`;
  - pushes/pops `visiting` around resolution.
- Entry point: `load('scenario.yaml')`.

Merge semantics summary: `<<` and `!mixin` perform a **shallow** `Object.assign` of the base
mapping into the result before local keys; local keys override base keys. `!import` substitutes
the imported value at that position (deeply, because `resolve` recurses).

---

## 10. Editor / UI / pack

### File switching and tabs (`switchFile`, `app.js:71`; tabs are a documented enhancement)

- `path === 'assets'` is a no-op.
- Normalizes `files`, flushes the editor into `files.vfs[current]` if that key exists.
- Sets `current = path`, appends `path` to `app.openFiles` when absent, loads
  `files.vfs[path] ?? ''` into `#code`.
- `#format` text is `'LUA'` if `path.endsWith('.lua')`, else `'YAML'`.
- Toggles `.active` on `.file` by `data-file`, then rebuilds the tab bar with
  `renderTabs(app)` (section 15(iv)). The original also toggled `.tab`; because tabs are
  re-rendered, their active state is derived from `current` during the rebuild.
- Recomputes the gutter.

### Open-tab management (enhancement — not in the original export)

- `AppContext.openFiles: string[]` starts as `DEFAULT_OPEN_FILES`
  (`["scenario.yaml", "scripts/main.lua"]`), matching the original's two static tabs, and is
  reset to that set on startup, `newProject` and `importPack`.
- `renderTabs(app)` clears every `.tab` in `app.dom.tabs`, then for each open path creates a
  `<button class="tab[ active]" data-file="path">` containing the `tabLabel(path)` basename
  as text plus a separate `<i data-close="path" title="Close">×</i>`. Each tab is inserted
  before `#format`, keeping the format badge at the far right. DOM APIs are used instead of
  `innerHTML` so VFS path text is never parsed as markup.
- Tab click activates the file; close-glyph click stops propagation and calls `closeFile`.
- `closeFile(app, path)` flushes the current buffer, removes the path from `openFiles`, and:
  - if a non-active tab is closed, only the bar is re-rendered;
  - if the active tab is closed, the nearest remaining tab is activated (right neighbour
    first, else left);
  - if no tabs remain, `#code` and `#format` are emptied, the gutter is reset, and no
    explorer file is active. Nothing is removed from the project VFS, so reopening the file
    restores its content (including unsaved buffer edits).

### Gutter / cursor / scroll

- `lineNumbers()` (`app.js:28`) writes `1..N` into `#gutter` based on `#code` line count.
- `#code.onkeyup` (`app.js:33`) writes `Ln L, Col C` into `#cursor` using
  `selectionStart` and the last `\n` before it.
- `#code.onscroll` (`app.js:41`) syncs `#gutter.scrollTop`.

### Render output HTML contract (`render`, `app.js:23`; `renderUi`, `app.js:247`)

- `#heroTerminal` and `#terminal`: `<div class="entry {kind}"><b>NOW</b><p>{text}</p></div>`
  for each `output` event.
- Choices: `<button class="choice" data-cmd="{cmd}">{text}</button>` in `#heroChoices` and `#choices`.
- `#choiceCount`: `"{n} AVAILABLE"` or empty.
- Titles: `#storyTitle` = location title or scenario meta title; `#title`/`#runTitle` = meta title;
  `#location` = location title.
- `#eventLog`: `<div class="event"><b>{type}</b>{itemId ? <br>{itemName} : ''}</div>`.
- UI: `#surfaceHeader` top flat sidebar buttons; `#gameHud` lower flat meters
  (`<div><span>label</span><b>v / max</b><i><em style="width:pct%"></em></i></div>`);
  `#uiOutput` output buttons/text; canvas surfaces via `runtime.canvasEngine.mountSurfaces`.

### Inventory overlay (`app.js:24`–`:26`)

- `renderInventory`: 12 slots, `#inventoryCount` = `"{n} / 12"`, slots as
  `<button class="slot [occupied]" data-slot="i">` with index label and `◆`/`+`.
- `inspectItem(slot)`: fills `#itemName`, `#itemDescription`, `#itemArt` (`◆`), clears `#itemActions`.
- `openInventory(element, action)`: sets `#inventoryKicker`, `#inventoryTitle`, clears
  `#itemKicker`, removes `hidden` from `#inventoryOverlay`.

### Export / import pack (`app.js:37`–`:39`)

- Export: flushes editor, builds
  `{ format: 'inkforge-pack', version: 1, files, assets: files.assets }`, downloads as
  `adventure.inkforge` (pretty-printed JSON).
- Import: parses JSON, requires `format === 'inkforge-pack'` (else `Invalid pack`),
  replaces the project and its `assets`, loads the new `scenario.yaml` buffer into `#code`,
  saves, then `switchFile("scenario.yaml")` and starts.
- New project: re-fetches the starter, loads its `scenario.yaml` buffer into `#code`,
  saves, switches file, starts.

> The import/new-project flow contains two of the three documented consolidations in
> section 15: the `switchFile("scenario.yaml")` correction and the
> load-buffer-before-switch ordering.

---

## 11. Build & tooling

Deno 2.9.5. esbuild is used via `npm:esbuild` and run through Deno tasks. The smoke
harness uses `playwright-core@1.58.2` driving the system Google Chrome, with a fallback
to the bundled `playwright@1.58.2` Chromium.

### Deno tasks (`deno.json`)

| Task | Purpose |
| --- | --- |
| `check` | Type-check browser code (`src/**`) with DOM libs. |
| `check:tools` | Type-check `tools/**` with Deno libs. |
| `build` | Bundle `src/main.ts` -> `dist/assets/main.js`; copy static assets; concatenate styles. |
| `dev` | Watch + rebuild + serve. |
| `serve` | Serve `dist/` statically. |
| `smoke` | Run Playwright smoke suite against a served build. |
| `fmt` | `deno fmt`. |
| `lint` | `deno lint`. |

### esbuild configuration

- Format: **ESM**; `bundle: true`; `platform: 'browser'`.
- Entry: `src/main.ts`; output: `dist/assets/main.js`.
- Target: modern evergreen browsers (aligned with the source's ES2020+ syntax).
- `sourcemap: true` (dev), disabled or external in production.
- **Dynamic imports preserved**: the `import('https://cdn.jsdelivr.net/...')` calls must
  remain runtime dynamic imports, not be bundled. esbuild treats absolute `https:` specifiers
  as external at runtime; the build must not attempt to resolve them.
- No minification required for correctness; if minification is enabled it must not alter
  observable behavior.

### Static copy

`tools/build.ts`:
- bundles `src/main.ts` -> `dist/assets/main.js` (esbuild),
- copies `index.html` -> `dist/index.html` (script tag points at `assets/main.js`),
- copies the complete `templates/**` tree -> `dist/templates/**` (verbatim), including both
  authored template directories and `.inkforge` pack artifacts,
- concatenates `styles/*.css` -> `dist/style.css` (section 12).

### Dev vs prod serve

- Dev: no-cache headers, rebuild on change, sourcemaps on.
- Prod: serve `dist/` as-is; correct `Content-Type` for `.html`, `.js`, `.css`, `.yaml`,
  `.yml`, `.lua`, `.json`.

---

## 12. CSS organization

The source `style.css` is 18 physical lines of minified CSS with cumulative override layers.
It is split into ordered partials so the cascade order is **byte-for-byte preserved**.

| Partial | Source lines | Bytes (char len) | Notes |
| --- | --- | --- | --- |
| `styles/01-shell.css` | line 1 | 6073 | shell/reset/base tokens |
| `styles/02-play.css` | lines 2–3 | 3003 + 4349 | play view |
| `styles/03-canvas.css` | line 4 | 2012 | canvas panel |
| `styles/04-inventory.css` | line 5 | 2504 | inventory overlay |
| `styles/05-layout.css` | line 6 | 499 | workspace layout |
| `styles/06-overrides.css` | lines 7–18 | 140,24,45,74,106,30,68,26,41,50,76,40 | cumulative overrides |

Concatenation order is exactly `01 -> 02 -> 03 -> 04 -> 05 -> 06` into `dist/style.css`.

### Preservation rules and verification

- Each original physical line is preserved as its own line; partials must be UTF-8 **without BOM**,
  **LF** line endings, with a trailing LF on the final line.
- The original file is 19184 bytes = 19160 content chars + 3 multibyte characters
  (each 3 bytes, at byte offsets 8445, 10082, 15063) + 18 LF terminators. Do not re-encode
  or normalise these characters.
- Verification check (must pass): byte-compare the concatenation of the partials in order
  against `../inkforge-local/style.css`, e.g. compare SHA-256 hashes of the raw bytes.
  A mismatch means the cascade order or encoding changed; fix before proceeding.
- No partial may be reordered, reformatted, or deduplicated.
- `tools/build.ts` strips trailing newlines from each partial and joins them with a single
  `\n` plus one trailing `\n`, reproducing the source bytes exactly. Verified output:
  `dist/style.css` = 19184 bytes, SHA-256
  `AA0375982F7889A1B0AA00E44AE375E56669378BE7B60E47643EF519D9501676`.

---

## 13. Duplicated / dead code inventory

`app.js` contains duplicate hoisted declarations. For function declarations, the **last**
declaration in the scope wins for the whole scope; for assignments (event handlers), the
**last executed assignment** wins. The following table is the authoritative map. Dead
declarations must **not** be ported.

| Symbol | LIVE | DEAD | Mechanism |
| --- | --- | --- | --- |
| `bundledProject` | line 63 (fetches all `TEMPLATE_PATHS`) | line 4 | last function declaration wins |
| `bootLua` | line 258 body, reached via the line 77 wrapper (`const vfsBootLua=bootLua; bootLua=async function(){...}`) | lines 8, 42, 59, 78 | last declaration (258) wins; line 77 reassigns after `const vfsBootLua` captured 258 |
| `start` | line 74 wrapper -> line 70 wrapper -> line 66 base | line 27 | last declaration (66) wins; wrappers assigned at 70 and 74 |
| `initialiseProject` | line 75 | lines 31, 67 | last declaration (75) wins |
| `switchFile` | line 71 (VFS path-based) | line 29 | last declaration (71) wins |
| `renderUi` | line 247 (uses `runtime.canvasEngine.mountSurfaces`) | line 22 | last declaration (247) wins |
| `output` | line 246 (pushes event + sets `runtime.canvasViewDirty`) | line 11 | last declaration (246) wins |
| `#code` oninput handler | line 72 (VFS-aware) | line 32 | later assignment (72) wins |
| `fromLua` | (none) | line 7 | entirely dead; the live bridge uses Lua-side JSON + `JSON.parse` |
| Non-canvas `game={...}` bootstrap string | (none) | `app.js:78`–`app.js:95` (inside dead `bootLua`) | dead body never executes |
| `CANVAS_LUA_API` | `app.js:98`–`app.js:244` | — | the only live Lua bootstrap |

### Timing detail: why the wrappers are installed before the first `start()`

`initialiseProject()` is invoked at `app.js:68` (the live line-75 function). Its body
`await`s `bundledProject()` before it ever calls `start()`. That first `await` suspends
`initialiseProject` and returns control to the top-level script, so lines 69–77 execute
first and install the wrappers:
- line 69 `const composeStart = start` captures the line-66 base,
- line 70 `start = wrapper70`,
- line 73 `const fileStart = start` captures wrapper70,
- line 74 `start = wrapper74`,
- line 76 `const vfsBootLua = bootLua` captures the line-258 body (hoisting already selected it),
- line 77 `bootLua = wrapper77`.

When the fetch resolves and `initialiseProject` resumes, `start()` resolves to wrapper74 and
`bootLua()` resolves to wrapper77 — the intended live pipeline. Without the `await` the base
implementations would run and the VFS layer would be bypassed.

Note: line 78 is a function *declaration*, not an assignment; it is hoisted, not executed in
this window. The assignments that must run before the resumed `start()` are lines 69–77.

### No compatibility wrappers / legacy copies

`inkforge/` must contain **no** `app.js`, `canvas-runtime.js`, or other legacy copies, and
**no** compatibility shims that forward to them. The port is a genuine rewrite into
`src/` + `tools/`. `index.html` loads the bundled `assets/main.js` produced by esbuild.

Port names for the LIVE declarations above: `bundledProject` -> `loadStarterProject`
(`src/project/starter.ts`), `bootLua` -> `bootRuntime` (`src/app/boot.ts`) plus
`createLuaEngine` (`src/lua/bridge.ts`), `start` -> the single consolidated `start`
(`src/app/app.ts`), `initialiseProject` -> `initialise` (`src/app/app.ts`), `switchFile` ->
`src/editor/editor.ts`, `renderUi`/`render` -> `src/ui/render.ts`, and `output` ->
`createOutput` (`src/engine/events.ts`). `fromLua` and the non-canvas `game={...}`
bootstrap were not ported.

---

## 14. Behavior that must remain unchanged

Exhaustive checklist. Any deviation other than the documented deviations in section 15 is a
defect.

### DOM contract

- All ids present in `index.html`: `title`, `saved`, `newBtn`, `importBtn`, `importFile`,
  `exportBtn`, `playView`, `authorView`, `storyTitle`, `heroTerminal`, `uiOutput`, `decision`,
  `choiceCount`, `heroChoices`, `heroCommand`, `heroInput`, `surfaceHeader`, `gameSurface`,
  `gameHud`, `restartHero`, `inventoryOverlay`, `inventoryKicker`, `inventoryTitle`,
  `closeInventory`, `inventoryCount`, `inventorySlots`, `itemArt`, `itemKicker`, `itemName`,
  `itemDescription`, `itemActions`, `addFile`, `assetCount`, `format`, `gutter`, `code`,
  `cursor`, `diagnostics`, `runTitle`, `restart`, `run`, `location`, `terminal`, `choices`,
  `commandForm`, `command`, `clearEvents`, `eventLog`, `luaStatus`.
- All classes: `app`, `brand`, `mark`, `nav`, `project-title`, `actions`, `gold`, `play-view`,
  `rail`, `story-stage`, `scene-head`, `hero-terminal`, `ui-output`, `decision`, `hero-choices`,
  `canvas-panel`, `surface-head`, `canvas-stage`, `player-strip`, `side-action`,
  `inventory-overlay`, `inventory-window`, `inventory-body`, `inventory-label`,
  `inventory-slots`, `item-inspector`, `item-art`, `eyebrow`, `item-actions`, `workspace`,
  `explorer`, `pane-head`, `tree`, `folder`, `file`, `editor`, `tabs`, `tab`, `format`,
  `editor-wrap`, `runtime`, `runtime-head`, `run`, `status`, `dot`, `terminal`, `choices`,
  `events`, `event-head`, `event`, `hidden`.
- Runtime-generated classes: `choice`, `entry`, `event`, `slot`, `occupied`, `ui-text`,
  `game-canvas`.
- `data-file`, `data-view`, `data-cmd`, `data-ui`, `data-slot`, `data-scene` attributes and
  their exact values.

### Visual

- CSS output is byte-for-byte the source cascade (section 12).

### Content

- Starter project content under `templates/lantern-below/**` unchanged (scenario, state, player,
  ui, definitions, instances, locations, manifest, `scripts/main.lua`, `scripts/threshold.lua`).

### Engine semantics

- `check`: `and`/`or`/`not`/`hasItem`/`var` with `eq`/`ne`/`neq`/`gt`/`gte`/`lt`/`lte`;
  absent condition is true.
- `execute`: string output, `{text}`, `{set}`, `{inc}/{dec}` (`var`/`by` semantics), `{give}`,
  `{remove}`, `{goto}`, `{ui}`, `{if}/{then}/{else}`, `{end}`.
- `move`: unknown location -> `output(..., 'error')`; else set location, clear conversation,
  push `location:enter`, execute text.
- `dispatch`: look/l, exits (direct + aliases), `take `, `@action`, unknown warning; clears
  `runtime.events` at start; returns via `render()`.
- `available`: exits (capitalised first letter), actions (`label||id`, cmd `@id`), items
  (`Take <name>`, cmd `take <id>`), all gated by `check`.
- UI override resolution: `uiElement` merges element + override + computed `values`;
  `uiFields` supports array and object `override.fields`; `resolveField` supports
  `type:'state'` and `value`.

### Render HTML

- Exact markup contracts in section 10 (entries, choices, meters, events, slots, titles).

### Lua API

- `game.output`, `game.state.get/set`, `game.ui.create/set/show/hide/remove`,
  `game.canvas.create/node`, `game.timer.after/every`, node/scene/animation/timer handles,
  `require` of mounted `*.lua`, and the `__canvas_event`/`__timer_event` signatures.

### Canvas

- Math (matrices, hit tests), animation timing/easing/yoyo/repeat, timer semantics,
  draw order, DPR cap, `mountSurfaces` DOM shape, ensure/remove surface hooks.
- The right panel is separate flat top UI, one physical viewport canvas, and separate flat
  lower UI/actions. The viewport is not the whole panel and no camera abstraction exists.
- `CanvasViewport.projection` supports `flat` (default), `isometric`, and `oblique`.
- `CanvasScene.layers` supports explicit layer order and optional projection-depth sorting;
  nodes may select `layer`, `space`, `z`/`elevation`, and explicit `depth`.
- Projected world roots and unprojected screen-space roots share the existing node, animation,
  and inverse-matrix hit-testing pipeline.
- The internal `templates/renderer-showcase/` fixture exercises this contract as four independent
  Lua-created surfaces: flat ordered layers, isometric depth/elevation, oblique pseudo-3D, and a
  mixed projected-world/VN-style screen overlay. Its output buttons use `game.ui.hide/show` to
  switch surfaces; the packed `.inkforge` artifact is the importable form of the same VFS. This is
  an architecture verification fixture, not a stable user-facing renderer manual.
- Switching among those preview surfaces changes only the viewport canvas. Header controls,
  lower meters, and restart/actions remain flat screen-space UI and are not projected.

### Persistence & pack

- localStorage key `inkforge-project-v1`; legacy shape compatibility (bare
  `{scenario, script, assets}` upgraded by `normalizeProject`).
- Export pack exactly `{ format: 'inkforge-pack', version: 1, files, assets }`, downloaded
  as `adventure.inkforge`; import rejects `format !== 'inkforge-pack'` with `Invalid pack`.

### Remote dependencies

- `https://cdn.jsdelivr.net/npm/yaml@2.6.0/+esm`
- `https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm`

### Editor

- Gutter line numbers, `Ln L, Col C` cursor readout, gutter scroll sync, `YAML`/`LUA` format label.
- Dynamic tabs (section 15(iv)): the open-tab list starts as `["scenario.yaml",
  "scripts/main.lua"]`; opening an explorer file appends/activates a tab; a tab click
  activates its file; a tab's `×` closes it and switches to the nearest remaining tab, or
  clears the editor when none remain, without deleting VFS data. Tab labels are basenames
  (`scripts/main.lua` -> `main.lua`). The `assets` explorer row remains a no-op.

### Controls

- Restart (`#restart`, `#restartHero`) and Run (`#run`) call `start` (Run also shows play view);
  `#clearEvents` clears events and renders; `showView` toggles play/author and `.nav` active
  state, and redraws the DOM/canvas surfaces when Play becomes visible so a canvas mounted while
  Author was visible receives non-zero layout bounds before interaction.

---

## 15. Documented deviations (intentional)

> **STRONGLY FLAGGED.** There are exactly **four** intentional behavior changes in the
> port: three consolidations, all consequences of removing the duplicate wrappers in the
> original `app.js` (section 13) and of the "no compatibility wrappers / no duplicate
> implementations" constraint (all three required for the import/export flow to work), plus
> one **explicit, user-requested enhancement** — dynamic editor tabs. No other behavior may
> change.

The original `app.js` declared `start` three times — a base at line 66 and wrappers at
lines 70 and 74 — and its import/new-project call sites called `switchFile('scenario')`
against a path-based `switchFile`. Removing the duplicate wrappers and keeping a single
implementation forces the three changes below.

### (i) `switchFile("scenario.yaml")` instead of `switchFile("scenario")`

`app.js:38` (`#importFile.onchange`) and `app.js:39` (`#newBtn`) called:

```js
switchFile('scenario');
```

but the live `switchFile` (`app.js:71`) is **path-based**: it does
`$('#code').value = files.vfs[path] ?? ''`, and the VFS has no key `'scenario'` (the key
is `'scenario.yaml'`). The editor was blanked, and the subsequent `start()` pipeline wrote
that empty value back into `files.vfs['scenario.yaml']`, blanking the scenario. The
result: **"New project" and "Import pack" produced an empty project.**

The port calls `switchFile("scenario.yaml")` at both sites — `src/import-export/pack.ts`
(`importPack`) and `src/app/app.ts` (`newProject`).

### (ii) One consolidated `start()` that syncs only the current editor file

The original chain was:

- base (`app.js:66`): set `vfs['scenario.yaml'] = files.scenario` and
  `vfs['scripts/main.lua'] = files.script`, then compose and boot;
- wrapper70 (`app.js:70`): additionally set
  `vfs[current === 'script' ? 'scripts/main.lua' : 'scenario.yaml'] = editor.value`,
  **unconditionally overwriting `scenario.yaml` with the editor buffer** whenever the
  current file was not `scripts/main.lua`;
- wrapper74 (`app.js:74`): flush `vfs[current]` from the editor, re-derive
  `files.scenario` / `files.script`, and call wrapper70.

The port has a single `start()` (`src/app/app.ts`) that normalizes the project, syncs
**only** `vfs[current]` from the editor buffer (when that key exists), and then derives
`vfs['scenario.yaml']` / `vfs['scripts/main.lua']` from the VFS. The old wrapper's
unconditional overwrite is gone, so opening a non-scenario file (for example `state.yml`
or `main.lua`) and restarting no longer corrupts `scenario.yaml`.

### (iii) Load the new buffer before `switchFile` when replacing the project

When the whole project is replaced (`importPack`, `newProject`), the port sets
`current = "scenario.yaml"` and loads `project.vfs["scenario.yaml"]` into `#code`
**before** calling `switchFile("scenario.yaml")`. `switchFile` flushes the current editor
buffer into `vfs[current]`; because the new buffer is already in the editor and `current`
already points at `scenario.yaml`, that flush writes the freshly loaded scenario (not
stale text) back into the VFS. This ordering is required for the import / new-project
round trip to preserve the loaded scenario.

### (iv) Dynamic editor tabs — user-requested enhancement (not a consolidation)

The original `index.html` hard-codes a static `.tabs` bar with exactly two tabs
(`scenario.yaml`, `scripts/main.lua`), each carrying a decorative `<i>×</i>`, and
`app.js:32` binds `.file`/`.tab` clicks only to `switchFile`. Consequently the `×` does
nothing and opening any other file (`instances.yml`, `state.yml`, …) never adds a tab. The
user reported this as broken and explicitly asked for it to be fixed; the port reproduces
the original faithfully but then replaces the static markup at runtime.

- `AppContext.openFiles: string[]` is the editor's open-tab list, initialized to
  `DEFAULT_OPEN_FILES` (`["scenario.yaml", "scripts/main.lua"]`) on startup, new project and
  import (`src/editor/editor.ts`).
- `renderTabs(app)` rebuilds the bar from `openFiles`, inserting each tab before `#format`
  so the format badge stays at the far right. Labels are basenames via `tabLabel`
  (`scripts/main.lua` renders as `main.lua`, matching the original). Labels use
  `textContent` and the close glyph is a separate `<i data-close>`; untrusted path text
  never goes through `innerHTML`.
- `switchFile` appends the path to `openFiles` when absent and calls `renderTabs`; `.file`
  elements still get `.active` toggled (the old `.tab` toggling is dropped because tabs are
  re-rendered).
- `closeFile(app, path)` removes the tab without deleting anything from the VFS: it flushes
  the current buffer, closes a non-active tab silently, activates the nearest remaining tab
  (right neighbour first, else left) when the active tab closes, and clears `#code`,
  `#format`, the gutter and the explorer active state when the last tab closes. Reopening
  the file restores its content, including unsaved buffer edits.
- `src/app/events.ts` binds only `.file` clicks; tabs are bound by `renderTabs`. The
  `assets` explorer row remains a no-op.

No CSS changed. The existing `.tab i{font-style:normal;color:#777;margin-left:10px}` is
already clickable (no `pointer-events:none`, non-zero size), so `dist/style.css` remains
byte-for-byte identical to `../inkforge-local/style.css` (SHA-256
`AA0375982F7889A1B0AA00E44AE375E56669378BE7B60E47643EF519D9501676`, 19184 bytes).

### Rationale

- The "no compatibility wrappers / no duplicate implementations" constraint forbids
  porting the `start` wrapper chain, so its behavior must be reproduced by one function.
- The "test import/export" requirement (Plan test matrix, tests 6 and 7) exercises the
  import and new-project flows end to end; without (i)–(iii) those flows produce or
  corrupt an empty project.
- Deviation (iv) is not a consolidation: it is a deliberate, user-requested usability fix
  for the original's dead `×` and non-appending tabs. It preserves the original `.tabs`/
  `.tab`/`.tab i` styling and basename labels and changes no CSS.
- Each change is minimal and localized to the affected functions.

### Explicitly unchanged

- **Export format and flow are unchanged**: `{ format: 'inkforge-pack', version: 1, files,
  assets }`, `adventure.inkforge`, pretty-printed JSON (`app.js:37`).
- Import validation (`format !== 'inkforge-pack'` -> `Invalid pack`) is unchanged.
- No other call site is modified.

---

## 16. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **CDN network dependency** (`yaml@2.6.0`, `wasmoon@1.16.0` from jsDelivr) | App fails offline; smoke tests flaky. | Keep exact pinned URLs; smoke tests may pre-warm the cache or run with network; optionally vendor later without changing the API. Document the dependency. |
| **esbuild handling of dynamic imports** | A build could try to resolve/bundle the CDN imports and fail or change semantics. | Mark `https:` specifiers external / preserve dynamic `import()`; verify the built bundle still contains runtime `import('https://cdn.jsdelivr.net/...')`. |
| **Deno lib vs DOM typing** | `src/**` needs DOM types; `tools/**` needs Deno types; mixing causes type errors or Deno APIs leaking into browser code. | Separate `compilerOptions` via tasks `check` (DOM libs) and `check:tools` (Deno libs); add a lint/grep gate that `src/**` contains no `Deno.`/`npm:`/`jsr:`. |
| **Path contains literal `[` `]`** (`E:\[GAMEDEV]\Projects`) | Shell globbing and tools that treat `[` as a wildcard misbehave. | Always use `-LiteralPath` in PowerShell and quote paths; prefer relative paths from the working directory; avoid passing the bracket path through glob-expanding tools. |
| **CSS byte-drift** | Cascade order changes; visual regressions. | Byte-for-byte hash verification of the concatenated partials vs source (section 12). |
| **Dead code accidentally ported** | Two `bootLua`/`start`/etc. implementations could resurface, causing the old non-VFS behavior. | Follow section 13 strictly; port only LIVE declarations. |
| **Lua `CANVAS_LUA_API` escaping** | `String.raw` escaping is easy to corrupt, breaking Lua boot. | Copy the chunk verbatim from `app.js:98`–`app.js:244`; add a smoke assertion that the canvas scene and Lua callbacks work. |
| **Wasmoon `mountFile`/`require` path mismatch** | `require("scripts/threshold")` fails. | Mount every `*.lua` from the VFS with its full path before `createEngine`; smoke-test the require. |

---

## 17. Final status

The original port is **complete and verified**. The target tree in this repository (`src/`,
`tools/`, `deno.json`, `index.html`, `styles/`, `templates/`) is the source of truth for
further work. `../inkforge-local/` remains a read-only behavioral reference and a runnable
fallback (`py -m http.server 4173`) and must not be modified.

The renderer stage expansion is active. The first foundation slice and the viewport-boundary
correction are implemented and verified on 2026-09-23 (Windows, Deno 2.9.5):
`deno task check:renderer`, `deno task check`, focused renderer lint/format, `deno task build`,
and `deno task smoke` pass. The smoke harness passes **14/14** assertions and reports 0 console
errors, 0 page errors and 0 dialogs. The projection check covers flat identity, isometric and
oblique round trips, affine basis transforms, stable layer order, projected inverse hit-testing,
inverse-projected pointer payloads, and a Lua-authored projected scene with mixed world/screen
layers. The browser smoke checks also prove logical viewport clipping, offscreen input rejection,
and responsive canvas bounds between the flat top and lower UI regions. The internal renderer
showcase pack is import-verified: its four output controls switch only the mounted viewport
surface, and its mixed-scene marker reports inverse-projected world coordinates.

The four documented deviations (section 15) are the only intentional behavioral differences
from `../inkforge-local/`: the three import/new-project consolidations plus the
user-requested dynamic editor tabs (open / activate / close). The later renderer-stage
expansion is tracked separately from that baseline comparison; its viewport-boundary
correction intentionally changes the stage CSS and runtime fitting/clipping behavior.

Contributor commands (run from `inkforge/`):

```
deno task check          # type-check the browser app (src/main.ts)
deno task check:tools    # type-check tools/**
deno lint                # lint
deno fmt --check         # format check (preserved assets and docs excluded)
deno task build          # build dist/ (index.html, assets/main.js, style.css, templates/)
deno task check:renderer # projection/layer math and hit-test checks
deno task serve          # serve an existing dist/ on http://localhost:4173/
deno task dev            # build + watch + serve
deno task smoke          # build + serve + drive Chrome, assert the seven checks
```

`dist/` is generated and safe to delete and rebuild at any time.
