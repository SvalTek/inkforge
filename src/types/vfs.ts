/**
 * Project virtual file system: maps a project-relative path to its file text.
 * Asset entries may hold `data:`/`blob:` URLs or plain paths.
 */
export type Vfs = Record<string, string>;

/** A project-relative VFS key, e.g. `scenario.yaml` or `scripts/main.lua`. */
export type VfsPath = string;

/** Result of resolving a raw import/mixin specifier against the project root. */
export interface VfsResolution {
  path: VfsPath;
}
