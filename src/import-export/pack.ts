import { strToU8, unzipSync, zipSync } from "fflate";
import type { AppContext } from "../app/context.ts";
import { assetFromBlob, assetMime } from "../project/assets.ts";
import { normalizeProject, projectTitle } from "../project/project.ts";
import { getProject, putProject, setActiveProjectId } from "../project/storage.ts";
import { DEFAULT_OPEN_FILES } from "../editor/editor.ts";
import type { ProjectManifest } from "../types/index.ts";

function assertSafePath(path: string): void {
  if (
    !path || path === "manifest.json" || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid project path: ${path}`);
  }
}

function versionParts(version: string): number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid project version: ${version}`);
  return match.slice(1, 4).map(Number);
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
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
  versionParts(manifest.project.version);
  const seen = new Set<string>();
  for (const path of manifest.files) {
    assertSafePath(path);
    if (seen.has(path)) throw new Error(`Duplicate project path: ${path}`);
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
  const files = [...Object.keys(app.project.vfs), ...Object.keys(app.project.assets)].sort();
  const manifest: ProjectManifest = {
    format: "inkforge-pack",
    packVersion: 2,
    project: app.project.identity,
    files,
  };
  const archive: Record<string, Uint8Array> = { "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`) };
  for (const [path, content] of Object.entries(app.project.vfs)) archive[path] = new TextEncoder().encode(content);
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
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
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
        throw new Error(`Project source is not valid UTF-8: ${path}`);
      }
    }
  }
  const existing = await getProject(manifest.project.id);
  if (existing && compareVersions(manifest.project.version, existing.identity.version) <= 0) {
    app.dom.diagnostics.textContent = `● ${projectTitle(existing)} is already v${existing.identity.version}`;
    app.dom.diagnostics.style.color = "#d6a95c";
    return;
  }
  const project = normalizeProject({ identity: manifest.project, vfs, assets, pinned: existing?.pinned });
  await putProject(project);
  setActiveProjectId(project.identity.id);
  app.project = project;
  app.openFiles = [...DEFAULT_OPEN_FILES];
  app.current = "scenario.yaml";
  app.dom.code.value = app.project.vfs[app.current] ?? "";
  app.renderFileTree();
  app.renderTabs();
  await app.start();
}
