import type { UiCommand, UiElement } from "./ui.ts";
import type { ModalDefinition, ToolDefinition } from "./tools.ts";

/** Scenario front matter (`meta`). */
export interface ScenarioMeta {
  title?: string;
  author?: string;
  version?: string;
  /** One-line summary of the work; the project library shows it on the card. */
  description?: string;
}

/** Player seed block: initial state and inventory. */
export interface ScenarioPlayer {
  state?: Record<string, unknown>;
  inventory?: string[];
}

/** Scenario script hooks; `main` selects the Lua entry file. */
export interface ScenarioScripts {
  main?: string;
}

/** A named item definition (the template an instance points at via `def`). */
export interface ItemDefinition {
  name?: string;
  description?: string;
  aliases?: string[];
  actions?: ItemAction[];
  /** Author-defined metadata exposed to Lua through `GameItems`. */
  [key: string]: unknown;
}

/** An action shown for every inventory instance of an item definition. */
export interface ItemAction {
  id: string;
  label?: string;
  if?: Condition;
  then?: DirectiveList;
  /**
   * Whether the action is offered in the inventory inspector while a conversation is
   * running. Defaults to true; `false` withdraws it for the duration. Display only —
   * Lua can still run it. See {@link shownDuringConversation}.
   */
  allowInConversation?: boolean;
}

/** A placed instance of a definition, referenced by `def`. */
export interface DefinitionInstance {
  def?: string;
}

/** Item definitions keyed by kind, each mapping ids to definitions. */
export interface Definitions {
  item?: Record<string, ItemDefinition>;
  [kind: string]: Record<string, ItemDefinition> | undefined;
}

/**
 * Instances keyed by kind, each mapping ids to instances.
 *
 * Indexed by kind because an instance is a placement, not a thing in itself: the
 * same `npc` and the same `item` kinds are both placed into the world here, and
 * a location lists instance ids rather than definition ids.
 */
export interface Instances {
  item?: Record<string, DefinitionInstance>;
  npc?: Record<string, DefinitionInstance>;
  [kind: string]: Record<string, DefinitionInstance> | undefined;
}

/**
 * An NPC: who they are.
 *
 * An NPC is a top-level kind rather than a `definitions` entry because it is
 * authored directly, not composed from a template and a placement. It still
 * takes an instance to be present anywhere, and its mutable values live in
 * state under `npc.<instance-id>.<path>` — the same separation an item
 * definition and its instances have.
 */
export interface NpcDefinition {
  name?: string;
  description?: string;
  /**
   * Project-relative path to this NPC's portrait.
   *
   * Inkforge does not draw it. The key records which asset belongs to the NPC so
   * an author can reference one name instead of hunting through `assets/`, and
   * leaves rendering to a canvas scene or a UI element.
   */
  portrait?: string;
  /**
   * Default values seeded into the runtime state of every instance of this NPC.
   *
   * Explicit top-level `state` and a resumed save both apply over these, so a
   * default is a starting point rather than a lock.
   */
  state?: Record<string, unknown>;
  /** Author-defined metadata exposed to Lua through `GameNPCs`. */
  [key: string]: unknown;
}

/** An exit target: a bare location id, or a guarded/aliased descriptor. */
export type ExitValue = string | { to?: string; if?: Condition; aliases?: string[] };

/** Location exits keyed by the command direction the player types. */
export type LocationExitMap = Record<string, ExitValue>;

/** A location action reachable via `@id`, optionally guarded and scripted. */
export interface LocationAction {
  id: string;
  label?: string;
  if?: Condition;
  then?: DirectiveList;
}

/** A scenario location: title, prose, items, NPCs, exits and actions. */
export interface Location {
  title?: string;
  text?: DirectiveList;
  items?: string[];
  /** NPC instance ids present here, exactly as `items` holds item instance ids. */
  npcs?: string[];
  exits?: LocationExitMap;
  actions?: LocationAction[];
}

/**
 * Conditional predicate. Evaluation order in `check` is: and, or, not,
 * hasItem, then var/itemVar/npcVar+comparison (eq/ne/neq/gt/gte/lt/lte), else false.
 */
export interface Condition {
  and?: Condition[];
  or?: Condition[];
  not?: Condition;
  hasItem?: string;
  var?: string;
  itemVar?: string;
  /**
   * Read one NPC instance's own state, as `<instance-id>.<path>`.
   *
   * Names the instance rather than relying on an ambient subject, so it is valid
   * anywhere a condition is — a location action, a UI element, a conversation
   * option — and never depends on what happens to be in context.
   */
  npcVar?: string;
  eq?: unknown;
  ne?: unknown;
  neq?: unknown;
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
}

/** Increment/decrement payload: `{ var, by }` or a `{ [var]: by }` shorthand. */
export interface IncDecSpec {
  var?: string;
  by?: number;
  [key: string]: unknown;
}

/** A structured directive object accepted by `execute`. */
export interface DirectiveObject {
  text?: unknown;
  set?: Record<string, unknown>;
  itemSet?: Record<string, unknown>;
  /**
   * Assign state belonging to NPC instances, keyed `<instance-id>.<path>`.
   *
   * Unlike `itemSet` this needs no execution context: every key names its own
   * instance, so one directive can write several NPCs at once.
   */
  npcSet?: Record<string, unknown>;
  inc?: IncDecSpec | unknown;
  dec?: IncDecSpec | unknown;
  give?: string | { id?: string };
  remove?: string | { id?: string };
  goto?: string;
  /**
   * Start a conversation, entering its `start` node and offering its options.
   *
   * The player is then *in* that conversation: it owns the choice list and the
   * command box until something ends it. A conversation already in progress is
   * replaced rather than stacked, so this is a cut, not a push.
   */
  talk?: string;
  ui?: UiCommand;
  if?: Condition;
  then?: DirectiveList;
  else?: DirectiveList;
  end?: boolean;
  /**
   * Call a named Lua function, optionally passing `params`.
   *
   * The name is a dot-delimited path into Lua globals (`cellar.arrive`), and is
   * checked against the loaded script at boot so a typo fails loudly.
   */
  call?: string;
  params?: Record<string, unknown>;
  /**
   * Emit a named event that Lua can subscribe to with `Events:On`.
   *
   * Use `call` when exactly one known handler should run; use `emit` when the
   * authored content should not know or care who is listening.
   */
  emit?: string;
  data?: Record<string, unknown>;
}

/** A directive is either a plain output string or a structured object. */
export type Directive = string | DirectiveObject;

/** A directive list is a single directive or an array of directives. */
export type DirectiveList = Directive | Directive[];

/**
 * One spoken line.
 *
 * Not a `Directive`, because `speaker` is not a directive key: the line needs an
 * author to attribute it, and that attribution is the whole reason a conversation
 * is not just a directive list. `if` gates the line exactly as it gates a directive.
 */
export interface DialogueLine {
  /** An NPC instance id, or the literal `player`. */
  speaker: string;
  text: string;
  if?: Condition;
}

/** A choice offered at a node, and what taking it does. */
export interface ConversationOption {
  id: string;
  text: string;
  if?: Condition;
  then?: DirectiveList;
  /** Continue at this node of the same conversation. */
  next?: string;
  /** Cut to another conversation now, replacing the current one. */
  talk?: string;
}

/** One beat: what is said, and what the player may answer. */
export interface ConversationNode {
  dialogue?: DialogueLine[];
  options?: ConversationOption[];
}

/**
 * A conversation: a named set of nodes, entered at `start`.
 *
 * Nodes rather than one flat id per branch, because a dialogue tree that flattens
 * every branch into its own conversation stops being writable past a few exchanges.
 * What ends a conversation is deliberately explicit — see `docs/authoring/conversations.md`.
 */
export interface Conversation {
  /** NPC instance ids taking part, optionally with `player`. */
  participants?: string[];
  /**
   * Offer this conversation as a `Talk to …` choice while one of its NPCs is in the
   * room, without the author writing an action to start it.
   *
   * For interactions that are meant to be obvious. A conversation left unmarked stays
   * reachable only through a `talk:` directive, which is how you author somebody the
   * player has to *try* — and how the two are told apart.
   */
  discoverable?: boolean;
  /** Condition gating the offer, and nothing else. Starting it is never conditional. */
  if?: Condition;
  /** The node entered when the conversation starts. */
  start: string;
  nodes: Record<string, ConversationNode>;
}

/** The composed scenario document produced by `composeScenario`. */
export interface Scenario {
  meta?: ScenarioMeta;
  startLocation?: string;
  state?: Record<string, unknown>;
  player?: ScenarioPlayer;
  ui?: { elements?: UiElement[] };
  modals?: ModalDefinition[];
  tools?: ToolDefinition[];
  definitions?: Definitions;
  instances?: Instances;
  npcs?: Record<string, NpcDefinition>;
  locations?: Record<string, Location>;
  conversations?: Record<string, Conversation>;
  scripts?: ScenarioScripts;
}
