import type { AppContext } from "../app/context.ts";
import { normalizeProject } from "../project/project.ts";
import { badgeForLanguage, languageForPath } from "./language.ts";
import { buildFileTree, containsRequiredFile, folderPaths, type TreeEntry } from "./tree.ts";

/** The tab set the editor opens with, matching the original's two static tabs. */
export const DEFAULT_OPEN_FILES: readonly string[] = ["scenario.yaml", "scripts/main.lua"];

/**
 * Show `path`'s buffer in the editor, with the grammar and the footer badge
 * derived from the same `languageForPath` call so they cannot disagree.
 */
export function openInEditor(app: AppContext, path: string): void {
  const language = languageForPath(path);
  app.editor.setValue(app.project.vfs[path] ?? "");
  app.editor.setLanguage(language);
  app.dom.format.textContent = badgeForLanguage(language);
}

/** Show an empty buffer with no grammar, for when the last tab closes. */
export function clearEditor(app: AppContext): void {
  app.editor.setValue("");
  app.editor.setLanguage(null);
  app.dom.format.textContent = "";
}

/** One level of explorer indentation, in pixels. */
const INDENT_PX = 12;

/**
 * Render one entry, recursing into folders the author has open.
 *
 * A folder is a row of controls: the name toggles it, `+` creates inside it,
 * and `×` opens deletion confirmation. The indent is the hierarchy — the old tree printed whole
 * paths on flat rows under a hardcoded root, which read as a list, not a tree.
 */
function renderEntry(app: AppContext, entry: TreeEntry, depth: number): HTMLElement[] {
  const protectedScript = app.protectedScript;
  if (entry.kind === "file") {
    const row = document.createElement("div");
    row.className = "file-row";
    const button = document.createElement("button");
    button.className = entry.path === app.current ? "file active" : "file";
    button.dataset.file = entry.path;
    button.textContent = entry.name;
    button.style.paddingLeft = `${8 + depth * INDENT_PX}px`;
    button.onclick = () => app.switchFile(entry.path);
    row.append(button);
    if (!containsRequiredFile("file", entry.path, protectedScript)) row.append(deleteButton(app, "file", entry.path));
    return [row];
  }

  const open = app.expandedFolders.has(entry.path);
  const row = document.createElement("div");
  row.className = open ? "folder open" : "folder";
  row.dataset.folder = entry.path;

  const toggle = document.createElement("button");
  toggle.className = "folder-toggle";
  toggle.dataset.folderToggle = entry.path;
  toggle.textContent = `${open ? "⌄" : "›"} ${entry.name}`;
  toggle.style.paddingLeft = `${4 + depth * INDENT_PX}px`;
  toggle.onclick = () => app.toggleFolder(entry.path);

  const add = document.createElement("button");
  add.className = "folder-add";
  add.dataset.folderAdd = entry.path;
  add.title = `Add a file or folder in ${entry.name}`;
  add.setAttribute("aria-label", add.title);
  add.textContent = "+";
  add.onclick = () => app.openCreateDialog(entry.path);

  row.append(toggle, add);
  if (!containsRequiredFile("folder", entry.path, protectedScript)) row.append(deleteButton(app, "folder", entry.path));
  if (!open) return [row];
  return [row, ...entry.children.flatMap((child) => renderEntry(app, child, depth + 1))];
}

function deleteButton(app: AppContext, kind: "file" | "folder" | "asset", path: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "entry-delete";
  button.textContent = "×";
  button.title = `Delete ${kind} ${path}`;
  button.setAttribute("aria-label", button.title);
  button.onclick = () => app.deleteExplorerEntry(kind, path);
  return button;
}

/** Rebuild the Author explorer from the currently loaded project VFS. */
export function renderFileTree(app: AppContext): void {
  const tree = app.dom.tree;
  // A project arriving from anywhere — boot, library, import, new — starts with
  // every folder open, so a fresh project never looks emptier than the old flat
  // list did. Collapses made afterwards stick for the rest of that project.
  if (app.explorerProjectId !== app.project.identity.id) {
    app.expandedFolders = new Set(folderPaths(buildFileTree(app.project.vfs)));
    app.explorerProjectId = app.project.identity.id;
  }
  tree.replaceChildren(...buildFileTree(app.project.vfs).flatMap((entry) => renderEntry(app, entry, 0)));

  const assetPaths = Object.keys(app.project.assets).sort();
  const assetCount = assetPaths.length;
  if (assetCount > 0) {
    const assets = document.createElement("button");
    assets.className = "file asset-group";
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
      const row = document.createElement("div");
      row.className = "file-row";
      const button = document.createElement("button");
      button.className = path === app.activeAsset ? "file active asset-file" : "file asset-file";
      button.dataset.file = path;
      button.title = `${asset.mime} · ${asset.size.toLocaleString()} bytes`;
      button.textContent = `◈ ${path.slice("assets/".length)}`;
      button.style.paddingLeft = "20px";
      button.onclick = () => app.previewAsset(path);
      row.append(button, deleteButton(app, "asset", path));
      tree.append(row);
    }
  }
}

/** Persist the active editor buffer into the project and save locally. */
export function syncEditor(app: AppContext): void {
  app.project = normalizeProject(app.project);
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.editor.getValue();
  app.schedulePersist();
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
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.editor.getValue();
  app.current = path;
  if (!app.openFiles.includes(path)) app.openFiles.push(path);
  openInEditor(app, path);
  app.dom.tree.querySelectorAll<HTMLElement>(".file").forEach((button) =>
    button.classList.toggle("active", button.dataset.file === path)
  );
  renderTabs(app);
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
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.editor.getValue();
  app.openFiles.splice(index, 1);
  if (app.current !== path) {
    renderTabs(app);
    return;
  }
  if (app.openFiles.length === 0) {
    app.current = "";
    clearEditor(app);
    document.querySelectorAll<HTMLElement>(".file").forEach((button) => button.classList.remove("active"));
    renderTabs(app);
    return;
  }
  switchFile(app, app.openFiles[index] ?? app.openFiles[index - 1]);
}
