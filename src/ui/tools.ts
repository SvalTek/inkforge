import type { AppContext } from "../app/context.ts";
import { visibleTools } from "../engine/tool-state.ts";

function assetUrl(app: AppContext, path: string): string {
  const value = app.project.vfs[path];
  if (typeof value !== "string") return path;
  if (/^(data:|blob:)/.test(value)) return value;
  if (path.toLowerCase().endsWith(".svg") && value.trimStart().startsWith("<svg")) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`;
  }
  return path;
}

/** Render the authorable shell-level tool rail. */
export function renderTools(app: AppContext): void {
  const rail = app.dom.toolRail;
  rail.replaceChildren();
  for (const entry of visibleTools(app.runtime!.tools)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-button";
    button.dataset.tool = entry.definition.id;
    button.dataset.label = entry.definition.label;
    button.title = entry.definition.label;
    button.ariaLabel = entry.definition.label;
    button.disabled = entry.disabled;
    if (typeof entry.definition.icon === "string") {
      button.textContent = entry.definition.icon;
    } else if (entry.definition.icon?.image) {
      const image = document.createElement("img");
      image.src = assetUrl(app, entry.definition.icon.image);
      image.alt = "";
      button.append(image);
    } else {
      button.textContent = entry.definition.label.slice(0, 1).toUpperCase();
    }
    button.addEventListener("click", () => void app.runToolAction(entry));
    rail.append(button);
  }
}
