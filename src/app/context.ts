import type LuaBridge from "WebLuaBridge";
import type {
  EngineApi,
  EngineRuntime,
  OutputFn,
  ProjectData,
  ResolvedUiElement,
  ResumedRuntime,
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
  /** Entry script currently protected by the Author explorer. */
  protectedScript: string;
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
  /** Boot the project. Pass a snapshot to resume that save instead of starting fresh. */
  start(resume?: ResumedRuntime | null): Promise<void>;
  showView(view: AppView): void;
  switchFile(path: string): void;
  toggleFolder(path: string): void;
  /** Open the create dialog for `target`; `""` is the project root. */
  openCreateDialog(target: string): void;
  setCreateKind(kind: CreateKind): void;
  submitCreate(): void;
  /** Create and, for a file, open it. Returns the outcome for the dialog to show. */
  createEntry(target: string, kind: CreateKind, name: string): CreateResult;
  /** Open the deletion confirmation for a source file, folder, or asset. */
  deleteExplorerEntry(kind: "file" | "folder" | "asset", path: string): Promise<void>;
  cancelDeleteExplorerEntry(): void;
  confirmDeleteExplorerEntry(): Promise<void>;
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

  // Saves: one manual slot per project, resumed only on an explicit request.
  /** Snapshot the live run into this project's slot. False when there is no run to save. */
  saveGame(): Promise<boolean>;
  /** Boot the active project from its save, or do nothing when it has none. */
  resumeSavedGame(slot?: string): Promise<void>;
  openSaveManager(): Promise<void>;
  exportSave(projectId: string, slot?: string): Promise<void>;
  /** Read an exported save file into the active project's slot. */
  importSaveFile(file: File): Promise<void>;
}
