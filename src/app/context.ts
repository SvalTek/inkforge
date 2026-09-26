import type LuaBridge from "WebLuaBridge";
import type {
  EngineApi,
  EngineRuntime,
  OutputFn,
  ProjectData,
  ResolvedUiElement,
  Scenario,
  ToolEntry,
} from "../types/index.ts";
import type { InkforgeCanvasRuntime } from "../canvas/runtime.ts";
import type { CodeEditor } from "../editor/codemirror.ts";
import type { DomRefs } from "./dom.ts";
import type { AssetResolver } from "../project/assets.ts";
import type { AudioManager } from "../audio/manager.ts";

export type AppView = "play" | "author";

export interface AppContext {
  dom: DomRefs;
  /** The Author view's source editor. Owns the buffer; `project.vfs` mirrors it. */
  editor: CodeEditor;
  project: ProjectData;
  scenario: Scenario | null;
  runtime: EngineRuntime | null;
  canvas: InkforgeCanvasRuntime | null;
  lua: LuaBridge | null;
  engine: EngineApi | null;
  output: OutputFn | null;
  assetResolver: AssetResolver;
  audio: AudioManager;
  current: string;
  openFiles: string[];
  activeAsset: string | null;
  assetsExpanded: boolean;
  /** Incremented per boot request; a boot whose generation is stale stands down. */
  bootGeneration: number;

  initialise(): Promise<void>;
  start(): Promise<void>;
  showView(view: AppView): void;
  switchFile(path: string): void;
  previewAsset(path: string): void;
  closeFile(path: string): void;
  renderFileTree(): void;
  renderTabs(): void;
  syncEditor(): void;
  persist(): Promise<void>;
  schedulePersist(): void;
  render(): void;
  /** Repaint if a mutation marked the view dirty; a no-op otherwise. */
  flushView(): void;
  runUiAction(element: ResolvedUiElement): Promise<void> | void;
  runToolAction(entry: ToolEntry): Promise<void> | void;
  newProject(): Promise<void>;
  openProjectLibrary(): Promise<void>;
  loadProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  exportPack(): void;
  importPack(file: File): Promise<void>;
}
