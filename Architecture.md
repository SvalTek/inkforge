# Architecture

Inkforge is a client-side browser application. `index.html` provides the shell, `src/main.ts` creates one app context, and the Play and Author views share the same project and runtime. Deno is used to build, serve, package, and check the app; it is not part of the deployed runtime.

## The main boundaries

| Area | Responsibility |
|---|---|
| [`src/app/`](src/app/) | Owns the active project, start and restart lifecycle, DOM bindings, and the connection between the editor and play views. |
| [`src/project/`](src/project/) | Normalizes projects, loads the bundled starter, stores projects and run saves in IndexedDB, and resolves media assets. |
| [`src/editor/`](src/editor/) | Renders the nested file tree and tabs, keeps the current CodeMirror buffer in sync with the project, and handles file creation and deletion. |
| [`src/yaml/`](src/yaml/) and [`src/vfs/`](src/vfs/) | Resolve project paths, compose `!import` and `!mixin` documents, and validate the resulting scenario. |
| [`src/engine/`](src/engine/) | Dispatches commands, checks conditions, applies directives, tracks state and inventory, and creates or restores run snapshots. |
| [`src/lua/`](src/lua/) | Boots Wasmoon, exposes the host APIs, and invokes Lua functions named by authored YAML. |
| [`src/ui/`](src/ui/), [`src/canvas/`](src/canvas/), [`src/audio/`](src/audio/) | Render the text and authored UI, draw and hit-test interactive scenes, and play project audio. |
| [`src/import-export/`](src/import-export/) | Imports and exports `.inkforge` project packs. |
| [`tools/`](tools/) and [`styles/`](styles/) | Build and check scripts, plus ordered CSS partials assembled into the static site. |

The authored format is described in [Project format](docs/authoring/project-format.md). For implementation detail and change conventions, use the [development architecture guide](docs/development/architecture.md).

## Projects, files, and saves

A project has an identity, a virtual file system (VFS) of text files, and binary assets. `scenario.yaml` is the composition entry point; its `scripts.main` field names the Lua entry file, defaulting to `scripts/main.lua`. Other YAML and Lua files can be added under folders. The explorer derives folders from VFS paths and records empty folders with a hidden marker; markers are omitted from exported packs. The scenario file, configured Lua entry file, and folders containing either cannot be deleted in the editor. Pack import, export, and the disk packer also require the configured entry file, checked once the scenario composes far enough to name it.

Projects are independent records in IndexedDB. The bundled starter is seeded as a pinned project, and **Scenarios** can make a separate copy or load another stored project. Editor changes are saved locally on a debounce; project transitions and pack export flush pending edits first. An `.inkforge` file is a ZIP pack of the project's source and assets, with a generated manifest. Import validates the pack and compares project versions before replacing a stored project with the same ID.

A saved playthrough is a separate snapshot associated with its project. **Save** writes it deliberately; opening or restarting a scenario starts fresh until the player chooses **Resume** in **Manage Saves**. Saves can be exported and imported as JSON. Removing a project also removes its saves.

## Starting and running a scenario

`createApp()` in [`src/app/app.ts`](src/app/app.ts) owns the active context. Startup loads a stored project or seeds the bundled starter, then `start()` builds a new runtime. Start requests are serialized so overlapping restarts cannot commit competing Lua, canvas, or render state.

The start path is:

1. Sync the active editor buffer into the project VFS.
2. Compose `scenario.yaml` and its imports, then validate the authored data and start location.
3. Create runtime state, inventory, UI, and tools. A requested resume seeds these from its snapshot. NPC instance
   defaults declared in `npcs.<id>.state` are flattened into the state layer first, so an authored `state`, a
   `player.state`, and a resumed save each apply over them in that order.
4. Build the canvas and Lua bridge, load the entry script, and check named Lua callbacks.
5. Enter the location and render the Play and Author surfaces from the shared runtime.

The engine accepts commands and authored actions through [`src/engine/engine.ts`](src/engine/engine.ts). A conversation is the second contextual authoring feature after inventory actions: [`src/engine/conversation.ts`](src/engine/conversation.ts) holds its node-and-option state machine and takes `DirectiveDeps`, so the `talk:` directive reaches it from the ordinary directive chain and a Lua entry point can be added later without reshaping the engine. While one is running it owns the choice list and the command box, and it is stored as a position rather than a transcript, so spoken lines are capped, saved and rendered by the same machinery as any other prose. State changes, output, tools, and UI changes mark the view dirty; the render gate repaints when those changes need to become visible. Lua timers and canvas events use the same runtime state, so they can update the view without a typed command. Authored YAML calls Lua by function or event name through [`src/lua/invoke.ts`](src/lua/invoke.ts); it does not embed Lua source for evaluation.

The canvas runtime keeps its own scenes, hit testing, animation, and pointer routing. The DOM renderer owns text, controls, inventory, inventory item actions, and authored modals. Item actions are serialized while an invocation is pending and run their authored directive lists through the engine with transient context identifying the invoking instance, definition, and action. Lua can resolve that instance through the read-only `GameItems` namespace, which returns detached copies of authored definition data. NPCs follow the same shape with `GameNPCs`, but their state is read with `npcVar`/`npcSet` against a named instance rather than through execution context, so the same key works from any authored site. The two surfaces share scenario state but have different render paths.

## Browser and build boundary

[`tools/build.ts`](tools/build.ts) bundles `src/main.ts`, inlines Wasmoon's WASM, copies `index.html` and the bundled templates, and concatenates `styles/*.css` in filename order. The output in `dist/` is static and can be hosted without Deno or a backend. At runtime the YAML parser is imported from a pinned jsDelivr URL in [`src/deps/remote.ts`](src/deps/remote.ts), so that parser requires network access unless it is already cached.

Build commands and checks live in [Build and test](docs/development/build-and-test.md). Author-facing behavior lives in the [authoring guides](docs/authoring/README.md); this page describes the current code boundaries, not a historical port plan.
