import type { Vfs } from "./vfs.ts";

export const PACK_VERSION = 2 as const;

export interface ProjectIdentity {
  id: string;
  title?: string;
  author?: string;
  version: string;
}

export interface ProjectManifest {
  format: "inkforge-pack";
  packVersion: typeof PACK_VERSION;
  project: ProjectIdentity;
  files: string[];
}

export interface ProjectAsset {
  path: string;
  mime: string;
  size: number;
  data: Blob;
}

/** The active project record stored in the IndexedDB library. */
export interface ProjectData {
  identity: ProjectIdentity;
  vfs: Vfs;
  assets: Record<string, ProjectAsset>;
  updatedAt: number;
  pinned?: boolean;
}

/** Loose legacy shape accepted only for the one-time localStorage migration. */
export interface RawProjectData {
  identity?: Partial<ProjectIdentity>;
  vfs?: Vfs;
  assets?: string[] | Record<string, ProjectAsset>;
  scenario?: string;
  script?: string;
  updatedAt?: number;
  pinned?: boolean;
}

export interface PackFile {
  manifest: ProjectManifest;
  entries: Record<string, string | Blob>;
}

/** Bundled starter manifest file list retained as a loader convenience. */
export type TemplateManifest = string[];
