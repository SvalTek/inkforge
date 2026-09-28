import type { ItemAction, ItemActionRuntimeState } from "../types/index.ts";

/**
 * Item-action visibility, the third player-facing trigger surface.
 *
 * A UI element hides through `runtime.ui.hidden` and a tool through its own `hidden`
 * flag. An item action had neither, so it got a state of its own here rather than being
 * folded into one of those under a namespaced key — the key would then have been the
 * only way to address it, and `GameUI.hide` would have looked like it worked.
 *
 * Kept separate from the render for the same reason the other two are: withdrawal is
 * state, and state has to be addressable. {@link setItemActionHidden} is what a
 * conversation uses to withdraw a surface and what Lua uses to put it back.
 */

/**
 * The address of an authored item action: `<definitionId>.<actionId>`.
 *
 * The authored identity rather than the instance's, because the flag and the Lua call
 * are both written against the definition — an action belongs to the kind of thing, not
 * to one particular copy of it in the pack.
 */
export function itemActionId(definitionId: string, actionId: string): string {
  return `${definitionId}.${actionId}`;
}

/**
 * Withhold or restore an item action.
 *
 * The same semantics as `setToolHidden` and `GameUI.hide`, deliberately: idempotent, and
 * not a statement about whether the action may still *run*. A withheld action is still
 * reachable from a directive or a `call:`, which is the point — what changes is what
 * the player is offered.
 */
export function setItemActionHidden(state: ItemActionRuntimeState, id: string, hidden: boolean): void {
  if (hidden) state.hidden.add(id);
  else state.hidden.delete(id);
}

/** Whether an action is currently withheld. */
export function itemActionHidden(state: ItemActionRuntimeState, action: ItemAction, definitionId: string): boolean {
  return state.hidden.has(itemActionId(definitionId, action.id));
}
