/** Severity/marker for an output event; known values plus any author string. */
export type OutputKind = "normal" | "warning" | "error" | string;

/**
 * Discriminated union of the events pushed onto `runtime.events` by the engine
 * and surfaced in the terminal and event stream.
 */
export type EngineEvent =
  | { type: "output"; text: string; kind: OutputKind }
  | { type: "location:enter"; locationId: string }
  | { type: "ui:update"; elementId: string }
  | { type: "inventory:add"; itemId: string }
  | { type: "inventory:remove"; itemId: string }
  | { type: "game:over" };

/** The `type` discriminant of every {@link EngineEvent}. */
export type EngineEventType = EngineEvent["type"];
