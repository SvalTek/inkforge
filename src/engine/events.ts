import type { EngineEvent, EngineRuntime, OutputFn, OutputKind } from "../types/index.ts";

/**
 * The transcript ceiling.
 *
 * Far more than a player reads in one scene, and small enough that a session
 * which narrates from a timer all evening cannot grow the array — and with it
 * the whole terminal DOM, which is rebuilt from that array on every repaint —
 * without limit.
 */
export const MAX_EVENTS = 200;

/**
 * The one place a transcript entry is appended.
 *
 * Trimming here rather than at each call site is the point: a new append path
 * added later is capped by construction instead of having to remember.
 */
export function pushEvent(runtime: EngineRuntime, event: EngineEvent): void {
  runtime.events.push(event);
  const excess = runtime.events.length - MAX_EVENTS;
  if (excess > 0) {
    runtime.events.splice(0, excess);
    runtime.droppedEvents += excess;
  }
}

/**
 * Empty the transcript, elision count included.
 *
 * The count is part of the reset rather than left behind on purpose: it
 * describes entries that are *no longer* on screen, so a clear that kept it
 * would leave a terminal with no events at all still announcing that earlier
 * ones were elided.
 */
export function clearTranscript(runtime: EngineRuntime): void {
  runtime.events = [];
  runtime.droppedEvents = 0;
}

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
  // Clearing before the paint is what makes this safe to call from inside a paint, and
  // it is also what made the second pass necessary. A paint can decide the view changed:
  // settling a conversation whose options all closed mid-exchange ends it, and ending
  // marks the view dirty again. That used to leave the flag set for a repaint which
  // would render the state the paint had just produced — a wasted full DOM rebuild,
  // once, on a path rare enough to be easy to miss.
  //
  // Consuming it here rather than deferring it is why the claim "one command repaints
  // once" is true on every path including this one. Bounded at three passes, and
  // settling converges, so in practice this is two: the paint that settles, and the one
  // that shows the result. The bound is only here so that a genuine oscillation is a
  // visible wrong number of frames rather than a hang.
  for (let pass = 0; pass < 3 && runtime.viewDirty; pass += 1) {
    runtime.viewDirty = false;
    render();
  }
}

export function createOutput(runtime: EngineRuntime): OutputFn {
  return (text: unknown, kind?: OutputKind): void => {
    pushEvent(runtime, { type: "output", text: String(text), kind: kind ?? "normal" });
    markViewDirty(runtime);
  };
}
