import type { CanvasHost } from "./canvas.ts";
import type { EngineEvent, OutputKind } from "./events.ts";
import type { LuaCallback, LuaEngine } from "./lua.ts";
import type { Condition, DirectiveList, Scenario } from "./scenario.ts";
import type { UiCommand, UiRuntimeState } from "./ui.ts";

/** Live engine runtime object created by `start` and mutated by the engine. */
export interface EngineRuntime {
  location: string;
  state: Record<string, unknown>;
  inventory: string[];
  events: EngineEvent[];
  over: boolean;
  ui: UiRuntimeState;
  conversation: unknown;
  lua: LuaEngine | null;
  canvasEngine: CanvasHost | null;
  canvasEvent: LuaCallback | undefined;
  timerEvent: LuaCallback | undefined;
  canvasViewDirty: boolean;
}

/** A command the player can issue, rendered as a choice button. */
export interface AvailableAction {
  text: string;
  cmd: string;
}

/** The pure engine surface (`check`/`move`/`execute`/`available`/`dispatch`). */
export interface EngineApi {
  check(c: Condition | undefined): boolean;
  move(id: string): void;
  execute(list: DirectiveList | undefined): void;
  available(): AvailableAction[];
  dispatch(raw: string): void;
}

/** Output sink: coerces any text to a string and tags it with a kind. */
export type OutputFn = (text: unknown, kind?: OutputKind) => void;

/** UI command sink backed by `applyUi`. */
export type ApplyUiFn = (command: UiCommand) => void;

/** What the engine needs from the host application. */
export interface EngineDeps {
  getScenario(): Scenario | null;
  runtime: EngineRuntime;
  output: OutputFn;
  applyUi: ApplyUiFn;
  render(): void;
}
