import type {
  EngineApi,
  EngineRuntime,
  LuaEngine,
  OutputFn,
  ProjectData,
  ResolvedUiElement,
  Scenario,
  ToolEntry,
} from "../types/index.ts";
import type { InkforgeCanvasRuntime } from "../canvas/runtime.ts";
import type { DomRefs } from "./dom.ts";
import type { AssetResolver } from "../project/assets.ts";
import type { AudioManager } from "../audio/manager.ts";

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
  assetResolver: AssetResolver;
  audio: AudioManager;
  current: string;
  openFiles: string[];
  activeAsset: string | null;
  assetsExpanded: boolean;

  initialise(): Promise<void>;
  start(): Promise<void>;
  restart(): Promise<void>;
  showView(view: AppView): void;
  switchFile(path: string): void;
  previewAsset(path: string): void;
  closeFile(path: string): void;
  renderFileTree(): void;
  renderTabs(): void;
  syncEditor(): void;
  lineNumbers(): void;
  persist(): Promise<void>;
  render(): void;
  runUiAction(element: ResolvedUiElement): Promise<void> | void;
  runToolAction(entry: ToolEntry): Promise<void> | void;
  newProject(): Promise<void>;
  openProjectLibrary(): Promise<void>;
  loadProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  exportPack(): void;
  importPack(file: File): Promise<void>;
}
