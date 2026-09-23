import type {
  ApplyUiFn,
  Directive,
  DirectiveList,
  EngineRuntime,
  IncDecSpec,
  OutputFn,
  Scenario,
} from "../types/index.ts";
import { check } from "./conditions.ts";

export interface DirectiveDeps {
  runtime: EngineRuntime;
  getScenario(): Scenario | null;
  output: OutputFn;
  applyUi: ApplyUiFn;
}

export function lines(value: DirectiveList | undefined): Directive[] {
  return Array.isArray(value) ? value : ([value].filter((v) => v !== undefined && v !== null) as Directive[]);
}

export function itemName(scenario: Scenario | null, id: string): string {
  const instance = scenario?.instances?.item?.[id] || {};
  const definition = scenario?.definitions?.item?.[instance.def as string] || {};
  return definition.name || id;
}

export function move(id: string, deps: DirectiveDeps): void {
  const scenario = deps.getScenario();
  const location = scenario?.locations?.[id];
  if (!location) {
    deps.output(`Unknown location: ${id}`, "error");
    return;
  }
  deps.runtime.location = id;
  deps.runtime.conversation = null;
  deps.runtime.events.push({ type: "location:enter", locationId: id });
  execute(location.text, deps);
}

export function execute(list: DirectiveList | undefined, deps: DirectiveDeps): void {
  for (const x of lines(list)) {
    if (typeof x === "string") {
      deps.output(x);
      continue;
    }
    if (!x || typeof x !== "object") continue;
    if (x.text !== undefined) {
      deps.output(x.text);
      continue;
    }
    if (x.set) {
      Object.assign(deps.runtime.state, x.set);
      continue;
    }
    if (x.inc || x.dec) {
      const p = (x.inc || x.dec) as IncDecSpec;
      const k = p.var || Object.keys(p)[0];
      const by = p.by ?? (p.var ? 1 : p[k]);
      deps.runtime.state[k] = (Number(deps.runtime.state[k]) || 0) + (x.inc ? (by as number) : -(by as number));
      continue;
    }
    if (x.give) {
      const id = typeof x.give === "string" ? x.give : x.give.id;
      if (id && !deps.runtime.inventory.includes(id)) {
        deps.runtime.inventory.push(id);
        deps.runtime.events.push({ type: "inventory:add", itemId: id });
      }
      continue;
    }
    if (x.remove) {
      const id = (typeof x.remove === "string" ? x.remove : x.remove.id) as string;
      deps.runtime.inventory = deps.runtime.inventory.filter((v) => v !== id);
      deps.runtime.events.push({ type: "inventory:remove", itemId: id });
      continue;
    }
    if (x.goto) {
      move(x.goto, deps);
      continue;
    }
    if (x.ui) {
      deps.applyUi(x.ui);
      continue;
    }
    if (x.if) {
      execute(check(x.if, deps.runtime) ? x.then : x.else, deps);
      continue;
    }
    if (x.end) {
      deps.runtime.over = true;
      deps.runtime.events.push({ type: "game:over" });
    }
  }
}
