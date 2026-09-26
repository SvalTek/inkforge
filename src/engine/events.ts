import type { EngineRuntime, OutputFn, OutputKind } from "../types/index.ts";

/**
 * Mark the view dirty and make sure a frame will be drawn for it.
 *
 * Every mutation that changes what the author sees funnels through here, so a
 * change made from Lua, a timer or a directive all repaint the same way — and a
 * Lua timer that moves a bound meter needs no other call to be seen.
 */
export function markViewDirty(runtime: EngineRuntime): void {
  runtime.viewDirty = true;
  runtime.canvasEngine?.requestFrame();
}

/**
 * Repaint if something marked the view dirty, then clear the mark.
 *
 * The coalescing gate described on {@link EngineRuntime.viewDirty}. Called from
 * the canvas frame hook, which is the only repaint path a Lua-initiated change
 * has, and from the command boundaries, where it also keeps the repaint
 * synchronous with the interaction that caused it.
 */
export function flushView(runtime: EngineRuntime | null, render: () => void): void {
  if (!runtime?.viewDirty) return;
  runtime.viewDirty = false;
  render();
}

export function createOutput(runtime: EngineRuntime): OutputFn {
  return (text: unknown, kind?: OutputKind): void => {
    runtime.events.push({ type: "output", text: String(text), kind: kind ?? "normal" });
    markViewDirty(runtime);
  };
}
