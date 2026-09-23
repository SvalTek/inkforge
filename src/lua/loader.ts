import { loadEsm, WASMOON_ESM_URL } from "../deps/remote.ts";
import type { WasmoonModule } from "../types/lua.ts";

/**
 * Import the remote `wasmoon` ESM build.
 *
 * Deliberately un-cached: the original created a fresh `LuaFactory` per boot
 * and relied on the ESM loader's own module cache, so this stays a thin
 * wrapper around `loadEsm`.
 */
export async function loadWasmoon(): Promise<WasmoonModule> {
  const module = await loadEsm<WasmoonModule>(WASMOON_ESM_URL);
  return module;
}
