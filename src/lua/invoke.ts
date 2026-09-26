import type LuaBridge from "WebLuaBridge";

/** Reports a seam failure (missing handler, thrown error) to the author. */
export type SeamReport = (message: string, severity: "error" | "warning") => void;

/**
 * Call a named Lua function, optionally with params.
 *
 * Names are dot-delimited paths into Lua globals (`cellar.arrive`), which
 * `bridge.call` resolves natively. A missing function surfaces as a bridge
 * `CALL` error rather than a silent no-op.
 */
export async function invokeNamedFunction(
  lua: LuaBridge | null,
  name: string,
  params: Record<string, unknown>,
  report: SeamReport,
): Promise<void> {
  if (!lua) {
    report(`Cannot call '${name}': no Lua runtime is loaded.`, "warning");
    return;
  }
  try {
    await lua.call(name, params);
  } catch (error) {
    report(error instanceof Error ? error.message : `Failed to call '${name}'.`, "error");
  }
}

/**
 * Emit a named event to any Lua subscribers.
 *
 * `bridge.emit` reports how many handlers ran, so an event nobody listens to is
 * reportable rather than silent. This is the only validation possible for
 * `emit:` — `Events:On` exposes no way to enumerate listeners ahead of time.
 *
 * Synchronous: `bridge.emit` returns its handler count directly, so there is
 * nothing to await. The engine's seam accepts a promise for it anyway, to keep
 * its ordering guarantee independent of that.
 */
export function emitNamedEvent(
  lua: LuaBridge | null,
  name: string,
  data: Record<string, unknown>,
  report: SeamReport,
): void {
  if (!lua) {
    report(`Cannot emit '${name}': no Lua runtime is loaded.`, "warning");
    return;
  }
  const handled = lua.emit(name, data);
  if (handled === 0) {
    report(`Event '${name}' was emitted but nothing is listening for it.`, "warning");
  }
}
