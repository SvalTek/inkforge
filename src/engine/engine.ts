import type {
  AvailableAction,
  Condition,
  DirectiveList,
  EngineApi,
  EngineDeps,
  ExecutionContext,
  ExitValue,
} from "../types/index.ts";
import { check as checkCondition } from "./conditions.ts";
import { chooseOption, conversationOptions, discoverableTalks, startConversation } from "./conversation.ts";
import {
  createDirectiveDeps,
  type DirectiveDeps,
  execute as executeDirectives,
  itemName,
  move as moveTo,
} from "./directives.ts";
import { clearTranscript } from "./events.ts";

/**
 * Build the engine API over a set of host dependencies.
 *
 * `dirDeps` is accepted rather than only derived so the host that also needs the
 * directive surface — the Lua bindings, which expose `GameConversations` — can build
 * it once and hand over the same object. Two views over the same dependencies behave
 * identically today, because every field is a function or the one runtime, but
 * "behaves identically" is not the property worth relying on: it is the drift that
 * the phrase "the same call rather than two that could drift" is actually about.
 */
export function createEngine(deps: EngineDeps, dirDeps: DirectiveDeps = createDirectiveDeps(deps)): EngineApi {
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
    // A conversation owns the choice list while it runs. Offering "North" beside the
    // answer to a question would let the player walk away mid-exchange, and there
    // would be no way back to the conversation they were in.
    if (deps.runtime.conversation) {
      return conversationOptions(dirDeps).map((option) => ({
        text: option.text,
        cmd: "",
        conversation: { optionId: option.id },
      }));
    }
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
    // Ambient, so after the location's own deliberate actions and before picking
    // things up: walking into a room should offer the person in it, without that
    // outranking an exit the author ordered or a "Take" the player did not ask about.
    // Carried as a payload rather than a dispatched command, so that a location
    // action whose own id happens to begin `talk:` cannot be mistaken for one.
    for (const talk of discoverableTalks(deps.runtime, scenario, deps.runtime.location, deps.output)) {
      out.push({ text: talk.label, cmd: "", talk: { conversationId: talk.conversationId } });
    }
    for (const id of loc.items || []) {
      if (!deps.runtime.inventory.includes(id)) {
        out.push({ text: `Take ${itemName(scenario, id)}`, cmd: `take ${id}` });
      }
    }
    return out;
  }

  async function dispatch(raw: string): Promise<void> {
    const cmd = raw.trim();
    const lower = cmd.toLowerCase();
    if (!cmd || deps.runtime.over) return;
    // A conversation owns the player's attention while it runs, and the command box
    // is hidden for the duration — so this is a backstop rather than the usual path.
    // Silent, like the `over` guard above it: there is nothing to tell the player
    // about a key they cannot press.
    if (deps.runtime.conversation) return;
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

  /**
   * Take a conversation option.
   *
   * Deliberately does not repaint: the conversation functions mark the view dirty
   * through the ordinary funnels, and the caller flushes once for the whole
   * invocation — the same arrangement the inventory inspector uses, so a fast
   * second click cannot see a half-applied node.
   */
  async function chooseConversationOption(optionId: string): Promise<void> {
    if (!deps.runtime.conversation || deps.runtime.over) return;
    await chooseOption(optionId, dirDeps);
  }

  /**
   * Begin a conversation, the way a discoverable offer does.
   *
   * Exposed on the API so the renderer can bind the offer to a closure. It is the
   * same call a `talk:` directive makes, so a conversation begun from the choice list
   * and one begun by an action are indistinguishable downstream.
   *
   * Like {@link chooseConversationOption} it does not repaint, for the same reason.
   */
  function beginDiscoverableTalk(conversationId: string): void {
    if (deps.runtime.over) return;
    startConversation(conversationId, dirDeps);
  }

  return { check, move, execute, available, dispatch, chooseConversationOption, beginDiscoverableTalk };
}
