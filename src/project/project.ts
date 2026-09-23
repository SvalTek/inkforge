import type { ProjectData, RawProjectData } from "../types/index.ts";

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

export function normalizeProject(project: RawProjectData): ProjectData {
  const vfs = project.vfs ?? {
    "scenario.yaml": project.scenario ?? "",
    "scripts/main.lua": project.script ?? "",
  };
  return {
    ...project,
    vfs,
    scenario: vfs["scenario.yaml"] ?? project.scenario ?? "",
    script: vfs["scripts/main.lua"] ?? project.script ?? "",
    assets: project.assets ?? [],
  };
}
