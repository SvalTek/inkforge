import type { AppContext } from "../app/context.ts";
import type { ModalDefinition, ResolvedUiElement, UiElement } from "../types/index.ts";
import { uiElement } from "../engine/ui-state.ts";
import { markViewDirty } from "../engine/events.ts";
import { renderBlocks, renderInline } from "./markdown.ts";

function modalDefinition(app: AppContext, id: string): ModalDefinition | undefined {
  return app.scenario?.modals?.find((modal) => modal.id === id);
}

function pageStacks(elements: UiElement[], path = "", out: Array<{ element: UiElement; path: string }> = []) {
  for (const element of elements) {
    const runtimePath = path ? `${path}.${element.id}` : element.id;
    if (element.type === "page_stack") out.push({ element, path: runtimePath });
    pageStacks(element.elements || [], runtimePath, out);
  }
  return out;
}

function initialisePages(app: AppContext, definition: ModalDefinition, rootPath: string): void {
  for (const { element: stack, path } of pageStacks(definition.elements || [], rootPath)) {
    const first = (stack.elements || []).find((element) => element.type === "page");
    if (first && !app.runtime!.modals.activePages[path]) app.runtime!.modals.activePages[path] = first.id;
  }
}

/** Open one authored modal model and initialise its page stacks. */
export function openModal(app: AppContext, id: string): void {
  const definition = modalDefinition(app, id);
  if (!definition) {
    app.output?.(`Unknown modal: ${id}`, "warning");
    return;
  }
  app.runtime!.modals.open = id;
  initialisePages(app, definition, id);
  markViewDirty(app.runtime!);
  app.flushView();
}

/** Close the active authored modal. */
export function closeModal(app: AppContext): void {
  if (!app.runtime) return;
  app.runtime.modals.open = null;
  markViewDirty(app.runtime);
  app.flushView();
}

function findPageStack(
  elements: UiElement[],
  pageId: string,
  path = "",
): { element: UiElement; path: string } | undefined {
  for (const element of elements) {
    const runtimePath = path ? `${path}.${element.id}` : element.id;
    if (
      element.type === "page_stack" &&
      (element.elements || []).some((page) => page.type === "page" && page.id === pageId)
    ) {
      return { element, path: runtimePath };
    }
    const nested = findPageStack(element.elements || [], pageId, runtimePath);
    if (nested) return nested;
  }
  return undefined;
}

/** Switch the first page stack containing the requested page. */
export function setModalPage(app: AppContext, pageId: string): void {
  const id = app.runtime?.modals.open;
  const definition = id ? modalDefinition(app, id) : undefined;
  if (!definition || !app.runtime || !id) return;
  const stack = findPageStack(definition.elements || [], pageId, id);
  if (!stack) {
    app.output?.(`Unknown modal page: ${pageId}`, "warning");
    return;
  }
  app.runtime.modals.activePages[stack.path] = pageId;
  markViewDirty(app.runtime);
  app.flushView();
}

function appendElements(app: AppContext, parent: HTMLElement, elements: UiElement[] | undefined, path: string): void {
  for (const raw of elements || []) {
    const runtimePath = path ? `${path}.${raw.id}` : raw.id;
    const element = uiElement(raw, app.runtime!, runtimePath);
    if (app.runtime!.ui.hidden.has(element.id) || (app.engine && !app.engine.check(element.if))) continue;
    parent.append(renderElement(app, element, runtimePath));
  }
}

function renderElement(app: AppContext, element: ResolvedUiElement, path: string): HTMLElement {
  const type = element.type;
  // Authored prose is a block container, not a paragraph: markdown emits `<p>`,
  // and a `<p>` inside a `<p>` is invalid — the browser would split the element
  // and the modal layout would break.
  const tag = type === "button" ? "button" : "div";
  const node = document.createElement(tag);
  node.className = `authored-element authored-${type}`;
  node.dataset.uiPath = element.runtimePath || path;
  node.dataset.modalUi = element.id;

  if (type === "text") {
    renderBlocks(node, String(element.values.text ?? ""));
  } else if (type === "button") {
    const label = String(element.values.label ?? element.id);
    node.textContent = label;
    (node as HTMLButtonElement).type = "button";
    (node as HTMLButtonElement).ariaLabel = element.accessibleLabel || label;
    node.addEventListener("click", () => void app.runUiAction(element));
  } else if (type === "image") {
    const image = document.createElement("img");
    const source = String(element.values.src ?? element.values.image ?? "");
    image.src = app.assetResolver.url(source) || "";
    image.alt = String(element.values.alt ?? element.accessibleLabel ?? "");
    node.append(image);
  } else if (type === "meter") {
    const value = Number(element.values.value) || 0;
    const max = Number(element.values.max) || 0;
    const label = document.createElement("span");
    label.textContent = String(element.values.label ?? element.id);
    const valueText = document.createElement("b");
    valueText.textContent = `${value} / ${max}`;
    const track = document.createElement("i");
    const fill = document.createElement("em");
    fill.style.width = `${max ? Math.max(0, Math.min(100, value / max * 100)) : 0}%`;
    track.append(fill);
    node.append(label, valueText, track);
  } else if (type === "page_stack") {
    const pages = (element.elements || []).filter((page) => page.type === "page");
    const activeId = app.runtime!.modals.activePages[element.runtimePath] || pages[0]?.id;
    const active = pages.find((page) => page.id === activeId) || pages[0];
    if (active) appendElements(app, node, active.elements, path);
  } else {
    appendElements(app, node, element.elements, path);
  }

  return node;
}

/** Render the active authored modal into the dedicated shell overlay host. */
export function renderModals(app: AppContext): void {
  const host = app.dom.modalHost;
  host.replaceChildren();
  const id = app.runtime?.modals.open;
  if (!id || !app.runtime) return;
  const definition = modalDefinition(app, id);
  if (!definition) {
    app.runtime.modals.open = null;
    return;
  }

  const overlay = document.createElement("section");
  overlay.className = "authored-modal-overlay";
  overlay.role = "dialog";
  overlay.ariaModal = "true";
  overlay.ariaLabel = definition.title || id;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && definition.dismissible !== false) closeModal(app);
  });

  const window = document.createElement("div");
  window.className = "authored-modal-window";
  const header = document.createElement("header");
  const heading = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.textContent = definition.kicker || "";
  const title = document.createElement("h2");
  renderInline(title, definition.title || id);
  heading.append(kicker, title);
  header.append(heading);
  if (definition.dismissible !== false) {
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close ×";
    close.addEventListener("click", () => closeModal(app));
    header.append(close);
  }
  const body = document.createElement("div");
  body.className = "authored-modal-body";
  appendElements(app, body, definition.elements, id);
  window.append(header, body);
  overlay.append(window);
  host.append(overlay);
}
