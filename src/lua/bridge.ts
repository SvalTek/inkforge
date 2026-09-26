import type LuaBridge from "WebLuaBridge";
import { createLuaBridge, globalBindings, jsonBindings, regexBindings, timersBindings } from "WebLuaBridge";
import { INKFORGE_LUA_API } from "./lua-api.ts";
import { createHostNamespaces } from "./bindings.ts";
import type { CanvasCommand, CanvasHost } from "../types/canvas.ts";
import type { ApplyUiFn, EngineRuntime, OutputFn } from "../types/engine.ts";
import type { Vfs } from "../types/vfs.ts";
import type { AudioManagerLike } from "../types/audio.ts";

/** Tick interval for the bridge's main loop, in milliseconds. */
const MAIN_LOOP_INTERVAL_MS = 16;

/**
 * Injected by `tools/build.ts` through esbuild's `define`: a base64 data URI
 * for the Lua runtime's WASM binary, so the bundle needs no external file.
 */
declare const __INKFORGE_WASM_URI__: string;

/** Injected dependencies for {@link createLuaEngine}. */
export interface LuaEngineOptions {
  runtime: EngineRuntime;
  vfs: Vfs;
  scriptPath: string;
  canvasHost: CanvasHost;
  applyUi: ApplyUiFn;
  output: OutputFn;
  audio: AudioManagerLike;
  /** Report a Lua failure that is not a thrown boot error (e.g. a tick error). */
  onError: (message: string) => void;
}

/**
 * Boot the Lua runtime for a scenario script via WebLuaBridge.
 *
 * Boot order:
 * 1. create the bridge, which installs the host namespaces (`GameOutput`,
 *    `GameState`, `GameUI`, `GameTools`, `GameAudio`), the bridge's `timers`
 *    binding, and every project `.lua` file, before anything executes
 * 2. run the Lua-side API (`GameCanvas` and the canvas event router)
 * 3. run the scenario entry file, which defines `OnInit`/`Update`/`OnShutdown`
 * 4. `start()`, which runs a root `init.lua` if present, calls `OnInit()`, and
 *    begins the fixed-rate loop that calls `Update(dt)` with seconds
 *
 * Mutation contract: this function does NOT mutate any `runtime.*` field except
 * through the host namespaces it installs. The caller is responsible for
 * assigning `runtime.lua`.
 *
 * A script path that is absent from `vfs` throws `Script not found: <path>`
 * before any work.
 */
export async function createLuaEngine(options: LuaEngineOptions): Promise<LuaBridge> {
  const { runtime, vfs, scriptPath, canvasHost, applyUi, output, audio, onError } = options;

  if (vfs[scriptPath] === undefined) throw new Error(`Script not found: ${scriptPath}`);

  // Every Lua file in the project is pre-mounted, so `require` resolves across
  // files (the starter template depends on it). The `files` option mounts them
  // before any execution, which is earlier than a post-create loop would be.
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(vfs)) {
    if (path.endsWith(".lua")) files[path] = content;
  }

  // `injectObjects`/`enableProxy` are the bridge defaults; stated explicitly so
  // the dependency on direct object bridging is visible where it matters.
  const bridge = await createLuaBridge({
    ...createHostNamespaces({ runtime, applyUi, output, audio }),
    // Internal transport for the Lua-side `GameCanvas` handles. Double
    // underscore marks it as plumbing rather than authored API.
    __canvas_command: (payload: unknown) => canvasHost.command(payload as CanvasCommand),
  }, {
    injectObjects: true,
    enableProxy: true,
    files,
    wasmUri: __INKFORGE_WASM_URI__,
    // `globalBindings` registers into `_G` with no namespace (`js_type`,
    // `js_true`, `js_len`); the rest are namespaced.
    bindings: [globalBindings, jsonBindings, regexBindings, timersBindings],
  });

  await bridge.execute(INKFORGE_LUA_API);
  await bridge.executeFile(scriptPath);

  // The bridge's loop catches tick errors and emits them rather than throwing,
  // so without these subscriptions a failing `Update` or a failing timer
  // callback would be invisible.
  bridge.on("mainloop:error", (error: unknown) => {
    onError(error instanceof Error ? error.message : String(error));
  });
  bridge.on("timer:error", (message: unknown) => {
    onError(String(message));
  });

  await bridge.start({ intervalMs: MAIN_LOOP_INTERVAL_MS });

  return bridge;
}
