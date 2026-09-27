import type { AppContext } from "../app/context.ts";
import type {
  AvailableAction,
  EngineEvent,
  ExecutionContext,
  ItemAction,
  ResolvedUiElement,
  Scenario,
  UiActivation,
} from "../types/index.ts";
import { itemName } from "../engine/directives.ts";
import { uiElement } from "../engine/ui-state.ts";
import { $all } from "../app/dom.ts";
import { renderModals } from "./modals.ts";
import { renderTools } from "./tools.ts";
import { isBlockText, renderBlocks, renderInline } from "./markdown.ts";
import { projectTitle } from "../project/project.ts";

type OutputEvent = Extract<EngineEvent, { type: "output" }>;

const terminalFollowTail = new WeakMap<HTMLElement, boolean>();
const selectedInventoryItem = new WeakMap<AppContext, string>();

/** Track whether the player is following new output or reading older lines. */
function shouldFollowTail(terminal: HTMLElement): boolean {
  if (!terminalFollowTail.has(terminal)) {
    terminalFollowTail.set(terminal, true);
    terminal.addEventListener("scroll", () => {
      const remaining = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
      terminalFollowTail.set(terminal, remaining <= 2);
    }, { passive: true });
  }
  return terminalFollowTail.get(terminal) ?? true;
}

/**
 * Authored strings (scenario text, labels, commands, event payloads) are
 * untrusted: every value is written through `textContent`/`dataset`, or through
 * `./markdown.ts` — the one renderer, configured so raw markup stays literal —
 * and never parsed into active elements.
 */
function outputEntry(event: OutputEvent, isLatest: boolean): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = `entry ${event.kind || ""}`;
  if (isLatest) {
    const label = document.createElement("b");
    label.textContent = "NOW";
    entry.append(label);
  }
  if (isBlockText(event.text)) {
    // A `|` block scalar is a document: render it whole, list markers and all.
    // Its own container keeps the NOW label above it intact.
    const body = document.createElement("div");
    body.className = "entry-body";
    renderBlocks(body, event.text);
    entry.append(body);
  } else {
    // One line stays one line: inline markdown, so a leading `-` or `#` is prose.
    const paragraph = document.createElement("p");
    renderInline(paragraph, event.text);
    entry.append(paragraph);
  }
  return entry;
}

/**
 * The notice that stands in for transcript the cap discarded.
 *
 * Painted rather than stored as an event, for two reasons: trimming can then
 * never re-elide the marker that reports the trimming, and the count can
 * describe everything dropped this run instead of only what the array holds.
 * `system` is the muted teal the terminal already uses for chrome, so the
 * notice reads as terminal furniture rather than as something the story said.
 */
function elisionEntry(dropped: number): HTMLDivElement {
  const entry = document.createElement("div");
  entry.className = "entry system";
  const note = document.createElement("p");
  const unit = dropped === 1 ? "entry" : "entries";
  note.textContent = `--- ${dropped} earlier ${unit} elided ---`;
  entry.append(note);
  return entry;
}

function choiceButton(choice: AvailableAction): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "choice";
  button.dataset.cmd = choice.cmd;
  button.textContent = choice.text;
  return button;
}

function eventRow(event: EngineEvent, scenario: Scenario | null): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "event";
  const type = document.createElement("b");
  type.textContent = event.type;
  row.append(type);
  if ("itemId" in event && event.itemId) {
    row.append(document.createElement("br"), document.createTextNode(itemName(scenario, event.itemId)));
  }
  return row;
}

function uiButton(element: ResolvedUiElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.dataset.ui = element.id;
  button.textContent = String(element.values.label || element.id);
  return button;
}

function meterRow(element: ResolvedUiElement): HTMLDivElement {
  const value = Number(element.values.value) || 0;
  const max = Number(element.values.max) || 0;
  const percent = max ? Math.max(0, Math.min(100, value / max * 100)) : 0;
  const row = document.createElement("div");
  // The authored id, so a stylesheet can single one meter out of the strip —
  // a row is otherwise anonymous, and there is no other way to reach it.
  // Deliberately not `data-ui`: renderUi() reads that as "control carrying an
  // activate action" and binds a click to it, which a meter is not.
  row.dataset.meter = element.id;
  const label = document.createElement("span");
  label.textContent = String(element.values.label || element.id);
  const valueText = document.createElement("b");
  valueText.textContent = `${value} / ${max}`;
  const track = document.createElement("i");
  const fill = document.createElement("em");
  fill.style.width = `${percent}%`;
  track.append(fill);
  row.append(label, valueText, track);
  return row;
}

/** Paint the terminal, choices, location title and event stream. */
export function render(app: AppContext): void {
  const { dom } = app;
  const runtime = app.runtime!;
  const scenario = app.scenario;
  const loc = scenario?.locations?.[runtime.location] || {};
  const outputEvents = runtime.events.filter((e): e is OutputEvent => e.type === "output");
  const followTail = shouldFollowTail(dom.heroTerminal);
  const entries = outputEvents.map((event, index) => outputEntry(event, index === outputEvents.length - 1));
  // Unshifted after the map so the notice cannot take the NOW badge, which the
  // last *output* entry owns, and so it reaches both terminals below.
  if (runtime.droppedEvents > 0) entries.unshift(elisionEntry(runtime.droppedEvents));
  dom.heroTerminal.replaceChildren(...entries.map((entry) => entry.cloneNode(true) as HTMLDivElement));
  if (followTail && dom.heroTerminal.clientHeight > 0) {
    dom.heroTerminal.scrollTop = dom.heroTerminal.scrollHeight;
  }
  dom.terminal.replaceChildren(...entries);
  const choices = app.engine?.available() ?? [];
  dom.heroChoices.replaceChildren(...choices.map(choiceButton));
  dom.choices.replaceChildren(...choices.map(choiceButton));
  dom.choiceCount.textContent = choices.length ? `${choices.length} AVAILABLE` : "";
  const title = loc.title || scenario?.meta?.title || "";
  renderInline(dom.storyTitle, title);
  dom.title.textContent = projectTitle(app.project);
  dom.runTitle.textContent = dom.title.textContent;
  renderInline(dom.location, title);
  dom.eventLog.replaceChildren(...runtime.events.map((event) => eventRow(event, scenario)));
  renderInventory(app);
  renderUi(app);
  renderTools(app);
  renderModals(app);
  $all<HTMLElement>("[data-cmd]").forEach((button) => {
    button.onclick = () => void app.engine?.dispatch(button.dataset.cmd ?? "");
  });
}

/** Paint the 12 inventory slots and wire each to its inspector. */
export function renderInventory(app: AppContext): void {
  const { dom } = app;
  const slots = Array.from({ length: 12 }, (_, i) => app.runtime?.inventory?.[i] || null);
  dom.inventoryCount.textContent = `${app.runtime?.inventory?.length || 0} / 12`;
  const buttons = slots.map((id, i) => {
    const button = document.createElement("button");
    button.className = `slot ${id ? "occupied" : ""}`;
    button.dataset.slot = String(i);
    const index = document.createElement("span");
    index.textContent = String(i + 1).padStart(2, "0");
    button.append(index);
    if (id) {
      const glyph = document.createElement("b");
      glyph.textContent = "◆";
      button.append(glyph);
    } else {
      button.append(document.createTextNode("+"));
    }
    return button;
  });
  dom.inventorySlots.replaceChildren(...buttons);
  $all<HTMLElement>("[data-slot]").forEach((button) => {
    button.onclick = () => inspectItem(app, Number(button.dataset.slot));
  });
  const selectedId = selectedInventoryItem.get(app);
  if (selectedId) {
    const selectedSlot = app.runtime?.inventory.indexOf(selectedId) ?? -1;
    inspectItem(app, selectedSlot);
  }
}

/** Show one inventory slot's item in the inspector pane. */
export function inspectItem(app: AppContext, slot: number): void {
  const { dom } = app;
  const id = app.runtime!.inventory[slot];
  if (!id) {
    selectedInventoryItem.delete(app);
    dom.itemName.textContent = "";
    dom.itemDescription.textContent = "";
    dom.itemArt.textContent = "";
    dom.itemActions.replaceChildren();
    return;
  }
  const instance = app.scenario?.instances?.item?.[id] || {};
  const definitionId = instance.def as string;
  const definition = app.scenario?.definitions?.item?.[definitionId] || {};
  selectedInventoryItem.set(app, id);
  dom.itemName.textContent = definition.name || id;
  renderBlocks(dom.itemDescription, definition.description || "");
  dom.itemArt.textContent = "◆";
  const actions = (definition.actions || []).filter((action) =>
    app.engine?.check(action.if, itemActionContext(id, definitionId, action.id)) ?? true
  );
  dom.itemActions.replaceChildren(...actions.map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "item-action";
    button.dataset.itemAction = action.id;
    button.textContent = action.label || action.id;
    button.onclick = () => void runItemAction(app, id, definitionId, action);
    return button;
  }));
}

function itemActionContext(itemId: string, definitionId: string, actionId: string): ExecutionContext {
  return { item: { id: itemId, definitionId, actionId } };
}

async function runItemAction(
  app: AppContext,
  itemId: string,
  definitionId: string,
  action: ItemAction,
): Promise<void> {
  const context = itemActionContext(itemId, definitionId, action.id);
  // Conditions may have changed since the inspector was painted.
  if (app.engine?.check(action.if, context) ?? true) await app.engine?.execute(action.then, context);
  app.flushView();
  const selectedSlot = app.runtime?.inventory.indexOf(itemId) ?? -1;
  inspectItem(app, selectedSlot);
}

/** Open the inventory overlay using an activation's kicker/title. */
export function openInventory(app: AppContext, element: ResolvedUiElement, action: UiActivation): void {
  const { dom } = app;
  dom.inventoryKicker.textContent = action.kicker || "";
  renderInline(dom.inventoryTitle, (action.title || element.values.label || "") as string);
  dom.itemKicker.textContent = "";
  selectedInventoryItem.delete(app);
  dom.itemName.textContent = "";
  dom.itemDescription.textContent = "";
  dom.itemArt.textContent = "";
  dom.itemActions.replaceChildren();
  dom.inventoryOverlay.classList.remove("hidden");
  renderInventory(app);
}

/** Paint every visible UI element into its region and mount canvas surfaces. */
export function renderUi(app: AppContext): void {
  const { dom } = app;
  const runtime = app.runtime!;
  const engine = app.engine;
  const elements = runtime.ui.elements
    .map((element) => uiElement(element, runtime))
    .filter((element) => !runtime.ui.hidden.has(element.id) && (engine ? engine.check(element.if) : true));
  const sidebar = elements.filter((element) => element.location === "sidebar");
  const hud = elements.filter((element) => element.location === "hud");
  const surfaces = elements.filter((element) => element.location === "canvas");
  const outputElements = elements.filter((element) => element.location === "output");
  dom.surfaceHeader.replaceChildren(...sidebar.filter((element) => element.type === "button").map(uiButton));
  dom.gameHud.replaceChildren(...hud.filter((element) => element.type === "meter").map(meterRow));
  const outputNodes: HTMLElement[] = [];
  for (const element of outputElements) {
    if (element.type === "button") {
      outputNodes.push(uiButton(element));
    } else if (element.type === "text") {
      const text = document.createElement("div");
      text.className = "ui-text";
      renderBlocks(text, String(element.values.text || ""));
      outputNodes.push(text);
    }
  }
  dom.uiOutput.replaceChildren(...outputNodes);
  runtime.canvasEngine?.mountSurfaces(surfaces);
  $all<HTMLElement>("[data-ui]").forEach((control) => {
    control.onclick = () => app.runUiAction(elements.find((element) => element.id === control.dataset.ui)!);
  });
}
