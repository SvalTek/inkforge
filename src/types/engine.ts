import type LuaBridge from "WebLuaBridge";
import type { CanvasHost } from "./canvas.ts";
import type { EngineEvent, OutputKind } from "./events.ts";
import type { Condition, DirectiveList, Scenario } from "./scenario.ts";
import type { ModalRuntimeState, ToolRegistry } from "./tools.ts";
import type { UiCommand, UiRuntimeState } from "./ui.ts";

/** Live engine runtime object created by `start` and mutated by the engine. */
export interface EngineRuntime {
  location: string;
  state: Record<string, unknown>;
  inventory: string[];
  events: EngineEvent[];
  over: boolean;
  ui: UiRuntimeState;
  modals: ModalRuntimeState;
  tools: ToolRegistry;
  conversation: unknown;
  lua: LuaBridge | null;
  canvasEngine: CanvasHost | null;
  /**
   * Set by every mutation funnel (output, UI, state, inventory, tools) and
   * cleared by the single repaint in `flushView`.
   *
   * It exists to coalesce: the canvas frame loop runs on every animation frame,
   * and rebuilding the whole DOM at 60fps is pure waste, so a repaint happens
   * only when something actually asked for one. A command that changes five
   * things repaints once; a static scene repaints not at all.
   */
  viewDirty: boolean;
}

/** A command the player can issue, rendered as a choice button. */
export interface AvailableAction {
  text: string;
  cmd: string;
}

/**
 * The engine surface (`check`/`move`/`execute`/`available`/`dispatch`).
 *
 * `move`, `execute` and `dispatch` are async only because directives can reach
 * into Lua, and the bridge is async. Everything else stays synchronous.
 */
export interface EngineApi {
  check(c: Condition | undefined): boolean;
  move(id: string): Promise<void>;
  execute(list: DirectiveList | undefined): Promise<void>;
  available(): AvailableAction[];
  dispatch(raw: string): Promise<void>;
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
  /** Run a named Lua function with params (a `call:` directive). */
  invokeLua(name: string, params: Record<string, unknown>): Promise<void>;
  /** Emit a named event to Lua subscribers (an `emit:` directive). */
  emitEvent(name: string, data: Record<string, unknown>): void | Promise<void>;
}
