/**
 * The Author explorer's folder model.
 *
 * The VFS is flat — `Record<string, string>` keyed by project-relative path — so
 * folders are not entities, only shared path prefixes. Two consequences live
 * here, and nowhere else:
 *
 * - Folders are derived. `buildFileTree` groups the VFS into a real nested tree
 *   instead of pretending a fixed root and one flat row per path.
 * - A folder with no files has no key to hang its existence on, so creation
 *   writes a reserved marker inside it. The marker is real VFS state, which
 *   means the folder survives a save; it is hidden from the tree, the editor,
 *   and the exported pack, because it is bookkeeping rather than authored work.
 */
import { isAssetPath } from "../project/assets.ts";

/** Reserved basename that records an empty folder's existence in the VFS. */
export const FOLDER_MARKER = ".inkforge-dir";

/** The things the Author view can create. Assets arrive through the upload button. */
export type CreateKind = "folder" | "yaml" | "lua";

/** Extensions each creatable file kind accepts, in the order the errors list them. */
const CREATE_EXTENSIONS: Record<Exclude<CreateKind, "folder">, readonly string[]> = {
  yaml: [".yaml", ".yml"],
  lua: [".lua"],
};

const DEFAULT_EXTENSION: Record<Exclude<CreateKind, "folder">, string> = {
  yaml: ".yaml",
  lua: ".lua",
};

export interface TreeFolder {
  kind: "folder";
  /** Project-relative folder path; `""` for the project root. */
  path: string;
  /** The final segment only, as shown in the explorer. */
  name: string;
  children: TreeEntry[];
}

export interface TreeFile {
  kind: "file";
  path: string;
  name: string;
}

export type TreeEntry = TreeFolder | TreeFile;

export interface CreateResult {
  ok: boolean;
  /** Set when `ok` is false, phrased for the dialog to show verbatim. */
  message?: string;
  /** The created file's path; `""` when a folder was created. */
  path: string;
  /** The marker written to record a new empty folder; `""` otherwise. */
  marker: string;
  kind: CreateKind;
}

/** True when `path` is the reserved empty-folder marker itself. */
export function isFolderMarker(path: string): boolean {
  return path === FOLDER_MARKER || path.endsWith(`/${FOLDER_MARKER}`);
}

/** Natural, case-insensitive name order, so `part2` sorts before `part10`. */
function byName(a: TreeEntry, b: TreeEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  files: Map<string, TreeFile>;
  marker: boolean;
}

function emptyFolder(name: string, path: string): MutableFolder {
  return { name, path, folders: new Map(), files: new Map(), marker: false };
}

/** Walk to the folder at `segments`, creating the levels that are missing. */
function descend(root: MutableFolder, segments: readonly string[]): MutableFolder {
  let current = root;
  for (const segment of segments) {
    let next = current.folders.get(segment);
    if (!next) {
      const path = current.path ? `${current.path}/${segment}` : segment;
      next = emptyFolder(segment, path);
      current.folders.set(segment, next);
    }
    current = next;
  }
  return current;
}

/** Materialise a mutable folder: folders first, then files, both name-ordered. */
function publish(folder: MutableFolder): TreeEntry[] {
  const folders: TreeEntry[] = [...folder.folders.values()].map((child) => ({
    kind: "folder" as const,
    path: child.path,
    name: child.name,
    children: publish(child),
  }));
  folders.sort(byName);
  const files = [...folder.files.values()];
  files.sort(byName);
  return [...folders, ...files];
}

/**
 * Group the VFS into the explorer's top-level entries.
 *
 * Assets are excluded: they live in `project.assets`, not the VFS, and the
 * explorer renders them as their own group. Markers are excluded too — the
 * folder they stand for is the visible result, never the marker itself.
 */
export function buildFileTree(vfs: Record<string, string>): TreeEntry[] {
  const root = emptyFolder("", "");
  for (const path of Object.keys(vfs)) {
    // A file's content is irrelevant to its existence: a freshly created file is
    // empty, and the explorer must still show it.
    if (isAssetPath(path)) continue;
    if (isFolderMarker(path)) {
      // `rooms/.inkforge-dir` stands for `rooms`; `rooms/deep/.inkforge-dir`
      // stands for `rooms/deep`, which is why the directory is dropped first.
      const owner = path.slice(0, FOLDER_MARKER.length + 1);
      descend(root, owner ? owner.slice(0, -1).split("/").filter(Boolean) : []).marker = true;
      continue;
    }
    const segments = path.split("/").filter(Boolean);
    const name = segments.pop();
    if (!name) continue;
    descend(root, segments).files.set(name, { kind: "file", path, name });
  }
  return publish(root);
}

/** Every folder path in the tree, in display order. */
export function folderPaths(entries: readonly TreeEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "folder") continue;
    paths.push(entry.path, ...folderPaths(entry.children));
  }
  return paths;
}

/** True when anything in the VFS already occupies `path` as a file or a folder. */
function occupied(vfs: Record<string, string>, path: string): boolean {
  if (vfs[path] !== undefined) return true;
  const prefix = `${path}/`;
  return Object.keys(vfs).some((key) => key.startsWith(prefix));
}

function extensionList(kind: Exclude<CreateKind, "folder">): string {
  const extensions = CREATE_EXTENSIONS[kind];
  return extensions.map((extension) => extension.slice(1)).join(" or ");
}

/**
 * Reduce typed input to a single safe path segment, or explain why it cannot be.
 *
 * Names are one segment by design: an author adding a file to `rooms` should not
 * have to know or type the parent path, and a name carrying a separator would
 * silently create a folder the dialog never showed them.
 */
function resolveName(kind: CreateKind, input: string): { name: string } | { message: string } {
  const name = input.trim();
  if (!name) return { message: "Enter a name." };
  if (name.includes("/") || name.includes("\\")) {
    return { message: "Use a single name — add it to the folder you want instead." };
  }
  if (name.startsWith(".")) return { message: "Names starting with a dot are reserved." };
  if (kind === "folder") return { name };

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (!stem) return { message: "Enter a name before the extension." };
  if (extension && !CREATE_EXTENSIONS[kind].includes(extension)) {
    return { message: `Only ${extensionList(kind)} files can be created here.` };
  }
  return { name: `${stem}${extension || DEFAULT_EXTENSION[kind]}` };
}

/**
 * Create a folder or supported file in the VFS.
 *
 * A new folder is recorded with a marker; a new file drops its folder's marker
 * when that file is the first real thing under it, because the folder is now
 * held by a real key and the marker would only be noise. Failure leaves the VFS
 * untouched, so the dialog can report and let the author try again.
 */
export function createEntry(vfs: Record<string, string>, target: string, kind: CreateKind, input: string): CreateResult {
  const resolved = resolveName(kind, input);
  if ("message" in resolved) return { ok: false, message: resolved.message, path: "", marker: "", kind };
  const name = resolved.name;
  const path = target ? `${target}/${name}` : name;
  if (occupied(vfs, path)) return { ok: false, message: `${name} already exists.`, path: "", marker: "", kind };

  if (kind === "folder") {
    const marker = `${path}/${FOLDER_MARKER}`;
    vfs[marker] = "";
    return { ok: true, path: "", marker, kind };
  }

  vfs[path] = "";
  let marker = "";
  if (target) {
    const targetMarker = `${target}/${FOLDER_MARKER}`;
    // If the folder was held only by its marker (no other files), remove the
    // marker now that a real file exists.
    if (vfs[targetMarker] !== undefined) {
      const hasOtherFiles = Object.keys(vfs).some((key) =>
        key.startsWith(`${target}/`) && key !== targetMarker && key !== path
      );
      if (!hasOtherFiles) {
        delete vfs[targetMarker];
        marker = targetMarker;
      }
    }
  }
  return { ok: true, path, marker, kind };
}
