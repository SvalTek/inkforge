import type { AppContext, AppView } from "./context.ts";
import type { EngineRuntime, ProjectData, ResolvedUiElement, ToolEntry } from "../types/index.ts";
import { bootRuntime } from "./boot.ts";
import { bindEvents } from "./events.ts";
import { queryDom } from "./dom.ts";
import { applyUi as applyUiState } from "../engine/ui-state.ts";
import { createEngine } from "../engine/engine.ts";
import { createOutput, flushView as flushViewImpl } from "../engine/events.ts";
import { composeScenario as composeScenarioImpl, readScenarioMeta, validateScenario } from "../yaml/compose.ts";
import { emitNamedEvent, invokeNamedFunction, type SeamReport } from "../lua/invoke.ts";
import { normalizeProject, projectCardMeta, projectTitle } from "../project/project.ts";
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
  openInEditor,
  renderFileTree as renderFileTreeImpl,
  renderTabs as renderTabsImpl,
  switchFile as switchFileImpl,
  syncEditor as syncEditorImpl,
} from "../editor/editor.ts";
import { createCodeEditor } from "../editor/codemirror.ts";
import { installEditorHarness } from "../editor/harness.ts";
import { render as renderDom } from "../ui/render.ts";
import { runToolAction as runToolActionImpl, runUiAction as runUiActionImpl } from "../ui/actions.ts";
import { exportPack as exportPackImpl, importPack as importPackImpl } from "../import-export/pack.ts";
import { createToolRegistry } from "../engine/tool-state.ts";
import { AssetResolver } from "../project/assets.ts";
import { AudioManager } from "../audio/manager.ts";

/** Debounce window for coalescing keystroke-driven IndexedDB saves. */
const PERSIST_DEBOUNCE_MS = 400;

/** Build the single app context and bind the DOM once. */
export function createApp(): AppContext {
  const dom = queryDom();
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const reportMediaError = (message: string) => {
    dom.diagnostics.textContent = `● ${message}`;
    dom.diagnostics.style.color = "#ee7c78";
  };
  const emptyResolver = new AssetResolver({}, (path) => reportMediaError(`Asset not found: ${path}`));
  const audio = new AudioManager(emptyResolver, reportMediaError);

  // The editor is mounted before the context literal because the context needs
  // it (`editor`), and it needs the context (the callbacks call `app`). The
  // callbacks only ever run from user input, long after `app` is assigned.
  const editor = createCodeEditor({
    parent: dom.code,
    onChange: () => app.syncEditor(),
    onSelection: (line, column) => {
      dom.cursor.textContent = `Ln ${line}, Col ${column}`;
    },
  });

  const app: AppContext = {
    dom,
    editor,
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
    bootGeneration: 0,
    initialise,
    start,
    showView,
    switchFile,
    previewAsset,
    closeFile,
    renderFileTree,
    renderTabs,
    syncEditor,
    persist,
    schedulePersist,
    render,
    flushView,
    runUiAction,
    runToolAction,
    newProject,
    openProjectLibrary,
    loadProject,
    deleteProject,
    exportPack,
    importPack,
  };
  installEditorHarness(editor, () => app.syncEditor());

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
      openInEditor(app, app.current);
      renderFileTreeImpl(app);
      renderTabs();
      await start();
    } catch (error) {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
    }
  }

  /**
   * Boots are serialised, and a superseded boot stops at its next await.
   *
   * `start()` is async and fired fire-and-forget from three DOM handlers as
   * well as the initial load, so two overlapping boots used to interleave on
   * shared state — `app.canvas`, `app.lua`, `app.runtime`, and the
   * `projectReady` flag the browser harnesses wait on, which made a
   * half-torn-down boot a test-validity hazard rather than just a glitch.
   * Chaining means boots never overlap; the generation means a stale one does
   * not commit its results or announce itself ready.
   */
  let bootChain: Promise<void> = Promise.resolve();

  function start(): Promise<void> {
    const generation = ++app.bootGeneration;
    bootChain = bootChain.then(() => bootOnce(generation)).catch((error) => {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
    });
    return bootChain;
  }

  async function bootOnce(generation: number): Promise<void> {
    const superseded = (): boolean => generation !== app.bootGeneration;
    app.project = normalizeProject(app.project);
    document.body.dataset.projectId = app.project.identity.id;
    document.body.dataset.projectReady = "false";
    if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.editor.getValue();
    dom.diagnostics.textContent = "● Loading scenario";
    dom.diagnostics.style.color = "#d6a95c";
    const scenarioSource = app.project.vfs["scenario.yaml"] ?? "";
    app.audio.destroy();
    app.assetResolver.revoke();
    app.assetResolver = new AssetResolver(app.project.assets, (path) => reportMediaError(`Asset not found: ${path}`));
    app.audio = new AudioManager(app.assetResolver, reportMediaError);

    if (!scenarioSource.trim()) {
      app.scenario = null;
      app.runtime = null;
      app.canvas?.destroy();
      app.canvas = null;
      if (app.lua) {
        try {
          await app.lua.shutdown();
        } catch {
          /* teardown must not mask the boot that follows it */
        }
      }
      app.lua = null;
      app.engine = null;
      app.output = null;
      if (superseded()) return;
      dom.diagnostics.textContent = "";
      dom.heroTerminal.replaceChildren();
      dom.terminal.replaceChildren();
      dom.heroChoices.replaceChildren();
      dom.choices.replaceChildren();
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
      if (superseded()) return;
      app.scenario = scenario;
      if (!scenario.startLocation || !scenario.locations?.[scenario.startLocation]) {
        throw new Error("Scenario needs a valid startLocation.");
      }
      // Static checks for the mistakes that would otherwise fail silently —
      // misspelled condition and directive keys. Lua names are checked after
      // the script loads (see bootRuntime).
      const issues = validateScenario(scenario);
      if (issues.length) {
        throw new Error(`Scenario problems: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
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
        viewDirty: false,
      };
      app.runtime = runtime;
      const output = createOutput(runtime);
      app.output = output;
      // A boot problem — a `call:` naming a function that does not exist, a
      // script that will not load — goes to the transcript, which is where it
      // stays visible. Diagnostics is a single slot and the "Ready" that
      // follows would overwrite it, so the count is carried out to the status
      // line instead of being reported only in passing.
      let problems = 0;
      const reportProblem = (message: string): void => {
        problems += 1;
        output(message, "error");
        dom.diagnostics.textContent = `● ${message}`;
        dom.diagnostics.style.color = "#ee7c78";
      };
      // `call:`/`emit:` reach into Lua from authored YAML. Both funnel through
      // the bridge's named-call and event bus rather than any custom dispatch,
      // and report failures instead of no-opping.
      const reportSeam: SeamReport = (message, severity) => {
        if (severity === "error") problems += 1;
        output(message, severity);
        dom.diagnostics.textContent = `● ${message}`;
        dom.diagnostics.style.color = severity === "error" ? "#ee7c78" : "#d6a95c";
      };
      const engine = createEngine({
        getScenario: () => app.scenario,
        runtime,
        output,
        applyUi: (command) => applyUiState(command, runtime),
        render: () => flushView(),
        invokeLua: (name, params) => invokeNamedFunction(app.lua, name, params, reportSeam),
        emitEvent: (name, data) => emitNamedEvent(app.lua, name, data, reportSeam),
      });
      app.engine = engine;
      await bootRuntime(app, scenario, {
        flushView: () => flushView(),
        applyUi: (command) => applyUiState(command, runtime),
        output,
        onError: reportProblem,
        audio: app.audio,
      });
      await engine.move(runtime.location);
      // A newer boot has already replaced everything this one built; announcing
      // it ready now would report a state that is no longer the app's.
      if (superseded()) return;
      if (problems === 0) {
        dom.diagnostics.textContent = "● Ready";
        dom.diagnostics.style.color = "#7cbd9a";
      } else {
        dom.diagnostics.textContent = `● ${problems} problem${problems === 1 ? "" : "s"} at boot — see transcript`;
        dom.diagnostics.style.color = "#d6a95c";
      }
      document.body.dataset.projectReady = "true";
      dom.decision.style.visibility = "visible";
      render();
    } catch (error) {
      const message = (error as Error).message;
      dom.diagnostics.textContent = `● ${message}`;
      dom.diagnostics.style.color = "#ee7c78";
      const entry = document.createElement("div");
      entry.className = "entry system";
      const paragraph = document.createElement("p");
      paragraph.textContent = message;
      entry.append(paragraph);
      dom.heroTerminal.replaceChildren(entry);
    }
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

  function persist(): Promise<void> {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    app.project = normalizeProject(app.project);
    if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.editor.getValue();
    return saveProject(app.project).catch((error) => {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
      throw error;
    });
  }

  /** Coalesce keystroke-driven saves; `persist` flushes any pending save. */
  function schedulePersist(): void {
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      void persist().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
  }

  function render(): void {
    if (app.runtime) renderDom(app);
  }

  /** The repaint gate: only a mutation that marked the view dirty costs a rebuild. */
  function flushView(): void {
    flushViewImpl(app.runtime, () => render());
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
    // The front matter is read from each stored project rather than remembered
    // on the record, so a card cannot describe an older draft of the work.
    const metas = await Promise.all(projects.map((project) => readScenarioMeta(project.vfs)));
    dom.projectList.replaceChildren();
    for (const [index, project] of projects.entries()) {
      const row = document.createElement("article");
      row.className = "project-card";
      row.dataset.project = project.identity.id;
      const heading = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = projectTitle(project);
      const meta = document.createElement("p");
      meta.textContent = projectCardMeta(project, metas[index]);
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
    app.activeAsset = null;
    dom.editorWrap.classList.remove("hidden");
    dom.assetPreview.classList.add("hidden");
    openInEditor(app, app.current);
    renderFileTree();
    renderTabs();
    await start();
    dom.projectOverlay.classList.add("hidden");
  }

  async function loadProject(id: string): Promise<void> {
    await persist();
    const selected = await getProject(id);
    if (!selected) throw new Error(`Scenario not found: ${id}`);
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
    app.openFiles = [...DEFAULT_OPEN_FILES];
    // The buffer is loaded before the tree and tabs are drawn, and this must not
    // go through `switchFile`: that flushes the editor first, which would write
    // the *previous* project's text over the new project's `scenario.yaml`.
    openInEditor(app, app.current);
    renderFileTree();
    renderTabs();
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
