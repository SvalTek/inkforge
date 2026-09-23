import { assetFromValue, isAssetPath } from "./assets.ts";
import type { ProjectData, ProjectIdentity, RawProjectData } from "../types/index.ts";

export const TEMPLATE_PATHS: readonly string[] = [
  "scenario.yaml",
  "state.yml",
  "player.yml",
  "ui.yml",
  "definitions.yml",
  "instances.yml",
  "locations.yml",
  "scripts/main.lua",
  "scripts/threshold.lua",
];

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
