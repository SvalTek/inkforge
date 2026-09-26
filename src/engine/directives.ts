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
import { markViewDirty, pushEvent } from "./events.ts";
import { addItem, adjustState, removeItem, setLocation, setState } from "./state.ts";

export interface DirectiveDeps {
  runtime: EngineRuntime;
  getScenario(): Scenario | null;
  output: OutputFn;
  applyUi: ApplyUiFn;
  /**
   * Run a named Lua function with the given params.
   *
   * The engine is synchronous except for this: `call`/`emit` are the only
   * directives that reach into Lua, and the bridge is async. Awaiting them
   * inline keeps authored ordering correct — a statement after `call:` runs
   * after it, not before it.
   */
  invokeLua(name: string, params: Record<string, unknown>): Promise<void>;
  /**
   * Emit a named event to Lua subscribers.
   *
   * Synchronous in practice, but typed as possibly-async so the inline `await`
   * in `execute` keeps its ordering guarantee if that ever stops being true.
   */
  emitEvent(name: string, data: Record<string, unknown>): void | Promise<void>;
}

export function lines(value: DirectiveList | undefined): Directive[] {
  return Array.isArray(value) ? value : ([value].filter((v) => v !== undefined && v !== null) as Directive[]);
}

export function itemName(scenario: Scenario | null, id: string): string {
  const instance = scenario?.instances?.item?.[id] || {};
  const definition = scenario?.definitions?.item?.[instance.def as string] || {};
  return definition.name || id;
}

export async function move(id: string, deps: DirectiveDeps): Promise<void> {
  const scenario = deps.getScenario();
  const location = scenario?.locations?.[id];
  if (!location) {
    deps.output(`Unknown location: ${id}`, "error");
    return;
  }
  setLocation(deps.runtime, id);
  await execute(location.text, deps);
}

/** The recognised directive keys, used for validation diagnostics. */
export const DIRECTIVE_KEYS = [
  "text",
  "set",
  "inc",
  "dec",
  "give",
  "remove",
  "goto",
  "ui",
  "if",
  "end",
  "call",
  "emit",
] as const;

export async function execute(list: DirectiveList | undefined, deps: DirectiveDeps): Promise<void> {
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
      for (const [path, value] of Object.entries(x.set)) setState(deps.runtime, path, value);
      continue;
    }
    if (x.inc || x.dec) {
      const p = (x.inc || x.dec) as IncDecSpec;
      const k = p.var || Object.keys(p)[0];
      const by = p.by ?? (p.var ? 1 : p[k]);
      adjustState(deps.runtime, k, x.inc ? Number(by) : -Number(by));
      continue;
    }
    if (x.give) {
      const id = typeof x.give === "string" ? x.give : x.give.id;
      if (id) addItem(deps.runtime, id);
      continue;
    }
    if (x.remove) {
      removeItem(deps.runtime, (typeof x.remove === "string" ? x.remove : x.remove.id) as string);
      continue;
    }
    if (x.goto) {
      await move(x.goto, deps);
      continue;
    }
    if (x.ui) {
      deps.applyUi(x.ui);
      continue;
    }
    if (x.call) {
      await deps.invokeLua(x.call, x.params || {});
      continue;
    }
    if (x.emit) {
      await deps.emitEvent(x.emit, x.data || {});
      continue;
    }
    if (x.if) {
      await execute(check(x.if, deps.runtime) ? x.then : x.else, deps);
      continue;
    }
    if (x.end) {
      deps.runtime.over = true;
      pushEvent(deps.runtime, { type: "game:over" });
      // `over` drops every remaining choice, so the list on screen is stale.
      markViewDirty(deps.runtime);
    }
  }
}
