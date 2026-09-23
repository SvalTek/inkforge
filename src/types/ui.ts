import type { Condition, DirectiveList } from "./scenario.ts";

/** Named UI region; the known regions plus any author-supplied string. */
export type UiLocation = "sidebar" | "hud" | "canvas" | "output" | string;

/** Field source kind: a literal `value` or a `state` path lookup. */
export type UiFieldType = "text" | "state" | string;

/** A single data field declared on a UI element (`ui.yml` / Lua create). */
export interface UiField {
  id: string;
  type: UiFieldType;
  value?: unknown;
  path?: string;
}

/** Behaviour kind for an element activation binding. */
export type UiActivationType = "inventory.open" | "command" | "instructions" | string;

/** Activation binding attached to `element.events.activate`/`actions.activate`. */
export interface UiActivation {
  type?: UiActivationType;
  command?: string;
  then?: DirectiveList;
  callback?: string;
  kicker?: string;
  title?: string;
}

/** Declarative UI element as authored in YAML or created by Lua. */
export interface UiElement {
  id: string;
  type: string;
  location?: UiLocation;
  fields?: UiField[];
  events?: Record<string, UiActivation>;
  actions?: Record<string, UiActivation>;
  accessibleLabel?: string;
  if?: Condition;
}

/** Override fields: a replacement field list or an id-to-value map. */
export type UiOverrideFields = UiField[] | Record<string, unknown>;

/** Per-element runtime override merged over the declared element. */
export type UiOverride = Partial<Omit<UiElement, "fields">> & { fields?: UiOverrideFields };

/** Runtime override table keyed by element id (`runtime.ui.overrides`). */
export type UiOverrideMap = Record<string, UiOverride>;

/** A UI element after field resolution, carrying computed `values`. */
export type ResolvedUiElement = UiElement & { values: Record<string, unknown> };

/** Imperative UI command consumed by `applyUi` (create/set/show/hide/remove). */
export interface UiCommand {
  create?: Partial<UiElement> & { id: string } | unknown;
  set?: Record<string, UiOverride | unknown>;
  show?: string;
  hide?: string;
  remove?: string;
}

/** Live UI runtime state held on the engine (`runtime.ui`). */
export interface UiRuntimeState {
  hidden: Set<string>;
  overrides: UiOverrideMap;
  elements: UiElement[];
}
