import type { Condition, EngineRuntime, ExecutionContext } from "../types/index.ts";
import { itemStatePath } from "./state.ts";

function compare(value: unknown, condition: Condition): boolean {
  if ("eq" in condition) return value === condition.eq;
  if ("ne" in condition) return value !== condition.ne;
  if ("neq" in condition) return value !== condition.neq;
  if ("gt" in condition) return Number(value) > Number(condition.gt);
  if ("gte" in condition) return Number(value) >= Number(condition.gte);
  if ("lt" in condition) return Number(value) < Number(condition.lt);
  if ("lte" in condition) return Number(value) <= Number(condition.lte);
  return Boolean(value);
}

/**
 * Evaluate a condition.
 *
 * Unrecognised keys evaluate to **false**, not true. A misspelled `hasitem`
 * used to read as "always pass", silently opening gates — the worst possible
 * default for a condition language. `validateScenario` reports the typo at load
 * time; this is the runtime backstop that keeps it closed if one slips through.
 */
export function check(
  condition: Condition | undefined,
  runtime: EngineRuntime,
  context?: ExecutionContext,
): boolean {
  if (!condition) return true;
  if (condition.and) return condition.and.every((item) => check(item, runtime, context));
  if (condition.or) return condition.or.some((item) => check(item, runtime, context));
  if (condition.not) return !check(condition.not, runtime, context);
  if ("hasItem" in condition) return runtime.inventory.includes(condition.hasItem as string);

  if ("var" in condition) {
    return compare(runtime.state[condition.var as string], condition);
  }

  if ("itemVar" in condition) {
    const path = itemStatePath(context, condition.itemVar as string);
    return path ? compare(runtime.state[path], condition) : false;
  }

  // No recognised key: fail closed rather than open.
  return false;
}
