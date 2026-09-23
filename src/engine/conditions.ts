import type { Condition, EngineRuntime } from "../types/index.ts";

export function check(condition: Condition | undefined, runtime: EngineRuntime): boolean {
  if (!condition) return true;
  if (condition.and) return condition.and.every((item) => check(item, runtime));
  if (condition.or) return condition.or.some((item) => check(item, runtime));
  if (condition.not) return !check(condition.not, runtime);
  if (condition.hasItem) return runtime.inventory.includes(condition.hasItem);
  const v = runtime.state[condition.var as string];
  if ("eq" in condition) return v === condition.eq;
  if ("ne" in condition) return v !== condition.ne;
  if ("neq" in condition) return v !== condition.neq;
  if ("gt" in condition) return (v as number) > (condition.gt as number);
  if ("gte" in condition) return (v as number) >= (condition.gte as number);
  if ("lt" in condition) return (v as number) < (condition.lt as number);
  if ("lte" in condition) return (v as number) <= (condition.lte as number);
  return true;
}
