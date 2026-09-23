import type { EngineEvent, EngineRuntime, OutputFn, OutputKind } from "../types/index.ts";

export function emit(runtime: EngineRuntime, event: EngineEvent): void {
  runtime.events.push(event);
}

export function createOutput(runtime: EngineRuntime): OutputFn {
  return (text: unknown, kind?: OutputKind): void => {
    runtime.events.push({ type: "output", text: String(text), kind: kind ?? "normal" });
    runtime.canvasViewDirty = true;
  };
}
