import type {
  EngineApi,
  EngineRuntime,
  LuaEngine,
  OutputFn,
  ProjectData,
  ResolvedUiElement,
  Scenario,
} from "../types/index.ts";
import type { InkforgeCanvasRuntime } from "../canvas/runtime.ts";
import type { DomRefs } from "./dom.ts";

export type AppView = "play" | "author";

export interface AppContext {
  dom: DomRefs;
  project: ProjectData;
  scenario: Scenario | null;
  runtime: EngineRuntime | null;
  canvas: InkforgeCanvasRuntime | null;
  lua: LuaEngine | null;
  engine: EngineApi | null;
  output: OutputFn | null;
  current: string;
  openFiles: string[];

  initialise(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  showView(view: AppView): void;
  switchFile(path: string): void;
  closeFile(path: string): void;
  renderTabs(): void;
  syncEditor(): void;
  lineNumbers(): void;
  persist(): void;
  render(): void;
  runUiAction(element: ResolvedUiElement): Promise<void> | void;
  newProject(): Promise<void>;
  exportPack(): void;
  importPack(file: File): Promise<void>;
}
