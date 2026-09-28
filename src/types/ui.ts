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
export type UiActivationType =
  | "inventory.open"
  | "modal.close"
  | "modal.page"
  | "audio.play"
  | "command"
  | "instructions"
  | string;

/** Activation binding attached to `element.events.activate`/`actions.activate`. */
export interface UiActivation {
  type?: UiActivationType;
  command?: string;
  then?: DirectiveList;
  callback?: string;
  page?: string;
  kicker?: string;
  title?: string;
  asset?: string;
  id?: string;
  volume?: number;
  loop?: boolean;
}

/** Declarative UI element as authored in YAML or created by Lua. */
export interface UiElement {
  id: string;
  type: string;
  location?: UiLocation;
  fields?: UiField[];
  /** Nested authored elements for compound UI and modal content. */
  elements?: UiElement[];
  events?: Record<string, UiActivation>;
  actions?: Record<string, UiActivation>;
  accessibleLabel?: string;
  if?: Condition;
  /**
   * Whether this element stays on screen while a conversation is running.
   *
   * Defaults to false: an exchange owns the player's attention, so an element must opt
   * in with `true` to stay available during it.
   *
   * There is deliberately no engine-side guess from location or activation type. A
   * `callback` button is perfectly live mid-conversation and may be the control an
   * author deliberately permits; so can a meter or a sidebar control.
   *
   * The element is dropped from the render, not hidden, so an `if` condition on it
   * still decides it on every other turn. An author who wants one back for a specific
   * conversation can `GameUI.show` it from that conversation's directives.
   */
  allowInConversation?: boolean;
}

/** Override fields: a replacement field list or an id-to-value map. */
export type UiOverrideFields = UiField[] | Record<string, unknown>;

/** Per-element runtime override merged over the declared element. */
export type UiOverride = Partial<Omit<UiElement, "fields">> & { fields?: UiOverrideFields };

/** Runtime override table keyed by element id (`runtime.ui.overrides`). */
export type UiOverrideMap = Record<string, UiOverride>;

/** A UI element after field resolution, carrying computed `values`. */
export type ResolvedUiElement = UiElement & { values: Record<string, unknown>; runtimePath: string };

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

/**
 * Which authored item actions are currently withheld (`runtime.items`).
 *
 * A tool has `hidden` and a UI element has the `ui.hidden` set, so an item action needed
 * a state of its own rather than being smuggled into one of those under a namespaced key.
 * It is keyed by `itemActionId` — `<definitionId>.<actionId>` — because that is the
 * identity the flag is authored against, and the one an author can read off their own
 * definition.
 */
export interface ItemActionRuntimeState {
  hidden: Set<string>;
}
