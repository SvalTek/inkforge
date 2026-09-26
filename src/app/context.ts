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
import type { CreateKind, CreateResult } from "../editor/tree.ts";
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
  /**
   * Folder paths the explorer is showing. Held here rather than in the DOM so a
   * collapse survives the repaints that editing triggers.
   */
  expandedFolders: Set<string>;
  /** Which project's `expandedFolders` describes; a change reseeds it. */
  explorerProjectId: string | null;
  /** Incremented per boot request; a boot whose generation is stale stands down. */
  bootGeneration: number;

  initialise(): Promise<void>;
  start(): Promise<void>;
  showView(view: AppView): void;
  switchFile(path: string): void;
  toggleFolder(path: string): void;
  /** Open the create dialog for `target`; `""` is the project root. */
  openCreateDialog(target: string): void;
  setCreateKind(kind: CreateKind): void;
  submitCreate(): void;
  /** Create and, for a file, open it. Returns the outcome for the dialog to show. */
  createEntry(target: string, kind: CreateKind, name: string): CreateResult;
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
