import type { EngineRuntime, Scenario } from "../types/index.ts";
import { itemActionId, setItemActionHidden } from "./item-action-state.ts";
import { setToolHidden } from "./tool-state.ts";

/**
 * Withholding the surfaces an author marked `allowInConversation: false`.
 *
 * A conversation hides them when it starts and shows them again when it ends, through
 * each surface's own hidden state. That is the whole design, and it is worth being
 * explicit about why it is done this way rather than filtered at render time: because
 * the surfaces are then hidden *as far as the rest of the engine is concerned*.
 * `GameUI.show`, `GameTools.show` and `GameItemActions.show` all address the same state
 * and can put one back for a single exchange, and a save records it. A parallel filter
 * would have had none of that — it would have been a second notion of "shown" that no
 * other code could see or reach.
 *
 * The three surfaces are UI elements, tools and item actions. A modal is not one: a
 * modal only exists because a tool or a button opened it, so the decision belongs to
 * whatever opened it. Neither are exits, location actions or conversation options,
 * because a conversation owns the choice list outright and there is nothing to withdraw
 * from it.
 */

/**
 * What the current conversation withdrew, so that only those are handed back.
 *
 * Keyed on the runtime rather than kept on it, so it is not part of a save snapshot and
 * cannot desynchronise from one. A loaded run starts clean, which is right: a withdrawal
 * belongs to the conversation that caused it, and a resumed conversation has not run.
 */
const withdrawnByConversation = new WeakMap<EngineRuntime, Set<string>>();

/** Namespaced so a UI element id and a tool id can never collide in one set. */
const toolKey = (id: string): string => `tool:${id}`;
const itemActionKey = (id: string): string => `itemaction:${id}`;

/**
 * Hide the flagged surfaces for the duration of a conversation.
 *
 * Records only the ones it actually hid. An author who has already hidden a surface
 * themselves keeps it hidden afterwards, because "hand back what I took" must not become
 * "hand back everything I was asked about" — that would quietly un-hide a control the
 * author had deliberately withdrawn for an unrelated reason.
 */
export function withdrawExcludedSurfaces(runtime: EngineRuntime, scenario: Scenario | null): void {
  if (!scenario) return;
  const taken = new Set<string>();

  for (const element of scenario.ui?.elements || []) {
    if (element?.allowInConversation !== false) continue;
    if (runtime.ui.hidden.has(element.id)) continue;
    runtime.ui.hidden.add(element.id);
    taken.add(element.id);
  }

  for (const [id, entry] of runtime.tools.entries) {
    if (entry.definition.allowInConversation !== false) continue;
    if (entry.hidden) continue;
    setToolHidden(runtime.tools, id, true);
    taken.add(toolKey(id));
  }

  for (const [definitionId, definition] of Object.entries(scenario.definitions?.item || {})) {
    for (const action of definition?.actions || []) {
      if (action?.allowInConversation !== false) continue;
      const key = itemActionKey(itemActionId(definitionId, action.id));
      if (runtime.items.hidden.has(itemActionId(definitionId, action.id))) continue;
      setItemActionHidden(runtime.items, itemActionId(definitionId, action.id), true);
      taken.add(key);
    }
  }

  if (taken.size) withdrawnByConversation.set(runtime, taken);
}

/**
 * Hand back the surfaces the current conversation withdrew.
 *
 * A no-op when nothing is outstanding, which is what makes it safe to call from every
 * path that ends a conversation — including paths that never started one.
 */
export function restoreExcludedSurfaces(runtime: EngineRuntime): void {
  const taken = withdrawnByConversation.get(runtime);
  if (!taken) return;
  withdrawnByConversation.delete(runtime);
  for (const key of taken) {
    if (key.startsWith("tool:")) {
      setToolHidden(runtime.tools, key.slice("tool:".length), false);
    } else if (key.startsWith("itemaction:")) {
      setItemActionHidden(runtime.items, key.slice("itemaction:".length), false);
    } else {
      runtime.ui.hidden.delete(key as string);
    }
  }
}

/**
 * Begin a conversation's withdrawal: hand back any outstanding one, then take again.
 *
 * The restore-first is not tidiness. A `talk:` inside an option's `then` replaces the
 * running conversation, so `startConversation` is reached with a withdrawal already
 * outstanding; withdrawing on top of that would record nothing (everything is already
 * hidden) and the first conversation's set would then be handed back at the wrong time.
 */
export function withdrawForConversation(runtime: EngineRuntime, scenario: Scenario | null): void {
  restoreExcludedSurfaces(runtime);
  withdrawExcludedSurfaces(runtime, scenario);
}
