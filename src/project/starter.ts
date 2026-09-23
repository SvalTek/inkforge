import type { ProjectData, ProjectManifest } from "../types/index.ts";
import { normalizeProject } from "./project.ts";
import { assetFromBlob, isAssetPath } from "./assets.ts";

export const TEMPLATE_BASE = "templates/lantern-below";

export async function loadStarterProject(): Promise<ProjectData> {
  const manifestResponse = await fetch(`${TEMPLATE_BASE}/manifest.json`);
  if (!manifestResponse.ok) throw Error("Bundled starter manifest could not be loaded");
  const manifest = await manifestResponse.json() as ProjectManifest;
  const entries = await Promise.all(manifest.files.map(async (path) => {
    const response = await fetch(`${TEMPLATE_BASE}/${path}`);
    if (!response.ok) throw Error(`Bundled file could not be loaded: ${path}`);
    if (isAssetPath(path)) return [path, assetFromBlob(path, await response.blob())] as const;
    return [path, await response.text()] as const;
  }));
  const vfs = Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const assets = Object.fromEntries(
    entries.filter((entry): entry is [string, ReturnType<typeof assetFromBlob>] => typeof entry[1] !== "string"),
  );
  const project = normalizeProject({ vfs, assets, identity: manifest.project, pinned: true });
  return project;
}
