import type { AppContext } from "../app/context.ts";
import type { EngineEvent, ResolvedUiElement, UiActivation } from "../types/index.ts";
import { itemName } from "../engine/directives.ts";
import { uiElement } from "../engine/ui-state.ts";
import { $all } from "../app/dom.ts";
import { renderModals } from "./modals.ts";
import { renderTools } from "./tools.ts";
import { projectTitle } from "../project/project.ts";

type OutputEvent = Extract<EngineEvent, { type: "output" }>;

/** Paint the terminal, choices, location title and event stream. */
export function render(app: AppContext): void {
  const { dom } = app;
  const runtime = app.runtime!;
  const scenario = app.scenario;
  const loc = scenario?.locations?.[runtime.location] || {};
  const text = runtime.events
    .filter((e): e is OutputEvent => e.type === "output")
    .map((e) => `<div class="entry ${e.kind || ""}"><b>NOW</b><p>${e.text}</p></div>`)
    .join("");
  dom.heroTerminal.innerHTML = text;
  dom.terminal.innerHTML = text;
  const choices = app.engine?.available() ?? [];
  const buttons = choices.map((x) => `<button class="choice" data-cmd="${x.cmd}">${x.text}</button>`).join("");
  dom.heroChoices.innerHTML = buttons;
  dom.choices.innerHTML = buttons;
  dom.choiceCount.textContent = choices.length ? `${choices.length} AVAILABLE` : "";
  const title = loc.title || scenario?.meta?.title || "";
  dom.storyTitle.textContent = title;
  dom.title.textContent = projectTitle(app.project);
  dom.runTitle.textContent = dom.title.textContent;
  dom.location.textContent = title;
  dom.eventLog.innerHTML = runtime.events
    .map((e) =>
      `<div class="event"><b>${e.type}</b>${
        "itemId" in e && e.itemId ? `<br>${itemName(scenario, e.itemId)}` : ""
      }</div>`
    )
    .join("");
  renderInventory(app);
  renderUi(app);
  renderTools(app);
  renderModals(app);
  $all<HTMLElement>("[data-cmd]").forEach((button) => {
    button.onclick = () => app.engine?.dispatch(button.dataset.cmd ?? "");
  });
}

/** Paint the 12 inventory slots and wire each to its inspector. */
export function renderInventory(app: AppContext): void {
  const { dom } = app;
  const slots = Array.from({ length: 12 }, (_, i) => app.runtime?.inventory?.[i] || null);
  dom.inventoryCount.textContent = `${app.runtime?.inventory?.length || 0} / 12`;
  dom.inventorySlots.innerHTML = slots
    .map((id, i) =>
      `<button class="slot ${id ? "occupied" : ""}" data-slot="${i}"><span>${String(i + 1).padStart(2, "0")}</span>${
        id ? "<b>◆</b>" : "+"
      }</button>`
    )
    .join("");
  $all<HTMLElement>("[data-slot]").forEach((button) => {
    button.onclick = () => inspectItem(app, Number(button.dataset.slot));
  });
}

/** Show one inventory slot's item in the inspector pane. */
export function inspectItem(app: AppContext, slot: number): void {
  const { dom } = app;
  const id = app.runtime!.inventory[slot];
  if (!id) {
    dom.itemName.textContent = "";
    dom.itemDescription.textContent = "";
    dom.itemArt.textContent = "";
    dom.itemActions.innerHTML = "";
    return;
  }
  const instance = app.scenario?.instances?.item?.[id] || {};
  const definition = app.scenario?.definitions?.item?.[instance.def as string] || {};
  dom.itemName.textContent = definition.name || id;
  dom.itemDescription.textContent = definition.description || "";
  dom.itemArt.textContent = "◆";
  dom.itemActions.innerHTML = "";
}

/** Open the inventory overlay using an activation's kicker/title. */
export function openInventory(app: AppContext, element: ResolvedUiElement, action: UiActivation): void {
  const { dom } = app;
  dom.inventoryKicker.textContent = action.kicker || "";
  dom.inventoryTitle.textContent = (action.title || element.values.label || "") as string;
  dom.itemKicker.textContent = "";
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
  const button = (element: ResolvedUiElement) =>
    `<button data-ui="${element.id}">${element.values.label || element.id}</button>`;
  dom.surfaceHeader.innerHTML = sidebar.filter((element) => element.type === "button").map(button).join("");
  dom.gameHud.innerHTML = hud.filter((element) => element.type === "meter").map((element) => {
    const value = Number(element.values.value) || 0;
    const max = Number(element.values.max) || 0;
    const percent = max ? Math.max(0, Math.min(100, value / max * 100)) : 0;
    return `<div><span>${
      element.values.label || element.id
    }</span><b>${value} / ${max}</b><i><em style="width:${percent}%"></em></i></div>`;
  }).join("");
  dom.uiOutput.innerHTML = outputElements.map((element) =>
    element.type === "button"
      ? button(element)
      : element.type === "text"
      ? `<div class="ui-text">${element.values.text || ""}</div>`
      : ""
  ).join("");
  runtime.canvasEngine?.mountSurfaces(surfaces);
  $all<HTMLElement>("[data-ui]").forEach((control) => {
    control.onclick = () => app.runUiAction(elements.find((element) => element.id === control.dataset.ui)!);
  });
}
