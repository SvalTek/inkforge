import type { AppContext, AppView } from "./context.ts";
import type { EngineRuntime, ResolvedUiElement } from "../types/index.ts";
import { bootRuntime } from "./boot.ts";
import { bindEvents } from "./events.ts";
import { queryDom } from "./dom.ts";
import { applyUi as applyUiState } from "../engine/ui-state.ts";
import { createEngine } from "../engine/engine.ts";
import { createOutput } from "../engine/events.ts";
import { composeScenario as composeScenarioImpl } from "../yaml/compose.ts";
import { normalizeProject } from "../project/project.ts";
import { loadSavedProject, saveProject } from "../project/storage.ts";
import { loadStarterProject } from "../project/starter.ts";
import {
  closeFile as closeFileImpl,
  DEFAULT_OPEN_FILES,
  lineNumbers as lineNumbersImpl,
  renderTabs as renderTabsImpl,
  switchFile as switchFileImpl,
  syncEditor as syncEditorImpl,
} from "../editor/editor.ts";
import { render as renderDom } from "../ui/render.ts";
import { runUiAction as runUiActionImpl } from "../ui/actions.ts";
import { exportPack as exportPackImpl, importPack as importPackImpl } from "../import-export/pack.ts";

/** Build the single app context and bind the DOM once. */
export function createApp(): AppContext {
  const dom = queryDom();

  const app: AppContext = {
    dom,
    project: normalizeProject({}),
    scenario: null,
    runtime: null,
    canvas: null,
    lua: null,
    engine: null,
    output: null,
    current: "scenario.yaml",
    openFiles: [...DEFAULT_OPEN_FILES],
    initialise,
    start,
    restart,
    showView,
    switchFile,
    closeFile,
    renderTabs,
    syncEditor,
    lineNumbers,
    persist,
    render,
    runUiAction,
    newProject,
    exportPack,
    importPack,
  };

  async function initialise(): Promise<void> {
    try {
      const saved = loadSavedProject();
      const starter = await loadStarterProject();
      app.project = normalizeProject(saved ?? starter);
      if (
        app.project.scenario?.includes("title: Lantern Below") &&
        app.project.scenario?.includes("A small project showing locations, items, actions, state, and inventory.")
      ) {
        app.project = starter;
        persist();
      }
      app.current = "scenario.yaml";
      dom.code.value = app.project.vfs[app.current] ?? "";
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
    if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = dom.code.value;
    app.project.scenario = app.project.vfs["scenario.yaml"] ?? "";
    app.project.script = app.project.vfs["scripts/main.lua"] ?? "";

    if (!app.project.scenario.trim()) {
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
      });
      engine.move(runtime.location);
      dom.diagnostics.textContent = "● Ready";
      dom.diagnostics.style.color = "#7cbd9a";
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
    switchFileImpl(app, path);
  }

  function closeFile(path: string): void {
    closeFileImpl(app, path);
  }

  function renderTabs(): void {
    renderTabsImpl(app);
  }

  function syncEditor(): void {
    syncEditorImpl(app);
  }

  function lineNumbers(): void {
    lineNumbersImpl(app);
  }

  function persist(): void {
    saveProject(app.project);
  }

  function render(): void {
    if (app.runtime) renderDom(app);
  }

  function runUiAction(element: ResolvedUiElement): Promise<void> | void {
    return runUiActionImpl(app, element);
  }

  async function newProject(): Promise<void> {
    app.project = await loadStarterProject();
    app.current = "scenario.yaml";
    app.dom.code.value = app.project.vfs["scenario.yaml"] ?? "";
    app.openFiles = [...DEFAULT_OPEN_FILES];
    persist();
    switchFile("scenario.yaml");
    await start();
  }

  function exportPack(): void {
    exportPackImpl(app);
  }

  function importPack(file: File): Promise<void> {
    return importPackImpl(app, file);
  }

  bindEvents(app);
  return app;
}
