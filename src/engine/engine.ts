import type { AvailableAction, Condition, DirectiveList, EngineApi, EngineDeps, ExitValue } from "../types/index.ts";
import { check as checkCondition } from "./conditions.ts";
import type { DirectiveDeps } from "./directives.ts";
import { execute as executeDirectives, itemName, move as moveTo } from "./directives.ts";

export function createEngine(deps: EngineDeps): EngineApi {
  const dirDeps: DirectiveDeps = {
    runtime: deps.runtime,
    getScenario: deps.getScenario,
    output: deps.output,
    applyUi: deps.applyUi,
  };

  function check(c: Condition | undefined): boolean {
    return checkCondition(c, deps.runtime);
  }

  function move(id: string): void {
    moveTo(id, dirDeps);
  }

  function execute(list: DirectiveList | undefined): void {
    executeDirectives(list, dirDeps);
  }

  function available(): AvailableAction[] {
    const scenario = deps.getScenario();
    const loc = scenario?.locations?.[deps.runtime.location] || {};
    const out: AvailableAction[] = [];
    for (const [d, e] of Object.entries(loc.exits || {}) as [string, ExitValue][]) {
      if (check(typeof e === "string" ? undefined : e.if)) {
        out.push({ text: d[0].toUpperCase() + d.slice(1), cmd: d });
      }
    }
    for (const a of loc.actions || []) {
      if (check(a.if)) out.push({ text: a.label || a.id, cmd: `@${a.id}` });
    }
    for (const id of loc.items || []) {
      if (!deps.runtime.inventory.includes(id)) {
        out.push({ text: `Take ${itemName(scenario, id)}`, cmd: `take ${id}` });
      }
    }
    return out;
  }

  function dispatch(raw: string): void {
    const cmd = raw.trim();
    const lower = cmd.toLowerCase();
    if (!cmd || deps.runtime.over) return;
    deps.runtime.events = [];
    if (["look", "l"].includes(lower)) {
      execute(deps.getScenario()?.locations?.[deps.runtime.location]?.text);
      deps.render();
      return;
    }
    const scenario = deps.getScenario();
    const loc = scenario?.locations?.[deps.runtime.location] || {};
    const exit = (Object.entries(loc.exits || {}) as [string, ExitValue][]).find(
      ([d, e]) => d === lower || (typeof e === "object" && (e.aliases || []).includes(lower)),
    );
    if (exit) {
      const e = exit[1];
      if (check(typeof e === "string" ? undefined : e.if)) {
        move(typeof e === "string" ? e : (e.to ?? ""));
      } else {
        deps.output("That way is not available.", "warning");
      }
      deps.render();
      return;
    }
    if (lower.startsWith("take ")) {
      const q = lower.slice(5);
      const id = (loc.items || []).find((x) => x === q || itemName(scenario, x).toLowerCase() === q);
      if (id) {
        execute({ give: id });
        loc.items = (loc.items as string[]).filter((x) => x !== id);
        deps.output(`Taken: ${itemName(scenario, id)}.`);
        deps.render();
        return;
      }
    }
    if (lower.startsWith("@")) {
      const a = (loc.actions || []).find((x) => x.id === lower.slice(1));
      if (a && check(a.if)) {
        execute(a.then);
        deps.render();
        return;
      }
    }
    deps.output(`Unknown command: ${cmd}`, "warning");
    deps.render();
  }

  return { check, move, execute, available, dispatch };
}
