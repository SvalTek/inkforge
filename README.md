# Inkforge Adventure Studio

Inkforge is a browser-based authoring and play environment for YAML and Lua text adventures. You can write a scenario in
the built-in editor, run it in a playtest pane, and export or import complete `.inkforge` project packs. A retained
canvas layer renders scenes, HUD meters and interactive nodes on top of the text experience.

The application is a pure client-side single-page app. There is no server-side runtime: production output is a set of
plain static assets that can be hosted on any static host.

## Prerequisites

- Deno 2.x or newer (developed against Deno 2.9.5). Node.js is not required to run the tasks; `npm:esbuild` is fetched
  and executed through Deno.
- A local Google Chrome installation for `deno task smoke`, which drives it through `playwright-core`; the bundled
  Playwright Chromium is used as a fallback.

## Commands

Run these from the repository root:

- `deno task check` - type-check the browser application entry (`src/main.ts`).
- `deno task check:tools` - type-check the build and serving tools.
- `deno task build` - produce a production build in `dist/` (bundled, minified, plus static assets and concatenated
  styles).
- `deno task pack -- <project-folder>` - package a manifest-backed project folder as a sibling `.inkforge` file.
  Use `--out <file.inkforge>` to choose the output path. The folder must contain `manifest.json`,
  `scenario.yaml`, and `scripts/main.lua`; manifest paths are packaged as UTF-8 VFS files.
- `deno task dev` - run a full build, serve `dist/` on `http://localhost:4173/`, and rebuild automatically when `src/`,
  `styles/`, `templates/` or `index.html` change. Pass `--port <n>` to change the port.
- `deno task serve` - serve an existing `dist/` build on `http://localhost:4173/` without rebuilding. Pass `--port <n>`
  to change the port.
- `deno task smoke` - build, serve, and drive headless Chrome through the smoke checks (`tools/smoke.ts`).
- `deno task fmt` / `deno task lint` - format and lint the Deno sources.

## Deployment

`deno task build` writes a self-contained static site to `dist/`:

- `dist/index.html` - the application shell
- `dist/assets/main.js` - the bundled ES module entry
- `dist/style.css` - the concatenated style partials
- `dist/templates/` - the bundled starter projects

Host the contents of `dist/` on any static file host (or serve it locally with `deno task serve`). No build step or
server runtime is needed on the host.

## Runtime dependencies

The YAML parser (`yaml@2.6.0`) and the Lua runtime (`wasmoon@1.16.0`) are still loaded from jsDelivr at runtime through
dynamic `import()` of remote CDN URLs. A network connection is therefore required when the app runs in the browser.
These remote imports are intentionally not bundled.

## Project layout

- `index.html` - application shell
- `src/` - application source (bundled by esbuild)
- `styles/` - ordered CSS partials, concatenated into `dist/style.css`
- `templates/lantern-below/` - the starter project, copied verbatim into the build
- `templates/*/manifest.json` - required project file lists used by the packer
- `tools/` - Deno build, dev/preview/static servers, shared paths and the Playwright smoke harness
- `deno.json` - task definitions and TypeScript configuration
- `dist/` - generated production output (not committed)
