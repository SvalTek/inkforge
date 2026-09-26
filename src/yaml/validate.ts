import type { Condition, Directive, DirectiveList, Scenario } from "../types/index.ts";
import { DIRECTIVE_KEYS } from "../engine/directives.ts";

/** The recognised condition keys. Anything else is a typo, not a pass. */
export const CONDITION_KEYS = [
  "and",
  "or",
  "not",
  "hasItem",
  "var",
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

/** One problem found in the composed scenario, with the path to it. */
export interface ValidationIssue {
  path: string;
  message: string;
}

function checkCondition(condition: Condition | undefined, path: string, issues: ValidationIssue[]): void {
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
  // Comparison keys only mean something alongside `var`.
  const comparisons = ["eq", "ne", "neq", "gt", "gte", "lt", "lte"];
  if (comparisons.some((key) => key in condition) && !("var" in condition)) {
    issues.push({ path, message: "comparison needs a 'var' to compare against" });
  }
  if (condition.and) condition.and.forEach((item, index) => checkCondition(item, `${path}.and.${index}`, issues));
  if (condition.or) condition.or.forEach((item, index) => checkCondition(item, `${path}.or.${index}`, issues));
  if (condition.not) checkCondition(condition.not, `${path}.not`, issues);
}

function checkDirectives(list: DirectiveList | undefined, path: string, issues: ValidationIssue[]): void {
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
    if (directive.if) checkCondition(directive.if as Condition, `${itemPath}.if`, issues);
    if (directive.then) checkDirectives(directive.then as DirectiveList, `${itemPath}.then`, issues);
    if (directive.else) checkDirectives(directive.else as DirectiveList, `${itemPath}.else`, issues);
  });
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

  for (const [id, location] of Object.entries(scenario.locations || {})) {
    checkDirectives(location.text, `locations.${id}.text`, issues);
    (location.actions || []).forEach((action, index) => {
      checkCondition(action.if, `locations.${id}.actions.${index}.if`, issues);
      checkDirectives(action.then, `locations.${id}.actions.${index}.then`, issues);
    });
    for (const [direction, exit] of Object.entries(location.exits || {})) {
      if (exit && typeof exit === "object") {
        checkCondition(exit.if, `locations.${id}.exits.${direction}.if`, issues);
      }
    }
  }

  (scenario.ui?.elements || []).forEach((element, index) => {
    for (const [slot, binding] of Object.entries(element.events || {})) {
      if (binding?.then) checkDirectives(binding.then, `ui.elements.${index}.events.${slot}.then`, issues);
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
  (scenario.ui?.elements || []).forEach((element, index) => {
    for (const [slot, binding] of Object.entries(element.events || {})) {
      if (typeof binding?.callback === "string") {
        references.push({ path: `ui.elements.${index}.events.${slot}.callback`, message: binding.callback });
      }
      fromDirective(binding?.then, `ui.elements.${index}.events.${slot}.then`);
    }
  });
  (scenario.tools || []).forEach((tool, index) => {
    if (typeof tool.action === "string") {
      references.push({ path: `tools.${index}.action`, message: tool.action });
    }
  });

  return references;
}
