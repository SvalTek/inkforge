import type {
  ConversationExecutionContext,
  ConversationNode,
  ConversationOption,
  ConversationState,
  EngineRuntime,
  ExecutionContext,
  Scenario,
} from "../types/index.ts";
import { check } from "./conditions.ts";
import { type DirectiveDeps, execute } from "./directives.ts";
import { markViewDirty } from "./events.ts";

/**
 * The conversation state machine.
 *
 * Takes {@link DirectiveDeps} rather than `EngineApi`, and that is the load-bearing
 * decision here. `execute()` already holds a `DirectiveDeps`, so the `talk:`
 * directive can call straight in; a Lua entry point later needs one type threaded
 * through the bindings rather than the engine reshaped around a new dependency.
 *
 * This module and `directives.ts` import each other — `execute` needs `talk:`, and
 * an option's `then` needs `execute`. That is deliberate and safe: both sides export
 * hoisted function declarations and neither calls the other while its module body
 * runs, so there is nothing for the cycle to leave undefined.
 *
 * A conversation is **position, not transcript**. Spoken lines go out through
 * `output`, which means they are capped, restorable and renderable by the machinery
 * that already handles prose, and the exchange survives across turns. Holding a log
 * here instead would have meant a second, parallel version of all three.
 */

/** The speaker name for the player, who has no authored definition of their own. */
const PLAYER_SPEAKER = "player";

/** Whether the player is currently in a conversation. */
export function inConversation(runtime: EngineRuntime): boolean {
  return runtime.conversation !== null;
}

/**
 * Leave whatever conversation is running.
 *
 * Idempotent, because almost every caller reaches it as a fallback: a `goto` in a
 * directive has already ended the conversation by way of `setLocation`, and ending
 * it twice must not repaint for nothing.
 */
export function endConversation(runtime: EngineRuntime): void {
  if (runtime.conversation === null) return;
  runtime.conversation = null;
  markViewDirty(runtime);
}

/**
 * Resolve a speaker to something printable: an NPC instance's name, or the player.
 *
 * Falls back to the raw id rather than printing nothing, so a speaker naming an NPC
 * that has gone missing still shows *which* one rather than an empty line.
 */
export function speakerName(scenario: Scenario | null, speaker: string): string {
  if (speaker === PLAYER_SPEAKER) return "You";
  const definitionId = scenario?.instances?.npc?.[speaker]?.def;
  const name = definitionId === undefined ? undefined : scenario?.npcs?.[definitionId]?.name;
  return name || speaker;
}

/**
 * The execution context for a conversation, merged onto whatever was already running.
 *
 * Merging rather than replacing is what lets an item action start a conversation and
 * still have its nested conditions and directives know which item invoked them.
 */
function conversationContext(
  scenario: Scenario | null,
  state: ConversationState,
  base?: ExecutionContext,
  optionId?: string,
): ExecutionContext {
  const conversation: ConversationExecutionContext = {
    id: state.id,
    nodeId: state.nodeId,
    optionId,
    participants: scenario?.conversations?.[state.id]?.participants || [],
  };
  return { ...base, conversation };
}

/**
 * Speak a node's lines.
 *
 * A line is a plain string with its speaker in front, because drawing a portrait
 * beside a name is the author's job — through a canvas scene or a UI element — and
 * an engine that invented a shape for it would be one more thing to unpick later.
 */
function emitNode(
  scenario: Scenario | null,
  node: ConversationNode,
  deps: DirectiveDeps,
  context: ExecutionContext,
): void {
  for (const line of node.dialogue || []) {
    if (line.if !== undefined && !check(line.if, deps.runtime, context)) continue;
    deps.output(`${speakerName(scenario, line.speaker)}: ${line.text}`);
  }
}

/** The current node's options whose condition passes, in authored order. */
function optionsAt(
  runtime: EngineRuntime,
  scenario: Scenario | null,
  state: ConversationState,
  base?: ExecutionContext,
): ConversationOption[] {
  const node = scenario?.conversations?.[state.id]?.nodes?.[state.nodeId];
  if (!node) return [];
  const context = conversationContext(scenario, state, base);
  return (node.options || []).filter((option) => check(option.if, runtime, context));
}

/** The options of the current node whose condition passes, in authored order. */
export function conversationOptions(
  deps: DirectiveDeps,
  base?: ExecutionContext,
): ConversationOption[] {
  const state = deps.runtime.conversation;
  return state ? optionsAt(deps.runtime, deps.getScenario(), state, base) : [];
}

/**
 * Whether a node has any option the player could take right now.
 *
 * Separate from {@link conversationOptions} so a caller that only needs the answer
 * does not have to be handed a whole `DirectiveDeps` — the boot path, which has a
 * runtime and a scenario but no directive seams yet, needs exactly this.
 */
export function nodeHasAvailableOption(
  runtime: EngineRuntime,
  scenario: Scenario | null,
  state: ConversationState,
  base?: ExecutionContext,
): boolean {
  return optionsAt(runtime, scenario, state, base).length > 0;
}

/**
 * End the conversation if the current node has nothing left to answer.
 *
 * The invariant is that the player is in a conversation *exactly while* there is
 * something to say to them, and settling on node entry is not enough to keep it: a
 * Lua timer, an item action or a UI control can close every remaining gate while
 * they are still deliberating. Without this, the choice list empties, both command
 * boxes stay hidden, and a one-way state change leaves the run with no way forward.
 *
 * Idempotent, and convergent: ending marks the view dirty, the gate repaints, and by
 * the next pass there is no conversation left to settle.
 */
export function settleConversation(runtime: EngineRuntime, scenario: Scenario | null): void {
  const state = runtime.conversation;
  if (!state) return;
  if (
    !scenario?.conversations?.[state.id]?.nodes?.[state.nodeId] || !nodeHasAvailableOption(runtime, scenario, state)
  ) {
    endConversation(runtime);
  }
}

/**
 * Move to a node, speak it, and settle.
 *
 * "Settle" is the part worth stating plainly: **a node with no visible option ends
 * the conversation.** The alternative — holding a node the player cannot answer —
 * is a soft-lock, because the command box is hidden for the duration and there is
 * nothing left to press. So a terminal beat, and a node whose options are all gated
 * shut, both simply return the player to the room. See `docs/authoring/conversations.md`.
 */
function enterNode(id: string, nodeId: string, deps: DirectiveDeps, base?: ExecutionContext): void {
  const scenario = deps.getScenario();
  const node = scenario?.conversations?.[id]?.nodes?.[nodeId];
  if (!node) {
    // Named rather than ignored: a node that is not there is an authoring mistake,
    // and holding a conversation whose node cannot be read would strand the player.
    deps.output(`Unknown conversation node: ${id}/${nodeId}`, "error");
    endConversation(deps.runtime);
    return;
  }
  const state: ConversationState = { id, nodeId };
  deps.runtime.conversation = state;
  const context = conversationContext(scenario, state, base);
  emitNode(scenario, node, deps, context);
  if (conversationOptions(deps, context).length === 0) {
    endConversation(deps.runtime);
    return;
  }
  markViewDirty(deps.runtime);
}

/**
 * Start a conversation at its `start` node.
 *
 * Starting one while another is running replaces it rather than nesting: a `talk:`
 * is a cut, which is how a branching IF moves between scenes. Nesting would need a
 * stack, and nothing in the authored shape asks for one.
 */
export function startConversation(id: string, deps: DirectiveDeps, context?: ExecutionContext): void {
  const conversation = deps.getScenario()?.conversations?.[id];
  if (!conversation) {
    deps.output(`Unknown conversation: ${id}`, "error");
    endConversation(deps.runtime);
    return;
  }
  enterNode(id, conversation.start, deps, context);
}

/**
 * Take an option: run its directives, then continue, cut, or finish.
 *
 * The condition is re-checked here rather than trusted from the offered list, because
 * an awaited Lua call in an earlier option can have closed the gate. An option that
 * is no longer available is then simply not taken — not a mistake worth reporting,
 * since the player choosing something that closed while they deliberated is ordinary.
 */
export async function chooseOption(
  optionId: string,
  deps: DirectiveDeps,
  base?: ExecutionContext,
): Promise<void> {
  const state = deps.runtime.conversation;
  if (!state) return;
  const scenario = deps.getScenario();
  const node = scenario?.conversations?.[state.id]?.nodes?.[state.nodeId];
  const option = (node?.options || []).find((candidate) => candidate.id === optionId);
  if (!option) {
    deps.output(`Unknown conversation option: ${optionId}`, "error");
    return;
  }
  const context = conversationContext(scenario, state, base, option.id);
  if (!check(option.if, deps.runtime, context)) return;

  // Identity, not id: a `talk:` inside `then` that targets the conversation already
  // running replaces the state with a new object carrying the same id, and the rule
  // is that such a cut wins. Comparing ids alone would miss it and let this option's
  // own `next` overwrite the exchange that was just started.
  const before = deps.runtime.conversation;
  await execute(option.then, deps, context);

  // `then` is arbitrary authored content and may have ended the run, moved the
  // player, or cut to another conversation. Any of those is the outcome, and
  // continuing into `next` on top of it would resurrect a scene the author left.
  if (deps.runtime.over || deps.runtime.conversation !== before) return;

  if (option.talk !== undefined) {
    startConversation(option.talk, deps, context);
    return;
  }
  if (option.next !== undefined) {
    enterNode(state.id, option.next, deps, context);
    return;
  }
  // Neither a node nor a cut, so this choice ends the exchange. Which is why an
  // option needs no `end` key of its own to finish a conversation.
  endConversation(deps.runtime);
}
