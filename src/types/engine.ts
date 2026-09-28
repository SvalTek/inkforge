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
  /**
   * How many transcript entries the cap has discarded this run.
   *
   * `dispatch` clears the transcript at every turn boundary, so growth is
   * bounded per turn — but nothing bounds a single turn, where a Lua timer or
   * an update loop can narrate indefinitely. Dropped entries are counted rather
   * than forgotten so the terminal can admit what is missing, and so a resumed
   * save carries an honest transcript instead of pretending it is complete.
   */
  droppedEvents: number;
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

/** An item action currently available to a held item instance. */
export interface AvailableInventoryAction {
  id: string;
  label: string;
}

/** The concrete inventory item that caused an authored action to run. */
export interface ItemExecutionContext {
  id: string;
  definitionId: string;
  actionId: string;
}

/**
 * Transient subject information carried through one authored execution chain.
 *
 * This is deliberately not runtime state: it describes why directives are
 * running, and disappears when that invocation finishes.
 */
export interface ExecutionContext {
  item?: ItemExecutionContext;
}

/**
 * The engine surface (`check`/`move`/`execute`/`available`/`dispatch`).
 *
 * `move`, `execute` and `dispatch` are async only because directives can reach
 * into Lua, and the bridge is async. Everything else stays synchronous.
 */
export interface EngineApi {
  check(c: Condition | undefined, context?: ExecutionContext): boolean;
  move(id: string, context?: ExecutionContext): Promise<void>;
  execute(list: DirectiveList | undefined, context?: ExecutionContext): Promise<void>;
  available(): AvailableAction[];
  inventoryActions(itemId: string): AvailableInventoryAction[];
  runInventoryAction(itemId: string, actionId: string): Promise<boolean>;
  triggerInventoryAction(itemId: string, actionId: string): void;
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
  invokeLua(name: string, params: Record<string, unknown>, context?: ExecutionContext): Promise<void>;
  /** Emit a named event to Lua subscribers (an `emit:` directive). */
  emitEvent(name: string, data: Record<string, unknown>, context?: ExecutionContext): void | Promise<void>;
}
