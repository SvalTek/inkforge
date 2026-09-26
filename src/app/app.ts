import type { AppContext, AppView } from "./context.ts";
import type {
  EngineRuntime,
  ProjectData,
  ResolvedUiElement,
  ResumedRuntime,
  SaveRecord,
  ToolEntry,
} from "../types/index.ts";
import { DEFAULT_SAVE_SLOT, SAVE_LIMITS, saveFileStem } from "../types/save.ts";
import { bootRuntime } from "./boot.ts";
import { bindEvents } from "./events.ts";
import { queryDom, $all } from "./dom.ts";
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
import { createEntry as createEntryImpl, type CreateKind, type CreateResult } from "../editor/tree.ts";
import { installEditorHarness } from "../editor/harness.ts";
import { render as renderDom } from "../ui/render.ts";
import { runToolAction as runToolActionImpl, runUiAction as runUiActionImpl } from "../ui/actions.ts";
import { exportPack as exportPackImpl, importPack as importPackImpl } from "../import-export/pack.ts";
import { createToolRegistry } from "../engine/tool-state.ts";
import { fromSnapshot, hashProjectSources, hashScenario, toSnapshot } from "../engine/save.ts";
import { deleteSave, getSave, listSaves, parseSaveFile, putSave, serializeSaveFile } from "../project/save-storage.ts";
import { AssetResolver } from "../project/assets.ts";
import { AudioManager } from "../audio/manager.ts";

/** Debounce window for coalescing keystroke-driven IndexedDB saves. */
const PERSIST_DEBOUNCE_MS = 400;
/** Build the single app context and bind the DOM once. */
export function createApp(): AppContext {
  const dom = queryDom();
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  // Create-dialog state: where the new entry goes, and of what kind. Held here
  // so the dialog and the explorer agree on the target without passing it
  // through the DOM.
  let createTarget = "";
  let createKind: CreateKind = "folder";
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
    expandedFolders: new Set<string>(),
    explorerProjectId: null,
    bootGeneration: 0,
    initialise,
    start,
    showView,
    switchFile,
    toggleFolder,
    openCreateDialog,
    setCreateKind,
    submitCreate,
    createEntry,
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
    saveGame,
    resumeSavedGame,
    openSaveManager,
    exportSave,
    importSaveFile,
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

  function start(resume?: ResumedRuntime | null): Promise<void> {
    const generation = ++app.bootGeneration;
    // Captured per call rather than read from a shared field when the boot
    // finally runs: `bootChain` serializes boots, so a resume requested now
    // must not leak into a later boot that a newer edit queued behind it.
    const requested = resume ?? null;
    bootChain = bootChain.then(() => bootOnce(generation, requested)).catch((error) => {
      dom.diagnostics.textContent = `● ${(error as Error).message}`;
      dom.diagnostics.style.color = "#ee7c78";
    });
    return bootChain;
  }

  async function bootOnce(generation: number, resume: ResumedRuntime | null): Promise<void> {
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
      // Nothing to continue into: the scenario is empty, so the save it was made
      // from cannot be resumed even though the slot may still exist.
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
      // A resumed save seeds the runtime before anything boots, so the entry
      // script's conditionals and top-level `GameState.set` calls see the
      // player's real progress instead of a fresh start.
      //
      // State is a merge, so a scenario that gained a key since the save still
      // gets its authored default. Inventory deliberately is not: a starting item
      // the player already consumed is absent from the save, so merging would
      // hand it back on every resume.
      const runtime: EngineRuntime = {
        location: resume?.location || scenario.startLocation,
        state: { ...(scenario.state || {}), ...(scenario.player?.state || {}), ...(resume?.state || {}) },
        inventory: resume ? [...resume.inventory] : [...(scenario.player?.inventory || [])],
        events: resume ? [...resume.events] : [],
        droppedEvents: resume?.droppedEvents ?? 0,
        over: resume?.over ?? false,
        ui: resume
          ? {
            hidden: new Set(resume.ui.hidden),
            overrides: { ...resume.ui.overrides },
            elements: [...resume.ui.elements],
          }
          : { hidden: new Set<string>(), overrides: {}, elements: [...(scenario.ui?.elements || [])] },
        modals: resume
          ? { open: resume.modals.open, activePages: { ...resume.modals.activePages } }
          : { open: null, activePages: {} },
        tools: createToolRegistry(scenario.tools || []),
        conversation: resume?.conversation ?? null,
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
      if (resume) {
        // Re-applied after boot rather than only seeded before it. An entry
        // script that calls `GameState.set` at the top level would otherwise
        // land the player back at the scenario's opening values, and `move` has
        // just narrated the room on top of the transcript they left behind —
        // restoring the entries last is what makes a resumed session read like
        // the same session rather than a fresh one with a fresh prologue.
        Object.assign(runtime.state, resume.state);
        runtime.ui.overrides = { ...resume.ui.overrides };
        runtime.ui.hidden = new Set(resume.ui.hidden);
        runtime.ui.elements = [...resume.ui.elements];
        runtime.tools = resume.tools;
        runtime.modals = { open: resume.modals.open, activePages: { ...resume.modals.activePages } };
        runtime.events = [...resume.events];
        runtime.droppedEvents = resume.droppedEvents;
        runtime.over = resume.over;
        runtime.conversation = resume.conversation;
        runtime.viewDirty = true;
      }
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
      // After the boot settles: a switch to another project changes which slot
      // Continue refers to, and asking before the scenario has composed would
      // answer for the project being left rather than the one being entered.
      await refreshActiveSave();
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

  function toggleFolder(path: string): void {
    if (app.expandedFolders.has(path)) app.expandedFolders.delete(path);
    else app.expandedFolders.add(path);
    renderFileTree();
  }

  function openCreateDialog(target: string): void {
    createTarget = target;
    // Adding to a folder almost always means a file; adding at the root almost
    // always means structure. Either is one click away in the dialog.
    createKind = target ? "yaml" : "folder";
    const label = target ? target.slice(target.lastIndexOf("/") + 1) : "project";
    dom.createTitle.textContent = target ? `New in ${label}` : "New in project";
    dom.createLabel.textContent = createKind === "folder" ? "Folder name" : "File name";
    dom.createName.value = "";
    dom.createError.textContent = "";
    setCreateKind(createKind);
    dom.createOverlay.classList.remove("hidden");
    dom.createName.focus();
  }

  function setCreateKind(kind: CreateKind): void {
    createKind = kind;
    dom.createLabel.textContent = kind === "folder" ? "Folder name" : "File name";
    for (const button of $all<HTMLButtonElement>("#createOverlay [data-create-kind]")) {
      const active = button.dataset.createKind === kind;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function submitCreate(): void {
    const result = createEntry(createTarget, createKind, dom.createName.value);
    if (!result.ok) {
      dom.createError.textContent = result.message ?? "That name cannot be used.";
      return;
    }
    dom.createOverlay.classList.add("hidden");
  }

  function createEntry(target: string, kind: CreateKind, name: string): CreateResult {
    const result = createEntryImpl(app.project.vfs, target, kind, name);
    if (!result.ok) return result;
    // Reveal what was just made: the folder it went into, and the folder that
    // holds it, so an author who collapsed the tree still sees their own result.
    if (target) app.expandedFolders.add(target);
    if (result.path) {
      const owner = result.path.slice(0, result.path.lastIndexOf("/"));
      if (owner) app.expandedFolders.add(owner);
      switchFile(result.path);
    } else if (result.marker) {
      // A folder was created; expand it so the author sees the result.
      const folderPath = result.marker.slice(0, result.marker.lastIndexOf("/"));
      if (folderPath) app.expandedFolders.add(folderPath);
    }
    renderFileTree();
    schedulePersist();
    return result;
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
    dom.projectOverlay.classList.add("hidden");
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

  // Saving -----------------------------------------------------------------
  //
  // One manual slot per project, keyed by project id, so a save belongs to the
  // scenario it was made in. Resuming is always an explicit choice: nothing
  // auto-resumes on boot, because a save that silently overwrites the author's
  // current playtest buffer is worse than one extra click.

  /** The active project's save, or null. Used for resume and import checks. */
  let activeSave: SaveRecord | null = null;

  async function refreshActiveSave(): Promise<void> {
    activeSave = (await getSave(app.project.identity.id)) ?? null;
  }

  /**
   * Identity of the authored content a save is made against.
   *
   * Every VFS source can affect composition or Lua behavior. Compared on resume
   * to warn, never to refuse: the player decides whether to continue.
   */
  function scenarioHash(): string {
    return hashProjectSources(app.project.vfs);
  }

  /** Existing saves used only the scenario entry file and main Lua script. */
  function legacyScenarioHash(): string {
    const scriptPath = app.scenario?.scripts?.main ?? "scripts/main.lua";
    return hashScenario(app.project.vfs["scenario.yaml"] ?? "", app.project.vfs[scriptPath] ?? "");
  }

  function reportStatus(message: string, color: string): void {
    dom.diagnostics.textContent = `● ${message}`;
    dom.diagnostics.style.color = color;
  }

  async function saveGame(): Promise<boolean> {
    if (!app.runtime) return false;
    const snapshot = toSnapshot(app.runtime);
    const record: SaveRecord = {
      projectId: app.project.identity.id,
      slot: DEFAULT_SAVE_SLOT,
      savedAt: Date.now(),
      location: snapshot.location,
      scenarioVersion: app.project.identity.version,
      scenarioHash: scenarioHash(),
      snapshot,
    };
    try {
      await putSave(record);
    } catch (error) {
      // Reported rather than thrown, and the previous save is left alone: a
      // failed write — a full disk, a private-mode quota — must not cost the
      // player the slot they already had.
      reportStatus(`Save failed: ${(error as Error).message}`, "#ee7c78");
      return false;
    }
    activeSave = record;
    reportStatus("Saved", "#7cbd9a");
    return true;
  }

  async function resumeSavedGame(slot: string = DEFAULT_SAVE_SLOT): Promise<void> {
    const record = activeSave?.slot === slot ? activeSave : await getSave(app.project.identity.id, slot);
    if (!record) {
      reportStatus("There is no save for this scenario", "#d6a95c");
      return;
    }
    const resumed = fromSnapshot(record.snapshot);
    if (!resumed) {
      reportStatus("That save could not be read", "#ee7c78");
      return;
    }
    if (
      record.scenarioHash && record.scenarioHash !== scenarioHash() &&
      record.scenarioHash !== legacyScenarioHash()
    ) {
      const proceed = globalThis.confirm(
        "This scenario has changed since the save was made. Resuming may leave the story in an odd place. Continue?",
      );
      if (!proceed) return;
    }
    await start(resumed);
  }

  /** Resume a save belonging to another project, switching to that project first. */
  async function resumeSaveFor(projectId: string, slot: string): Promise<void> {
    if (projectId !== app.project.identity.id) await loadProject(projectId);
    dom.saveOverlay.classList.add("hidden");
    // By slot rather than by project: the row that was clicked names one save,
    // and there is nothing here that would stop a second slot existing later.
    await resumeSavedGame(slot);
  }

  async function exportSave(projectId: string, slot: string = DEFAULT_SAVE_SLOT): Promise<void> {
    const record = await getSave(projectId, slot);
    if (!record) throw new Error("There is no save to export for that scenario.");
    const project = await getProject(projectId);
    const anchor = document.createElement("a");
    const body = new Blob([serializeSaveFile(record)], { type: "application/json" });
    anchor.href = URL.createObjectURL(body);
    anchor.download = `${saveFileStem(project ? projectTitle(project) : record.location, record.savedAt)}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  /**
   * Read a save file into the active project's slot.
   *
   * The file was exported from some other browser, so its `projectId` means
   * nothing here: the record is re-keyed onto the project the player is in and
   * the original is kept as provenance. The scenario-hash check on resume is
   * what catches a file that belongs to a different story.
   */
  async function importSaveFile(file: File): Promise<void> {
    if (file.size > SAVE_LIMITS.maxFileBytes) {
      throw new Error(`That save file is too large (limit ${Math.round(SAVE_LIMITS.maxFileBytes / 1024)} KB).`);
    }
    const record = parseSaveFile(await file.text());
    if (activeSave) {
      const overwrite = globalThis.confirm(
        `This scenario already has a save from ${new Date(activeSave.savedAt).toLocaleString()}. ` +
          "Replace it with the imported one?",
      );
      if (!overwrite) return;
    }
    await putSave({
      ...record,
      projectId: app.project.identity.id,
      slot: DEFAULT_SAVE_SLOT,
      origin: { projectId: record.projectId, savedAt: record.savedAt },
    });
    await refreshActiveSave();
    await openSaveManager();
    reportStatus("Save imported", "#7cbd9a");
  }

  async function deleteSaveFor(projectId: string, slot: string): Promise<void> {
    if (!globalThis.confirm("Delete this save? This cannot be undone.")) return;
    await deleteSave(projectId, slot);
    await refreshActiveSave();
    await openSaveManager();
  }

  async function openSaveManager(): Promise<void> {
    const [saves, projects] = await Promise.all([listSaves(), listProjects()]);
    const titles = new Map(projects.map((project) => [project.identity.id, projectTitle(project)]));
    dom.saveList.replaceChildren();
    if (!saves.length) {
      const empty = document.createElement("p");
      empty.className = "project-card";
      empty.textContent = "No saves yet. Play a scenario, then use Save in the header.";
      dom.saveList.append(empty);
    }
    for (const record of saves) {
      const row = document.createElement("article");
      row.className = "project-card";
      const heading = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = titles.get(record.projectId) ?? record.projectId;
      const meta = document.createElement("p");
      meta.textContent = `${record.location} — ${new Date(record.savedAt).toLocaleString()}`;
      heading.append(title, meta);
      if (record.origin) {
        const origin = document.createElement("p");
        origin.className = "save-origin";
        origin.textContent = "Imported from another browser";
        heading.append(origin);
      }
      if (record.projectId === app.project.identity.id) {
        const active = document.createElement("strong");
        active.className = "project-active";
        active.textContent = "Active";
        heading.prepend(active);
      }
      const actions = document.createElement("div");
      const resume = document.createElement("button");
      resume.type = "button";
      resume.textContent = "Resume";
      resume.onclick = () => void resumeSaveFor(record.projectId, record.slot);
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.textContent = "Export";
      exportButton.onclick = () =>
        void exportSave(record.projectId, record.slot).catch((error) => {
          reportStatus((error as Error).message, "#ee7c78");
        });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.onclick = () => void deleteSaveFor(record.projectId, record.slot);
      actions.append(resume, exportButton, remove);
      row.append(heading, actions);
      dom.saveList.append(row);
    }
    dom.saveOverlay.classList.remove("hidden");
  }

  bindEvents(app);
  return app;
}
