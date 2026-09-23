import type { AppContext, AppView } from "./context.ts";
import type { EngineRuntime, ProjectData, ResolvedUiElement, ToolEntry } from "../types/index.ts";
import { bootRuntime } from "./boot.ts";
import { bindEvents } from "./events.ts";
import { queryDom } from "./dom.ts";
import { applyUi as applyUiState } from "../engine/ui-state.ts";
import { createEngine } from "../engine/engine.ts";
import { createOutput } from "../engine/events.ts";
import { composeScenario as composeScenarioImpl } from "../yaml/compose.ts";
import { normalizeProject, projectTitle } from "../project/project.ts";
import {
  activeProjectId,
  deleteProject as deleteStoredProject,
  getProject,
  listProjects,
  migrateLegacyProject,
  putProject,
  saveProject,
  setActiveProjectId,
} from "../project/storage.ts";
import { loadStarterProject } from "../project/starter.ts";
import {
  closeFile as closeFileImpl,
  DEFAULT_OPEN_FILES,
  lineNumbers as lineNumbersImpl,
  renderFileTree as renderFileTreeImpl,
  renderTabs as renderTabsImpl,
  switchFile as switchFileImpl,
  syncEditor as syncEditorImpl,
} from "../editor/editor.ts";
import { render as renderDom } from "../ui/render.ts";
import { runToolAction as runToolActionImpl, runUiAction as runUiActionImpl } from "../ui/actions.ts";
import { exportPack as exportPackImpl, importPack as importPackImpl } from "../import-export/pack.ts";
import { createToolRegistry } from "../engine/tool-state.ts";
import { AssetResolver } from "../project/assets.ts";
import { AudioManager } from "../audio/manager.ts";

/** Build the single app context and bind the DOM once. */
export function createApp(): AppContext {
  const dom = queryDom();
  const reportMediaError = (message: string) => {
    dom.diagnostics.textContent = `● ${message}`;
    dom.diagnostics.style.color = "#ee7c78";
  };
  const emptyResolver = new AssetResolver({}, (path) => reportMediaError(`Asset not found: ${path}`));
  const audio = new AudioManager(emptyResolver, reportMediaError);

  const app: AppContext = {
    dom,
    project: normalizeProject({}),
    scenario: null,
    runtime: null,
    canvas: null,
    lua: null,
    engine: null,
    output: null,
    assetResolver: emptyResolver,
    audio,
    current: "scenario.yaml",
    openFiles: [...DEFAULT_OPEN_FILES],
    activeAsset: null,
    assetsExpanded: true,
    initialise,
    start,
    restart,
    showView,
    switchFile,
    previewAsset,
    closeFile,
    renderFileTree,
    renderTabs,
    syncEditor,
    lineNumbers,
    persist,
    render,
    runUiAction,
    runToolAction,
    newProject,
    openProjectLibrary,
    loadProject,
    deleteProject,
    exportPack,
    importPack,
  };

  async function initialise(): Promise<void> {
    try {
      const starter = await loadStarterProject();
      let projects = await listProjects();
      const migrated = await migrateLegacyProject();
      if (migrated) projects = await listProjects();
      if (!projects.some((project) => project.identity.id === starter.identity.id)) {
        await putProject(starter);
        projects.push(starter);
      }
      const selected = projects.find((project) => project.identity.id === activeProjectId()) ||
        projects.find((project) => project.pinned) || starter;
      app.project = normalizeProject(selected);
      setActiveProjectId(app.project.identity.id);
      app.current = "scenario.yaml";
      app.activeAsset = null;
      dom.code.value = app.project.vfs[app.current] ?? "";
      renderFileTreeImpl(app);
      lineNumbers();
      renderTabs();
      await start();
    } catch (error) {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
    }
  }

  async function start(): Promise<void> {
    app.project = normalizeProject(app.project);
    document.body.dataset.projectId = app.project.identity.id;
    document.body.dataset.projectReady = "false";
    if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = dom.code.value;
    dom.diagnostics.textContent = "● Loading project";
    dom.diagnostics.style.color = "#d6a95c";
    const scenarioSource = app.project.vfs["scenario.yaml"] ?? "";
    app.audio.destroy();
    app.assetResolver.revoke();
    app.assetResolver = new AssetResolver(app.project.assets, (path) => reportMediaError(`Asset not found: ${path}`));
    app.audio = new AudioManager(app.assetResolver, reportMediaError);

    if (!scenarioSource.trim()) {
      app.scenario = null;
      app.runtime = null;
      dom.diagnostics.textContent = "";
      dom.heroTerminal.innerHTML = "";
      dom.terminal.innerHTML = "";
      dom.heroChoices.innerHTML = "";
      dom.choices.innerHTML = "";
      dom.storyTitle.textContent = "";
      dom.title.textContent = "";
      dom.choiceCount.textContent = "";
      dom.decision.style.visibility = "hidden";
      dom.toolRail.replaceChildren();
      dom.modalHost.replaceChildren();
      document.body.dataset.projectReady = "true";
      return;
    }

    try {
      const scenario = await composeScenarioImpl(app.project.vfs);
      app.scenario = scenario;
      if (!scenario.startLocation || !scenario.locations?.[scenario.startLocation]) {
        throw new Error("Scenario needs a valid startLocation.");
      }
      const runtime: EngineRuntime = {
        location: scenario.startLocation,
        state: { ...(scenario.state || {}), ...(scenario.player?.state || {}) },
        inventory: [...(scenario.player?.inventory || [])],
        events: [],
        over: false,
        ui: { hidden: new Set<string>(), overrides: {}, elements: [...(scenario.ui?.elements || [])] },
        modals: { open: null, activePages: {} },
        tools: createToolRegistry(scenario.tools || []),
        conversation: null,
        lua: null,
        canvasEngine: null,
        canvasEvent: undefined,
        timerEvent: undefined,
        canvasViewDirty: false,
      };
      app.runtime = runtime;
      const output = createOutput(runtime);
      app.output = output;
      const engine = createEngine({
        getScenario: () => app.scenario,
        runtime,
        output,
        applyUi: (command) => applyUiState(command, runtime),
        render: () => render(),
      });
      app.engine = engine;
      await bootRuntime(app, scenario, {
        render: () => render(),
        applyUi: (command) => applyUiState(command, runtime),
        output,
        onError: (message) => {
          dom.diagnostics.textContent = `● ${message}`;
          dom.diagnostics.style.color = "#ee7c78";
        },
        audio: app.audio,
      });
      engine.move(runtime.location);
      dom.diagnostics.textContent = "● Ready";
      dom.diagnostics.style.color = "#7cbd9a";
      document.body.dataset.projectReady = "true";
      dom.decision.style.visibility = "visible";
      render();
    } catch (error) {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
      dom.heroTerminal.innerHTML = `<div class="entry system"><p>${(error as Error).message}</p></div>`;
    }
  }

  function restart(): Promise<void> {
    return start();
  }

  function showView(view: AppView): void {
    dom.playView.classList.toggle("hidden", view !== "play");
    dom.authorView.classList.toggle("hidden", view !== "author");
    document.querySelectorAll<HTMLElement>(".nav").forEach((button) =>
      button.classList.toggle("active", button.dataset.view === view)
    );
    // A canvas mounted while Author is visible has zero layout bounds. Redraw
    // after revealing Play so its viewport transform and hit stack are valid.
    if (view === "play" && app.runtime) renderDom(app);
  }

  function switchFile(path: string): void {
    app.activeAsset = null;
    dom.editorWrap.classList.remove("hidden");
    dom.assetPreview.classList.add("hidden");
    switchFileImpl(app, path);
  }

  function previewAsset(path: string): void {
    app.activeAsset = path;
    app.dom.editorWrap.classList.add("hidden");
    app.dom.assetPreview.classList.remove("hidden");
    app.dom.assetPreview.replaceChildren();
    const asset = app.project.assets[path];
    if (!asset) {
      const error = document.createElement("p");
      error.textContent = "Asset is unavailable or invalid.";
      app.dom.assetPreview.append(error);
      return;
    }
    const heading = document.createElement("h3");
    heading.textContent = path;
    const meta = document.createElement("p");
    meta.textContent = `${asset.mime} · ${asset.size.toLocaleString()} bytes`;
    app.dom.assetPreview.append(heading, meta);
    const url = app.assetResolver.url(path);
    if (asset.mime.startsWith("image/") && url) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = path;
      image.onload = () => {
        meta.textContent =
          `${asset.mime} · ${asset.size.toLocaleString()} bytes · ${image.naturalWidth}×${image.naturalHeight}`;
      };
      app.dom.assetPreview.append(image);
      if (asset.mime === "image/svg+xml") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "SVG source";
        const source = document.createElement("pre");
        details.append(summary, source);
        void asset.data.text().then((text) => source.textContent = text);
        app.dom.assetPreview.append(details);
      }
    } else if (asset.mime.startsWith("audio/") && url) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = url;
      audio.onloadedmetadata = () => {
        meta.textContent = `${asset.mime} · ${asset.size.toLocaleString()} bytes · ${audio.duration.toFixed(2)}s`;
      };
      app.dom.assetPreview.append(audio);
    } else {
      const error = document.createElement("p");
      error.textContent = "Asset preview is unavailable because its content could not be resolved.";
      app.dom.assetPreview.append(error);
    }
    renderFileTree();
  }

  function closeFile(path: string): void {
    closeFileImpl(app, path);
  }

  function renderTabs(): void {
    renderTabsImpl(app);
  }

  function renderFileTree(): void {
    renderFileTreeImpl(app);
  }

  function syncEditor(): void {
    syncEditorImpl(app);
  }

  function lineNumbers(): void {
    lineNumbersImpl(app);
  }

  function persist(): Promise<void> {
    app.project = normalizeProject(app.project);
    if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = dom.code.value;
    return saveProject(app.project).catch((error) => {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
      throw error;
    });
  }

  function render(): void {
    if (app.runtime) renderDom(app);
  }

  function runUiAction(element: ResolvedUiElement): Promise<void> | void {
    return runUiActionImpl(app, element);
  }

  function runToolAction(entry: ToolEntry): Promise<void> | void {
    return runToolActionImpl(app, entry);
  }

  async function openProjectLibrary(): Promise<void> {
    const projects = (await listProjects()).sort((left, right) =>
      projectTitle(left).localeCompare(projectTitle(right))
    );
    dom.projectList.replaceChildren();
    for (const project of projects) {
      const row = document.createElement("article");
      row.className = "project-card";
      row.dataset.project = project.identity.id;
      const heading = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = projectTitle(project);
      const meta = document.createElement("p");
      meta.textContent = `${project.identity.author || "Unknown author"} · v${project.identity.version} · Updated ${
        new Date(project.updatedAt).toLocaleString()
      }`;
      if (project.identity.id === app.project.identity.id) {
        const active = document.createElement("strong");
        active.className = "project-active";
        active.textContent = "Active";
        heading.append(active);
      }
      heading.append(title, meta);
      const actions = document.createElement("div");
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = project.identity.id === app.project.identity.id ? "Loaded" : "Load";
      load.disabled = project.identity.id === app.project.identity.id;
      load.onclick = () => void loadProject(project.identity.id);
      actions.append(load);
      if (!project.pinned) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Delete";
        remove.onclick = () => void deleteProject(project.identity.id);
        actions.append(remove);
      }
      row.append(heading, actions);
      dom.projectList.append(row);
    }
    dom.projectOverlay.classList.remove("hidden");
  }

  async function activateProject(selected: ProjectData): Promise<void> {
    app.project = normalizeProject(selected);
    setActiveProjectId(selected.identity.id);
    app.current = "scenario.yaml";
    app.openFiles = [...DEFAULT_OPEN_FILES];
    dom.code.value = app.project.vfs[app.current] ?? "";
    renderFileTree();
    renderTabs();
    await start();
    dom.projectOverlay.classList.add("hidden");
  }

  async function loadProject(id: string): Promise<void> {
    await persist();
    const selected = await getProject(id);
    if (!selected) throw new Error(`Project not found: ${id}`);
    await activateProject(selected);
  }

  async function deleteProject(id: string): Promise<void> {
    const selected = await getProject(id);
    if (!selected || selected.pinned) return;
    if (!globalThis.confirm(`Delete ${projectTitle(selected)}?`)) return;
    await persist();
    await deleteStoredProject(id);
    if (app.project.identity.id === id) {
      const remaining = (await listProjects()).sort((left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
      );
      const next = remaining[0];
      if (next) await activateProject(next);
    }
    await openProjectLibrary();
  }

  async function newProject(): Promise<void> {
    await persist();
    const starter = await loadStarterProject();
    const id = `lantern-below-copy-${crypto.randomUUID()}`;
    app.project = normalizeProject({
      identity: { ...starter.identity, id, title: `${projectTitle(starter)} Copy` },
      vfs: { ...starter.vfs },
      assets: { ...starter.assets },
    });
    await putProject(app.project);
    setActiveProjectId(app.project.identity.id);
    app.current = "scenario.yaml";
    app.activeAsset = null;
    app.dom.code.value = app.project.vfs["scenario.yaml"] ?? "";
    app.openFiles = [...DEFAULT_OPEN_FILES];
    renderFileTree();
    switchFile("scenario.yaml");
    await start();
  }

  function exportPack(): void {
    void exportPackImpl(app).catch((error) => {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
    });
  }

  function importPack(file: File): Promise<void> {
    return importPackImpl(app, file);
  }

  bindEvents(app);
  return app;
}
