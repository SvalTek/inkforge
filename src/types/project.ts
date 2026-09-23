import type { Vfs } from "./vfs.ts";

/**
 * Normalized in-memory project (`projectFiles` output): a VFS plus the two
 * canonical source files kept in sync with it.
 */
export interface ProjectData {
  vfs: Vfs;
  assets: string[];
  scenario: string;
  script: string;
}

/**
 * Loose persisted/imported project shape (localStorage `inkforge-project-v1`
 * and legacy packs). The legacy `scenario`/`script` keys stay accepted.
 */
export interface RawProjectData {
  vfs?: Vfs;
  assets?: string[];
  scenario?: string;
  script?: string;
}

/** On-disk `.inkforge` export/import payload (`format` guard plus files). */
export interface PackFile {
  format: "inkforge-pack";
  version: number;
  files: ProjectData;
  assets: string[];
}

/** Bundled template manifest: the list of template file paths to fetch. */
export type TemplateManifest = string[];
