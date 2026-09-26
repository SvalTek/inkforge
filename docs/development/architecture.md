# Architecture

## Shape of the thing

A browser-only single-page app. `src/main.ts` is the only entry point; esbuild bundles it into one ES module that the
shell in `index.html` loads. At runtime the app fetches its starter templates, composes a scenario from the project's
YAML, boots a Lua runtime, and paints a play view and an author view over the same state.

Two views, one runtime:

- **Play** — the transcript, the choice list, a command line, an inventory overlay, the tool rail, and a canvas panel.
- **Author** — a file explorer, a tabbed editor, and a live playtest pane that can be restarted from the current buffer.

## Module map

| Area | Files | Responsibility |
|---|---|---|
| Shell | `src/main.ts`, `src/app/app.ts`, `src/app/context.ts`, `src/app/dom.ts`, `src/app/events.ts` | App context, DOM references, event wiring, the `start()` pipeline |
| Boot | `src/app/boot.ts` | Composes the runtime: canvas host, Lua engine, boot-time name validation |
| Engine | `src/engine/engine.ts`, `directives.ts`, `conditions.ts`, `state.ts`, `events.ts`, `ui-state.ts`, `tool-state.ts` | Command dispatch, directive execution, conditions, the mutation funnels |
| YAML | `src/yaml/compose.ts`, `loader.ts`, `validate.ts` | `!import`/`!mixin` composition, static validation, Lua-name collection |
| Lua | `src/lua/bridge.ts`, `bindings.ts`, `lua-api.ts`, `facades/*.ts`, `invoke.ts`, `boundary.ts` | Bridge construction, host namespaces, the Lua-side canvas API, the seam |
| Canvas | `src/canvas/runtime.ts`, `projection.ts`, `math.ts`, `easings.ts` | Scene/node model, hit-testing, drawing, animations, the frame loop |
| UI | `src/ui/render.ts`, `actions.ts`, `modals.ts`, `tools.ts` | DOM painting, activation handling, modals, the tool rail |
| Project | `src/project/project.ts`, `storage.ts`, `save-storage.ts`, `db.ts`, `assets.ts`, `starter.ts` | Project and run-save records in IndexedDB, asset resolution, the starter |
| Pack | `src/import-export/pack.ts` | `.inkforge` export and import, version precedence |
| Editor | `src/editor/editor.ts`, `tree.ts`, `codemirror.ts` | Nested file tree, creation and guarded deletion, tabs, buffer sync and language-aware editing |
| Support | `src/vfs/vfs.ts`, `src/audio/manager.ts`, `src/deps/remote.ts`, `src/types/*` | Path resolution, audio, the remote YAML import, shared types |

`src/types/` is the type model, split by concern (`scenario`, `ui`, `tools`, `canvas`, `engine`, `project`, …) and
re-exported through `src/types/index.ts`. Types that describe authored YAML are the closest thing to a schema — start
there when you need to know what an author can write.

## Boot and start

`app.start()` is the pipeline that turns a project into a running scenario:

1. Compose the scenario from the VFS (`composeScenario`) — this is where `!import` is followed.
2. Validate it statically (`validateScenario`) — unknown condition and directive keys.
3. Build the runtime: state from authored defaults or a requested save snapshot, inventory, tools, UI elements, and modal
   state. A resume is an explicit choice; a normal start begins a fresh run.
4. `bootRuntime()` — construct the canvas host, then the Lua engine, then cross-check every authored Lua reference
   against the loaded script.
5. Enter the start location and render.
6. On a resume only, re-apply the snapshot over the boot: the entry script and the saved location's own directives have
   just run, and everything the save recorded — state, inventory, transcript, tools, UI, modals — has to win over them.
   A location that grants an item on entry would otherwise hand it back every time.

`start()` is async and is called fire-and-forget from several DOM handlers as well as the initial load, so boots are
**serialised and generation-stamped**: calls are chained so two boots never interleave on shared state, and a superseded
boot stops at its next await without committing results or announcing itself ready. The readiness flag is
`document.body.dataset.projectReady`, which the browser checks wait on — so a boot that lost the race must not set it.

## Command dispatch

A command is a string. `dispatch` trims and lowercases it, clears the event list, then tests in order:

| Input | Effect |
|---|---|
| `look`, `l` | Run the current location's `text` |
| a direction | Move, if an exit matches and its condition passes; otherwise `That way is not available.` |
| `take <id or name>` | Move a location item into the inventory |
| `@<actionId>` | Run a location action's `then` |
| anything else | `Unknown command: <cmd>` |

Dispatch is wrapped so that the view is flushed **once** per command, whatever the command changed.

## The invariants

These four hold the design together. Changing code around them is fine; breaking them is not.

### 1. Mutations go through a funnel, and the funnel marks the view dirty

Every change to runtime state has exactly one entry point:

| Change | Funnel |
|---|---|
| Output a line | `createOutput` (`engine/events.ts`) |
| State / inventory / location | `setState`, `adjustState`, `addItem`, `removeItem`, `setLocation` (`engine/state.ts`) |
| UI elements | `applyUi` (`engine/ui-state.ts`) |
| Tools | `registerTool` and friends, plus the `GameTools` bindings |

Each funnel calls `markViewDirty`. Call sites therefore never mark anything themselves, which is what makes a change
from *any* source repaint: a YAML directive, a Lua timer, a pointer event on a canvas node.

### 2. One gate decides when to repaint

`markViewDirty` sets `runtime.viewDirty` and asks the canvas engine for a frame. `flushView` is the only thing that
reads and clears it, and it renders only when the flag is set.

This exists because the frame loop runs every animation frame, and rebuilding the whole DOM at 60fps is pure waste. The
consequence to preserve: **a command that changes five things repaints once, and a static scene repaints not at all.**

### 3. Frames come from the bridge; rAF is for animation only

The Lua bridge owns the main loop at a fixed interval and calls `Update(dt)`. `requestAnimationFrame` is reserved for
animation and render work, scheduled on demand and stopped when nothing is animating. Do not move main-loop or timer
duties onto rAF.

### 4. YAML reaches Lua by name, never by source

Authored content names a function (`call:`) or an event (`emit:`). It never contains a Lua string to evaluate. The seam
is `src/lua/invoke.ts`, and every name is checked — `call:` targets at boot, `emit:` targets on first emit, because
`Events:On` cannot be enumerated.

## Canvas

`InkforgeCanvasRuntime` owns scenes, nodes, animations and the frame loop. It is driven from two directions: Lua through
a small set of commands (`scene.create`, `node.add`, `node.set`, `animation.*`, …), and the DOM through pointer events.

Node event callbacks stay in Lua. Only a marker for "this event is bound" crosses the bridge, because the host needs to
know which events to dispatch; the callback itself never leaves the Lua side. The host emits `canvas:event`, and a Lua
router resolves it to the per-node closure.

`mountSurfaces` reconciles by `type:id` rather than clearing the host, so a canvas element keeps its backing store,
pointer capture and listeners across a repaint.

## Persistence

Projects and their separate run saves live in IndexedDB. The editor buffer is synced into the project VFS and persisted
on a debounce, so edits survive a reload. Project transitions and exporting flush pending edits first. The bundled
starter is pinned against deletion; a newer pack with the same project ID can update it while retaining that pin. A save
is written and resumed only on explicit player actions, and deleting a project also deletes its saves.

The explorer derives folders from VFS paths. Empty folders use a hidden marker that is omitted from packs. The editor
protects `scenario.yaml`, the Lua entry file selected by `scenario.scripts.main` (default `scripts/main.lua`), and its
containing folders from deletion. Pack import, export, and the disk packer require that selected entry in the file set,
and resolve it from the composed scenario, so a pack whose YAML does not compose is left to report at boot.

Project sources and saves remain in browser storage unless explicitly exported. The YAML parser is loaded as a remote ES
module (see `src/deps/remote.ts`) — the Lua runtime's WASM is inlined into the bundle at build time instead.

## Adding things

- **A directive or condition key** — add it to the type and to `execute`/`check`, then to `DIRECTIVE_KEYS`
  (`src/engine/directives.ts`) or `CONDITION_KEYS` (`src/yaml/validate.ts`). Those validation lists are what make a typo
  loud: a key that is implemented but not listed is reported as unrecognised. Note that `execute` tests keys in a fixed
  order and takes the first match, so a new key's position in the chain is a behavioural decision — see
  [Conventions](conventions.md#recipes).
- **A Lua namespace** — add a `LuaClass` in `src/lua/bindings.ts` and return it from `createHostNamespaces`. It is
  installed by the bridge automatically; there is no registration step.
- **A canvas op** — add it to `CanvasCommand` in `src/types/canvas.ts`, handle it in the runtime, and call it from the
  Lua handle in `src/lua/facades/canvas.ts` if authors need to reach it.
- **A UI element type** — it must be rendered in `src/ui/render.ts` for its region *and* in `src/ui/modals.ts` if it can
  appear in a modal. The two renderers are separate; an element type that is only handled in one will silently vanish in
  the other.
