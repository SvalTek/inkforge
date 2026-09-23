import type { AppContext } from "../app/context.ts";
import { normalizeProject } from "../project/project.ts";

/** The tab set the editor opens with, matching the original's two static tabs. */
export const DEFAULT_OPEN_FILES: readonly string[] = ["scenario.yaml", "scripts/main.lua"];

/** Repaint the editor gutter with one number per source line. */
export function lineNumbers(app: AppContext): void {
  const count = app.dom.code.value.split("\n").length;
  app.dom.gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
}

/** Update the footer cursor readout from the textarea selection. */
export function updateCursor(app: AppContext): void {
  const code = app.dom.code;
  app.dom.cursor.textContent = `Ln ${code.value.slice(0, code.selectionStart).split("\n").length}, Col ${
    code.selectionStart - code.value.lastIndexOf("\n", code.selectionStart)
  }`;
}

/** Rebuild the Author explorer from the currently loaded project VFS. */
export function renderFileTree(app: AppContext): void {
  const tree = app.dom.tree;
  tree.replaceChildren();

  const folder = document.createElement("div");
  folder.className = "folder";
  folder.append("⌄ ");
  const name = document.createElement("b");
  name.textContent = "adventure";
  folder.append(name);
  tree.append(folder);

  const paths = Object.keys(app.project.vfs);
  for (const path of paths.filter((entry) => !entry.startsWith("assets/"))) {
    const button = document.createElement("button");
    button.className = path === app.current ? "file active" : "file";
    button.dataset.file = path;
    button.textContent = `◇ ${path}`;
    button.onclick = () => app.switchFile(path);
    tree.append(button);
  }

  const assetPaths = Object.keys(app.project.assets).sort();
  const assetCount = assetPaths.length;
  if (assetCount > 0) {
    const assets = document.createElement("button");
    assets.className = "file";
    assets.dataset.file = "assets";
    assets.textContent = `${app.assetsExpanded ? "⌄" : "›"} assets `;
    const count = document.createElement("em");
    count.textContent = String(assetCount);
    assets.append(count);
    tree.append(assets);
    assets.onclick = () => {
      app.assetsExpanded = !app.assetsExpanded;
      renderFileTree(app);
    };
    for (const path of app.assetsExpanded ? assetPaths : []) {
      const asset = app.project.assets[path];
      const button = document.createElement("button");
      button.className = path === app.activeAsset ? "file active asset-file" : "file asset-file";
      button.dataset.file = path;
      button.title = `${asset.mime} · ${asset.size.toLocaleString()} bytes`;
      button.textContent = `◈ ${path.slice("assets/".length)}`;
      button.onclick = () => app.previewAsset(path);
      tree.append(button);
    }
  }
}

/** Persist the active editor buffer into the project and save locally. */
export function syncEditor(app: AppContext): void {
  app.project = normalizeProject(app.project);
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.dom.code.value;
  void app.persist();
  app.lineNumbers();
  app.dom.saved.textContent = "saved locally";
}

/** Basename of a VFS path, used as the tab label. */
export function tabLabel(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Rebuild the open-tab bar from `app.openFiles`, leaving the `#format` badge at
 * the far right. Tabs are created with DOM APIs (never `innerHTML`) so VFS path
 * text is treated as text, and the close glyph gets its own `<i>` element whose
 * click is stopped before it can reach the tab's activation handler.
 */
export function renderTabs(app: AppContext): void {
  for (const existing of [...app.dom.tabs.querySelectorAll<HTMLElement>(".tab")]) {
    existing.remove();
  }
  for (const path of app.openFiles) {
    const tab = document.createElement("button");
    tab.className = path === app.current ? "tab active" : "tab";
    tab.dataset.file = path;
    tab.append(document.createTextNode(`${tabLabel(path)} `));
    const close = document.createElement("i");
    close.dataset.close = path;
    close.title = "Close";
    close.textContent = "×";
    close.onclick = (event) => {
      event.stopPropagation();
      app.closeFile(path);
    };
    tab.append(close);
    tab.onclick = () => app.switchFile(path);
    app.dom.tabs.insertBefore(tab, app.dom.format);
  }
}

/** Switch the editor to another VFS path, opening a tab and flushing the buffer. */
export function switchFile(app: AppContext, path: string): void {
  if (path === "assets") return;
  app.project = normalizeProject(app.project);
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.dom.code.value;
  app.current = path;
  if (!app.openFiles.includes(path)) app.openFiles.push(path);
  app.dom.code.value = app.project.vfs[path] ?? "";
  app.dom.format.textContent = path.endsWith(".lua") ? "LUA" : "YAML";
  app.dom.tree.querySelectorAll<HTMLElement>(".file").forEach((button) =>
    button.classList.toggle("active", button.dataset.file === path)
  );
  renderTabs(app);
  app.lineNumbers();
}

/**
 * Close an open tab. Closing the active tab activates the nearest remaining tab
 * (right neighbour first, else the left); closing the last tab clears the editor
 * without deleting anything from the project VFS, so reopening restores content
 * (including unsaved buffer edits).
 */
export function closeFile(app: AppContext, path: string): void {
  const index = app.openFiles.indexOf(path);
  if (index === -1) return;
  app.project = normalizeProject(app.project);
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.dom.code.value;
  app.openFiles.splice(index, 1);
  if (app.current !== path) {
    renderTabs(app);
    return;
  }
  if (app.openFiles.length === 0) {
    app.current = "";
    app.dom.code.value = "";
    app.dom.format.textContent = "";
    document.querySelectorAll<HTMLElement>(".file").forEach((button) => button.classList.remove("active"));
    app.lineNumbers();
    renderTabs(app);
    return;
  }
  switchFile(app, app.openFiles[index] ?? app.openFiles[index - 1]);
}
