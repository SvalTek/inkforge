import type LuaBridge from "WebLuaBridge";
import type { CanvasHost } from "./canvas.ts";
import type { EngineEvent, OutputKind } from "./events.ts";
import type { Condition, DirectiveList, Scenario } from "./scenario.ts";
import type { ModalRuntimeState, ToolRegistry } from "./tools.ts";
import type { UiCommand, UiRuntimeState } from "./ui.ts";

/** Where the player currently is in a conversation. */
export interface ConversationState {
  id: string;
  nodeId: string;
}

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
  /**
   * The conversation the player is currently in, or null.
   *
   * Position only, not a log: spoken lines are ordinary transcript entries, so they
   * are capped, restorable and renderable by the machinery that already handles
   * them. Holding the position separately is what lets a save resume a conversation
   * mid-exchange without duplicating the transcript. Cleared by `setLocation`, since
   * moving somewhere else is not something you can still be talking through.
   */
  conversation: ConversationState | null;
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
  /**
   * Present when this choice is a conversation option rather than a command.
   *
   * An option is bound to a closure instead of dispatched, and that is not a detail:
   * dispatching clears the transcript, which would erase the very exchange the
   * player is reading. The engine stays pure data and says which kind of choice
   * this is; turning that into a handler is the renderer's job.
   */
  conversation?: { optionId: string };
  /**
   * Present when this choice starts a conversation rather than issuing a command.
   *
   * Bound to a closure for the same reason options are: dispatching clears the
   * transcript, and the offer is made by the room the player is reading, so wiping
   * that description to make room for the greeting is a loss rather than a turn
   * boundary.
   *
   * This started as a dispatched `@talk:<id>` command, which had a flaw no amount of
   * testing the happy path would have found: a location action is dispatched as
   * `@<its id>`, so an action authored as `id: "talk:bell"` produced `@talk:bell` and
   * was intercepted as a request to start a conversation called `bell`. Any encoding
   * smuggled through the command string shares the action id namespace. A payload on
   * the choice does not.
   */
  talk?: { conversationId: string };
}

/** The concrete inventory item that caused an authored action to run. */
export interface ItemExecutionContext {
  id: string;
  definitionId: string;
  actionId: string;
}

/** Which conversation, and which choice inside it, is being executed. */
export interface ConversationExecutionContext {
  /** The conversation id. */
  id: string;
  /** The node the choice was taken at. */
  nodeId: string;
  /** Absent while a node's own directives run, rather than an option's. */
  optionId?: string;
  /** NPC instance ids taking part, plus `player` when the player is one. */
  participants: string[];
}

/**
 * Transient subject information carried through one authored execution chain.
 *
 * This is deliberately not runtime state: it describes why directives are
 * running, and disappears when that invocation finishes.
 */
export interface ExecutionContext {
  item?: ItemExecutionContext;
  conversation?: ConversationExecutionContext;
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
  dispatch(raw: string): Promise<void>;
  /** Take a conversation option, by id. A no-op when no conversation is running. */
  chooseConversationOption(optionId: string): Promise<void>;
  /**
   * Begin a conversation by id, as a discoverable offer does. A no-op once the run
   * is over. Synchronous, and does not repaint: the conversation functions mark the
   * view dirty through the ordinary funnels and the caller flushes once.
   */
  beginDiscoverableTalk(conversationId: string): void;
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
