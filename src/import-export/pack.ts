import { strToU8, unzipSync, zipSync } from "fflate";
import type { AppContext } from "../app/context.ts";
import { assetFromBlob, assetMime } from "../project/assets.ts";
import { normalizeProject, projectTitle } from "../project/project.ts";
import { getProject, putProject, setActiveProjectId } from "../project/storage.ts";
import { DEFAULT_OPEN_FILES, openInEditor } from "../editor/editor.ts";
import { isFolderMarker } from "../editor/tree.ts";
import type { ProjectManifest } from "../types/index.ts";

function assertSafePath(path: string): void {
  if (isFolderMarker(path)) throw new Error(`Reserved empty-folder marker path: ${path}`);
  if (
    !path || path === "manifest.json" || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid scenario path: ${path}`);
  }
}

/** Defensive limits applied to untrusted `.inkforge` archives. */
export const PACK_LIMITS = {
  /** Maximum compressed upload size. */
  compressedBytes: 16 * 1024 * 1024,
  /** Maximum number of ZIP entries. */
  entries: 256,
  /** Maximum uncompressed size of a single entry. */
  entryBytes: 8 * 1024 * 1024,
  /** Maximum combined uncompressed size. */
  totalBytes: 32 * 1024 * 1024,
} as const;

/** Raised when an archive exceeds {@link PACK_LIMITS}; surfaced to the user. */
class PackLimitError extends Error {}

function formatLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

/** Parse `x.y.z[-prerelease]`, rejecting anything the manifest validation rejects. */
function parseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) throw new Error(`Invalid package version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * SemVer precedence (https://semver.org/#spec-item-11): compare the numeric core,
 * then let a stable release outrank its prerelease, then compare prerelease
 * identifiers one by one (numeric identifiers numerically, alphanumeric in ASCII
 * order, numeric below alphanumeric, fewer identifiers below more).
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return Number(x) > Number(y) ? 1 : -1;
    if (numericX) return -1;
    if (numericY) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function bytesBlob(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

function validateManifest(value: unknown): ProjectManifest {
  if (!value || typeof value !== "object") throw new Error("Package manifest is not an object");
  const manifest = value as Partial<ProjectManifest>;
  if (
    manifest.format !== "inkforge-pack" || manifest.packVersion !== 2 || typeof manifest.project?.id !== "string" ||
    !manifest.project.id.trim() || typeof manifest.project.version !== "string" || !manifest.project.version.trim() ||
    !Array.isArray(manifest.files) || !manifest.files.every((path) => typeof path === "string")
  ) {
    throw new Error("Unsupported Inkforge package; expected pack version 2");
  }
  parseVersion(manifest.project.version);
  const seen = new Set<string>();
  for (const path of manifest.files) {
    assertSafePath(path);
    if (seen.has(path)) throw new Error(`Duplicate scenario path: ${path}`);
    seen.add(path);
  }
  if (!seen.has("scenario.yaml") || !seen.has("scripts/main.lua")) {
    throw new Error("Package must include scenario.yaml and scripts/main.lua");
  }
  return manifest as ProjectManifest;
}

/** Download the active project as a version-2 ZIP package. */
export async function exportPack(app: AppContext): Promise<void> {
  await app.persist();
  // Empty-folder markers are bookkeeping for the explorer, not authored work;
  // they must not travel with the pack.
  const vfsKeys = Object.keys(app.project.vfs).filter((key) => !isFolderMarker(key));
  const files = [...vfsKeys, ...Object.keys(app.project.assets)].sort();
  const manifest: ProjectManifest = {
    format: "inkforge-pack",
    packVersion: 2,
    project: app.project.identity,
    files,
  };
  const archive: Record<string, Uint8Array> = { "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`) };
  for (const [path, content] of Object.entries(app.project.vfs)) {
    if (isFolderMarker(path)) continue;
    archive[path] = new TextEncoder().encode(content);
  }
  for (const [path, asset] of Object.entries(app.project.assets)) {
    archive[path] = new Uint8Array(await asset.data.arrayBuffer());
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(bytesBlob(zipSync(archive), "application/zip"));
  anchor.download = `${projectTitle(app.project).replace(/[^\w.-]+/g, "-") || "adventure"}.inkforge`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** Import a version-2 ZIP, upserting only newer project versions. */
export async function importPack(app: AppContext, file: File): Promise<void> {
  await app.persist();
  if (file.size > PACK_LIMITS.compressedBytes) {
    throw new PackLimitError(`Package is too large (limit ${formatLimit(PACK_LIMITS.compressedBytes)}).`);
  }
  let entryCount = 0;
  let totalBytes = 0;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => {
        entryCount += 1;
        if (entryCount > PACK_LIMITS.entries) {
          throw new PackLimitError(`Package has too many entries (limit ${PACK_LIMITS.entries}).`);
        }
        if (entry.originalSize > PACK_LIMITS.entryBytes) {
          throw new PackLimitError(
            `Package entry is too large (limit ${formatLimit(PACK_LIMITS.entryBytes)}): ${entry.name}`,
          );
        }
        totalBytes += entry.originalSize;
        if (totalBytes > PACK_LIMITS.totalBytes) {
          throw new PackLimitError(`Package expands beyond the limit (${formatLimit(PACK_LIMITS.totalBytes)}).`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof PackLimitError) throw error;
    throw new Error("Invalid .inkforge ZIP package");
  }
  const manifestBytes = archive["manifest.json"];
  if (!manifestBytes) throw new Error("Package is missing manifest.json");
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  const vfs: Record<string, string> = {};
  const assets: Record<string, ReturnType<typeof assetFromBlob>> = {};
  for (const path of manifest.files) {
    const bytes = archive[path];
    if (!bytes) throw new Error(`Package is missing ${path}`);
    if (path.startsWith("assets/")) {
      const mime = assetMime(path);
      if (!mime) throw new Error(`Unsupported asset type: ${path}`);
      assets[path] = assetFromBlob(path, bytesBlob(bytes, mime), mime);
    } else {
      try {
        vfs[path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`Scenario source is not valid UTF-8: ${path}`);
      }
    }
  }
  const existing = await getProject(manifest.project.id);
  if (existing && compareVersions(manifest.project.version, existing.identity.version) <= 0) {
    app.dom.diagnostics.textContent = `● ${projectTitle(existing)} is already v${existing.identity.version}`;
    app.dom.diagnostics.style.color = "#d6a95c";
    app.dom.projectOverlay.classList.add("hidden");
    return;
  }
  const project = normalizeProject({ identity: manifest.project, vfs, assets, pinned: existing?.pinned });
  await putProject(project);
  setActiveProjectId(project.identity.id);
  app.project = project;
  app.openFiles = [...DEFAULT_OPEN_FILES];
  app.current = "scenario.yaml";
  app.activeAsset = null;
  app.dom.editorWrap.classList.remove("hidden");
  app.dom.assetPreview.classList.add("hidden");
  openInEditor(app, app.current);
  app.renderFileTree();
  app.renderTabs();
  await app.start();
  app.dom.projectOverlay.classList.add("hidden");
}
