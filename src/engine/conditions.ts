import type { Condition, EngineRuntime } from "../types/index.ts";

/**
 * Evaluate a condition.
 *
 * Unrecognised keys evaluate to **false**, not true. A misspelled `hasitem`
 * used to read as "always pass", silently opening gates — the worst possible
 * default for a condition language. `validateScenario` reports the typo at load
 * time; this is the runtime backstop that keeps it closed if one slips through.
 */
export function check(condition: Condition | undefined, runtime: EngineRuntime): boolean {
  if (!condition) return true;
  if (condition.and) return condition.and.every((item) => check(item, runtime));
  if (condition.or) return condition.or.some((item) => check(item, runtime));
  if (condition.not) return !check(condition.not, runtime);
  if ("hasItem" in condition) return runtime.inventory.includes(condition.hasItem as string);

  if ("var" in condition) {
    const v = runtime.state[condition.var as string];
    if ("eq" in condition) return v === condition.eq;
    if ("ne" in condition) return v !== condition.ne;
    if ("neq" in condition) return v !== condition.neq;
    if ("gt" in condition) return Number(v) > Number(condition.gt);
    if ("gte" in condition) return Number(v) >= Number(condition.gte);
    if ("lt" in condition) return Number(v) < Number(condition.lt);
    if ("lte" in condition) return Number(v) <= Number(condition.lte);
    // `var` on its own is a truthiness test.
    return Boolean(v);
  }

  // No recognised key: fail closed rather than open.
  return false;
}
