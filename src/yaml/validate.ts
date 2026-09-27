import type { Condition, Directive, DirectiveList, Scenario, UiElement } from "../types/index.ts";
import { DIRECTIVE_KEYS } from "../engine/directives.ts";
import { parseNpcPath } from "../engine/state.ts";
import { isAssetPath } from "../project/assets.ts";

/** The recognised condition keys. Anything else is a typo, not a pass. */
export const CONDITION_KEYS = [
  "and",
  "or",
  "not",
  "hasItem",
  "var",
  "itemVar",
  "npcVar",
  "eq",
  "ne",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

const CONDITION_KEY_SET = new Set<string>(CONDITION_KEYS);
const DIRECTIVE_KEY_SET = new Set<string>(DIRECTIVE_KEYS);
const ITEM_ACTION_KEY_SET = new Set(["id", "label", "if", "then"]);

/** One problem found in the composed scenario, with the path to it. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * What a condition or directive list needs to know about the composed scenario
 * to be checked properly.
 *
 * Threaded rather than read from a module global so a check always sees the
 * scenario it was handed, and so `validateScenario` is the only place that
 * decides what "declared" means.
 */
export interface ValidationScope {
  /** Every declared `instances.npc` id, so an `npcVar` subject can be resolved. */
  npcInstances: Set<string>;
}

function checkCondition(
  condition: Condition | undefined,
  path: string,
  issues: ValidationIssue[],
  scope: ValidationScope,
  hasItemContext = false,
): void {
  if (condition === undefined || condition === null) return;
  if (typeof condition !== "object") {
    issues.push({ path, message: "condition must be an object" });
    return;
  }
  const keys = Object.keys(condition);
  if (keys.length === 0) {
    issues.push({ path, message: "condition is empty" });
    return;
  }
  for (const key of keys) {
    if (!CONDITION_KEY_SET.has(key)) {
      issues.push({ path, message: `unknown condition key '${key}'` });
    }
  }
  const stateKeys = ["var", "itemVar", "npcVar"].filter((key) => key in condition);
  if (stateKeys.length > 1) {
    issues.push({ path, message: "condition cannot combine 'var', 'itemVar' and 'npcVar'" });
  }
  if ("itemVar" in condition && !hasItemContext) {
    issues.push({ path, message: "'itemVar' requires an inventory item action context" });
  }
  // An `npcVar` names its instance, so it needs no context — but the instance has
  // to exist. At runtime an unknown subject reads an absent state key and simply
  // compares false, which is exactly the silent gate this check exists to stop.
  if ("npcVar" in condition) {
    const spec = condition.npcVar;
    if (typeof spec !== "string" || !spec.trim()) {
      issues.push({ path: `${path}.npcVar`, message: "npcVar must be a non-empty string" });
    } else {
      const subject = parseNpcPath(spec);
      if (!subject) {
        issues.push({ path: `${path}.npcVar`, message: `npcVar must be '<npc-instance>.<value>', got '${spec}'` });
      } else if (!scope.npcInstances.has(subject.instanceId)) {
        issues.push({ path: `${path}.npcVar`, message: `npcVar names unknown NPC instance '${subject.instanceId}'` });
      }
    }
  }
  // Comparison keys only mean something alongside one state-reading key.
  const comparisons = ["eq", "ne", "neq", "gt", "gte", "lt", "lte"];
  if (comparisons.some((key) => key in condition) && stateKeys.length === 0) {
    issues.push({ path, message: "comparison needs a 'var', 'itemVar' or 'npcVar' to compare against" });
  }
  if (condition.and) {
    condition.and.forEach((item, index) => checkCondition(item, `${path}.and.${index}`, issues, scope, hasItemContext));
  }
  if (condition.or) {
    condition.or.forEach((item, index) => checkCondition(item, `${path}.or.${index}`, issues, scope, hasItemContext));
  }
  if (condition.not) checkCondition(condition.not, `${path}.not`, issues, scope, hasItemContext);
}

function checkDirectives(
  list: DirectiveList | undefined,
  path: string,
  issues: ValidationIssue[],
  scope: ValidationScope,
  hasItemContext = false,
): void {
  if (list === undefined || list === null) return;
  const items = Array.isArray(list) ? list : [list];
  items.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (typeof item === "string") return;
    if (!item || typeof item !== "object") {
      issues.push({ path: itemPath, message: "directive must be a string or an object" });
      return;
    }
    const directive = item as Directive & Record<string, unknown>;
    const keys = Object.keys(directive).filter((key) =>
      DIRECTIVE_KEY_SET.has(key) || key === "then" || key === "else" || key === "params" || key === "data"
    );
    if (keys.length === 0) {
      issues.push({
        path: itemPath,
        message: `unrecognised directive ${JSON.stringify(Object.keys(directive))} — nothing will happen`,
      });
    }
    if ("itemSet" in directive) {
      if (!directive.itemSet || typeof directive.itemSet !== "object" || Array.isArray(directive.itemSet)) {
        issues.push({ path: `${itemPath}.itemSet`, message: "itemSet must be a mapping" });
      }
      if (!hasItemContext) {
        issues.push({ path: itemPath, message: "'itemSet' requires an inventory item action context" });
      }
    }
    // `npcSet` keys are `<instance>.<value>`, so the mapping check is not enough:
    // a key that does not parse would be reported by the directive and write
    // nothing, which is worth catching here too. No context gate, because every
    // key names its own instance.
    if ("npcSet" in directive) {
      const npcSet = directive.npcSet;
      if (!npcSet || typeof npcSet !== "object" || Array.isArray(npcSet)) {
        issues.push({ path: `${itemPath}.npcSet`, message: "npcSet must be a mapping" });
      } else {
        for (const spec of Object.keys(npcSet as Record<string, unknown>)) {
          const subject = parseNpcPath(spec);
          if (!subject) {
            issues.push({ path: `${itemPath}.npcSet.${spec}`, message: "key must be '<npc-instance>.<value>'" });
          } else if (!scope.npcInstances.has(subject.instanceId)) {
            issues.push({
              path: `${itemPath}.npcSet.${spec}`,
              message: `unknown NPC instance '${subject.instanceId}'`,
            });
          }
        }
      }
    }
    if (directive.if) checkCondition(directive.if as Condition, `${itemPath}.if`, issues, scope, hasItemContext);
    if (directive.then) {
      checkDirectives(directive.then as DirectiveList, `${itemPath}.then`, issues, scope, hasItemContext);
    }
    if (directive.else) {
      checkDirectives(directive.else as DirectiveList, `${itemPath}.else`, issues, scope, hasItemContext);
    }
  });
}

function checkItemAction(
  action: unknown,
  path: string,
  issues: ValidationIssue[],
  scope: ValidationScope,
): void {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    issues.push({ path, message: "item action must be an object" });
    return;
  }
  const value = action as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!ITEM_ACTION_KEY_SET.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `unknown item action key '${key}'` });
    }
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    issues.push({ path: `${path}.id`, message: "item action id must be a non-empty string" });
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    issues.push({ path: `${path}.label`, message: "item action label must be a string" });
  }
  checkCondition(value.if as Condition | undefined, `${path}.if`, issues, scope, true);
  checkDirectives(value.then as DirectiveList | undefined, `${path}.then`, issues, scope, true);
}

/**
 * Visit every authored UI element, including nested ones, with its validation path.
 *
 * An element carries more than its `events`: `if` is evaluated on every render
 * (`renderUi`, `renderModals`) and `actions` is read as an alternative to `events`
 * (`runUiAction`), so a validator that only walks top-level `events` skips a
 * condition it could have reported and a directive list it could have checked. One
 * walker serves both validation and Lua-name collection, so the two cannot disagree
 * about how deep they reach.
 */
function walkUiElements(
  elements: UiElement[] | undefined,
  visit: (element: UiElement, path: string) => void,
  path = "ui.elements",
): void {
  for (const [index, element] of (elements || []).entries()) {
    const elementPath = `${path}.${index}`;
    visit(element, elementPath);
    walkUiElements(element.elements, visit, `${elementPath}.elements`);
  }
}

/**
 * Check a composed scenario for the mistakes that would otherwise fail silently.
 *
 * This covers the static half of "make failure loud": an unknown condition key
 * or directive key is a typo that, left alone, either opens a gate permanently
 * or does nothing at all. Names that refer to Lua (`call:`, its UI equivalent,
 * tool actions) can only be checked once the script has loaded, which happens
 * separately at boot.
 */
export function validateScenario(scenario: Scenario): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scope: ValidationScope = {
    npcInstances: new Set(Object.keys(scenario.instances?.npc || {})),
  };

  // NPCs first: the locations and directives below resolve against them, and an
  // issue list reads better when the cause precedes the symptom it causes.
  for (const [id, npc] of Object.entries(scenario.npcs || {})) {
    if (!id.trim()) {
      issues.push({ path: "npcs", message: "npc id must be a non-empty string" });
    }
    if (npc.name !== undefined && typeof npc.name !== "string") {
      issues.push({ path: `npcs.${id}.name`, message: "npc name must be a string" });
    }
    if (npc.description !== undefined && typeof npc.description !== "string") {
      issues.push({ path: `npcs.${id}.description`, message: "npc description must be a string" });
    }
    if (npc.portrait !== undefined) {
      if (typeof npc.portrait !== "string") {
        issues.push({ path: `npcs.${id}.portrait`, message: "npc portrait must be a string" });
      } else if (!isAssetPath(npc.portrait)) {
        // Shape only. Whether the asset is actually there is the resolver's
        // report, so a scenario that ships a portrait before uploading it is a
        // work in progress rather than a broken file.
        issues.push({
          path: `npcs.${id}.portrait`,
          message: `npc portrait must be a project asset path such as assets/portrait.webp, got '${npc.portrait}'`,
        });
      }
    }
    if (
      npc.state !== undefined &&
      (typeof npc.state !== "object" || npc.state === null || Array.isArray(npc.state))
    ) {
      issues.push({ path: `npcs.${id}.state`, message: "npc state must be a mapping of value names to values" });
    }
  }

  for (const [id, instance] of Object.entries(scenario.instances?.npc || {})) {
    const def = instance?.def;
    if (typeof def !== "string" || !def.trim()) {
      issues.push({ path: `instances.npc.${id}`, message: "npc instance must name a definition with 'def'" });
    } else if (!scenario.npcs?.[def]) {
      issues.push({ path: `instances.npc.${id}.def`, message: `unknown npc definition '${def}'` });
    }
    // The instance id is the left side of `<instance>.<value>`, and the dot is the
    // only thing separating them. An id carrying one would seed, resolve and be
    // listed by a location, yet be unreachable from `npcVar` and `npcSet` — which
    // split on the first dot and would read `court.keeper.trust` as the instance
    // `court`. Refusing the character is louder than a subject that silently never
    // matches. NPC *definition* ids are exempt: they are only ever exact lookups.
    if (id.includes(".")) {
      issues.push({
        path: `instances.npc.${id}`,
        message: `npc instance id must not contain '.', which separates it from a value name, got '${id}'`,
      });
    }
  }

  for (const [id, location] of Object.entries(scenario.locations || {})) {
    checkDirectives(location.text, `locations.${id}.text`, issues, scope);
    (location.actions || []).forEach((action, index) => {
      checkCondition(action.if, `locations.${id}.actions.${index}.if`, issues, scope);
      checkDirectives(action.then, `locations.${id}.actions.${index}.then`, issues, scope);
    });
    for (const [direction, exit] of Object.entries(location.exits || {})) {
      if (exit && typeof exit === "object") {
        checkCondition(exit.if, `locations.${id}.exits.${direction}.if`, issues, scope);
      }
    }
    for (const npcId of location.npcs || []) {
      if (!scope.npcInstances.has(npcId)) {
        issues.push({ path: `locations.${id}.npcs`, message: `unknown npc instance '${npcId}'` });
      }
    }
  }

  for (const [id, definition] of Object.entries(scenario.definitions?.item || {})) {
    if (definition.actions !== undefined && !Array.isArray(definition.actions)) {
      issues.push({ path: `definitions.item.${id}.actions`, message: "item actions must be a list" });
      continue;
    }
    (definition.actions || []).forEach((action, index) =>
      checkItemAction(action, `definitions.item.${id}.actions.${index}`, issues, scope)
    );
  }

  walkUiElements(scenario.ui?.elements, (element, path) => {
    checkCondition(element.if, `${path}.if`, issues, scope);
    for (const [source, bindings] of [["events", element.events], ["actions", element.actions]] as const) {
      for (const [slot, binding] of Object.entries(bindings || {})) {
        checkDirectives(binding?.then, `${path}.${source}.${slot}.then`, issues, scope);
      }
    }
  });

  return issues;
}

/** Collect every Lua function name referenced by authored content. */
export function collectReferencedLuaNames(scenario: Scenario): ValidationIssue[] {
  const references: ValidationIssue[] = [];

  const fromDirective = (list: DirectiveList | undefined, path: string): void => {
    if (list === undefined || list === null) return;
    const items = Array.isArray(list) ? list : [list];
    items.forEach((item, index) => {
      if (typeof item === "string" || !item || typeof item !== "object") return;
      const directive = item as Record<string, unknown>;
      if (typeof directive.call === "string") {
        references.push({ path: `${path}.${index}.call`, message: directive.call });
      }
      if (directive.then) fromDirective(directive.then as DirectiveList, `${path}.${index}.then`);
      if (directive.else) fromDirective(directive.else as DirectiveList, `${path}.${index}.else`);
    });
  };

  for (const [id, location] of Object.entries(scenario.locations || {})) {
    fromDirective(location.text, `locations.${id}.text`);
    (location.actions || []).forEach((action, index) => {
      fromDirective(action.then, `locations.${id}.actions.${index}.then`);
    });
  }
  for (const [id, definition] of Object.entries(scenario.definitions?.item || {})) {
    (definition.actions || []).forEach((action, index) => {
      fromDirective(action.then, `definitions.item.${id}.actions.${index}.then`);
    });
  }
  walkUiElements(scenario.ui?.elements, (element, path) => {
    for (const [source, bindings] of [["events", element.events], ["actions", element.actions]] as const) {
      for (const [slot, binding] of Object.entries(bindings || {})) {
        if (typeof binding?.callback === "string") {
          references.push({ path: `${path}.${source}.${slot}.callback`, message: binding.callback });
        }
        fromDirective(binding?.then, `${path}.${source}.${slot}.then`);
      }
    }
  });
  (scenario.tools || []).forEach((tool, index) => {
    if (typeof tool.action === "string") {
      references.push({ path: `tools.${index}.action`, message: tool.action });
    }
  });

  return references;
}
