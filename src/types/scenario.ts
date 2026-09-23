import type { UiCommand, UiElement } from "./ui.ts";
import type { ModalDefinition, ToolDefinition } from "./tools.ts";

/** Scenario front matter (`meta`). */
export interface ScenarioMeta {
  title?: string;
  author?: string;
  version?: string;
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
}

/** A placed item instance referencing a definition by `def`. */
export interface ItemInstance {
  def?: string;
}

/** Item definitions keyed by kind, each mapping ids to definitions. */
export interface Definitions {
  item?: Record<string, ItemDefinition>;
  [kind: string]: Record<string, ItemDefinition> | undefined;
}

/** Item instances keyed by kind, each mapping ids to instances. */
export interface Instances {
  item?: Record<string, ItemInstance>;
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

/** A scenario location: title, prose, items, exits and actions. */
export interface Location {
  title?: string;
  text?: DirectiveList;
  items?: string[];
  exits?: LocationExitMap;
  actions?: LocationAction[];
}

/**
 * Conditional predicate. Evaluation order in `check` is: and, or, not,
 * hasItem, then var+comparison (eq/ne/neq/gt/gte/lt/lte), else `true`.
 */
export interface Condition {
  and?: Condition[];
  or?: Condition[];
  not?: Condition;
  hasItem?: string;
  var?: string;
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
  inc?: IncDecSpec | unknown;
  dec?: IncDecSpec | unknown;
  give?: string | { id?: string };
  remove?: string | { id?: string };
  goto?: string;
  ui?: UiCommand;
  if?: Condition;
  then?: DirectiveList;
  else?: DirectiveList;
  end?: boolean;
}

/** A directive is either a plain output string or a structured object. */
export type Directive = string | DirectiveObject;

/** A directive list is a single directive or an array of directives. */
export type DirectiveList = Directive | Directive[];

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
  locations?: Record<string, Location>;
  scripts?: ScenarioScripts;
}
