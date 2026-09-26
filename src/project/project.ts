import { assetFromValue, isAssetPath } from "./assets.ts";
import type { ProjectData, ProjectIdentity, RawProjectData, ScenarioMeta } from "../types/index.ts";

const DEFAULT_IDENTITY: ProjectIdentity = { id: "local-project", title: "Untitled Adventure", version: "0.1.0" };

export function normalizeProject(project: RawProjectData): ProjectData {
  const source = project.vfs ?? {
    "scenario.yaml": project.scenario ?? "",
    "scripts/main.lua": project.script ?? "",
  };
  const vfs: Record<string, string> = {};
  const assets: Record<string, NonNullable<ReturnType<typeof assetFromValue>>> = {};
  for (const [path, value] of Object.entries(source)) {
    if (isAssetPath(path)) {
      const asset = assetFromValue(path, value);
      if (asset) assets[path] = asset;
    } else vfs[path] = value;
  }
  if (project.assets && !Array.isArray(project.assets)) {
    for (const [path, asset] of Object.entries(project.assets)) assets[path] = asset;
  }
  const identity: ProjectIdentity = {
    ...DEFAULT_IDENTITY,
    ...project.identity,
    id: project.identity?.id || DEFAULT_IDENTITY.id,
    version: project.identity?.version || DEFAULT_IDENTITY.version,
  };
  return {
    identity,
    vfs,
    assets,
    updatedAt: project.updatedAt ?? Date.now(),
    pinned: project.pinned,
  };
}

export function projectTitle(project: ProjectData): string {
  return project.identity.title || project.identity.id;
}

/**
 * The library card's description line: the work's own front matter, then when
 * the record was last written.
 *
 * The version shown is `meta.version`, not the manifest's — a card describes
 * the work, and `project.version` is a record of the files that decides whether
 * an import lands. The two are independent, so the card would otherwise show a
 * number that moves for reasons the author never chose.
 *
 * Segments are dropped rather than left empty, so a project with no description
 * reads `v1.0 · Updated …` instead of opening on a separator.
 */
export function projectCardMeta(project: ProjectData, meta: ScenarioMeta | undefined): string {
  const description = meta?.description?.trim();
  const version = meta?.version?.trim();
  return [
    description,
    version ? `v${version}` : "",
    `Updated ${new Date(project.updatedAt).toLocaleString()}`,
  ].filter(Boolean).join(" · ");
}
