import type {
  AvailableAction,
  AvailableInventoryAction,
  Condition,
  DirectiveList,
  EngineApi,
  EngineDeps,
  ExecutionContext,
  ExitValue,
  ItemAction,
} from "../types/index.ts";
import { check as checkCondition } from "./conditions.ts";
import type { DirectiveDeps } from "./directives.ts";
import { execute as executeDirectives, itemName, move as moveTo } from "./directives.ts";
import { clearTranscript } from "./events.ts";

export function createEngine(deps: EngineDeps): EngineApi {
  const dirDeps: DirectiveDeps = {
    runtime: deps.runtime,
    getScenario: deps.getScenario,
    output: deps.output,
    applyUi: deps.applyUi,
    invokeLua: deps.invokeLua,
    emitEvent: deps.emitEvent,
  };
  let inventoryActionRunning = false;
  const scheduledInventoryActions: { itemId: string; actionId: string }[] = [];
  let inventoryActionDrainScheduled = false;
  let inventoryActionTimer: number | undefined;
  let isShutdown = false;

  function check(c: Condition | undefined, context?: ExecutionContext): boolean {
    return checkCondition(c, deps.runtime, context);
  }

  async function move(id: string, context?: ExecutionContext): Promise<void> {
    await moveTo(id, dirDeps, context);
  }

  async function execute(list: DirectiveList | undefined, context?: ExecutionContext): Promise<void> {
    await executeDirectives(list, dirDeps, context);
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

  function resolveInventoryAction(
    itemId: string,
    actionId: string,
  ): { action: ItemAction; context: ExecutionContext } | null {
    if (deps.runtime.over || !deps.runtime.inventory.includes(itemId)) return null;
    const scenario = deps.getScenario();
    const definitionId = scenario?.instances?.item?.[itemId]?.def;
    const definition = definitionId === undefined ? undefined : scenario?.definitions?.item?.[definitionId];
    const action = definition?.actions?.find((candidate) => candidate.id === actionId);
    if (definitionId === undefined || !definition || !action) return null;
    const context = { item: { id: itemId, definitionId, actionId } };
    return check(action.if, context) ? { action, context } : null;
  }

  function inventoryActions(itemId: string): AvailableInventoryAction[] {
    if (deps.runtime.over || !deps.runtime.inventory.includes(itemId)) return [];
    const scenario = deps.getScenario();
    const definitionId = scenario?.instances?.item?.[itemId]?.def;
    const definition = definitionId === undefined ? undefined : scenario?.definitions?.item?.[definitionId];
    if (definitionId === undefined || !definition) return [];
    return (definition.actions || [])
      .filter((action) => check(action.if, { item: { id: itemId, definitionId, actionId: action.id } }))
      .map((action) => ({ id: action.id, label: action.label || action.id }));
  }

  async function runInventoryAction(itemId: string, actionId: string): Promise<boolean> {
    if (isShutdown || inventoryActionRunning) return false;
    const resolved = resolveInventoryAction(itemId, actionId);
    if (!resolved) return false;
    inventoryActionRunning = true;
    try {
      await execute(resolved.action.then, resolved.context);
      return true;
    } finally {
      inventoryActionRunning = false;
      deps.render();
    }
  }

  function drainScheduledInventoryActions(): void {
    inventoryActionTimer = setTimeout(() => {
      inventoryActionTimer = undefined;
      void (async () => {
        try {
          while (!isShutdown && scheduledInventoryActions.length) {
            const next = scheduledInventoryActions.shift()!;
            await runInventoryAction(next.itemId, next.actionId);
          }
        } finally {
          inventoryActionDrainScheduled = false;
          if (!isShutdown && scheduledInventoryActions.length) drainScheduledInventoryActions();
        }
      })();
    }, 0);
  }

  function triggerInventoryAction(itemId: string, actionId: string): void {
    if (isShutdown) return;
    scheduledInventoryActions.push({ itemId, actionId });
    if (inventoryActionDrainScheduled) return;
    inventoryActionDrainScheduled = true;
    // Lua host calls must unwind before an item action can reach a `call:`
    // directive and enter the bridge again.
    drainScheduledInventoryActions();
  }

  function shutdown(): void {
    isShutdown = true;
    scheduledInventoryActions.length = 0;
    if (inventoryActionTimer !== undefined) clearTimeout(inventoryActionTimer);
    inventoryActionTimer = undefined;
  }

  async function dispatch(raw: string): Promise<void> {
    const cmd = raw.trim();
    const lower = cmd.toLowerCase();
    if (!cmd || deps.runtime.over) return;
    // The turn boundary. Resetting the discard count with the entries is what
    // keeps a fresh turn from inheriting an elision notice it no longer needs.
    clearTranscript(deps.runtime);
    try {
      if (["look", "l"].includes(lower)) {
        await execute(deps.getScenario()?.locations?.[deps.runtime.location]?.text);
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
          await move(typeof e === "string" ? e : (e.to ?? ""));
        } else {
          deps.output("That way is not available.", "warning");
        }
        return;
      }
      if (lower.startsWith("take ")) {
        const q = lower.slice(5);
        const id = (loc.items || []).find((x) => x === q || itemName(scenario, x).toLowerCase() === q);
        if (id) {
          await execute({ give: id });
          loc.items = (loc.items as string[]).filter((x) => x !== id);
          deps.output(`Taken: ${itemName(scenario, id)}.`);
          return;
        }
      }
      if (lower.startsWith("@")) {
        const a = (loc.actions || []).find((x) => x.id === lower.slice(1));
        if (a && check(a.if)) {
          await execute(a.then);
          return;
        }
      }
      deps.output(`Unknown command: ${cmd}`, "warning");
    } finally {
      // The directives marked the view dirty as they mutated; this flushes those
      // marks once for the whole command, so a command that changes five things
      // repaints once and one that changes nothing does not repaint at all.
      deps.render();
    }
  }

  return {
    check,
    move,
    execute,
    available,
    inventoryActions,
    runInventoryAction,
    triggerInventoryAction,
    shutdown,
    dispatch,
  };
}
