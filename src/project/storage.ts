import type { ProjectData, RawProjectData } from "../types/index.ts";

export const PROJECT_KEY = "inkforge-project-v1";

export function saveProject(project: ProjectData): void {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
}

export function loadSavedProject(): RawProjectData | null {
  const saved = localStorage.getItem(PROJECT_KEY);
  if (saved === null) return null;
  return JSON.parse(saved) as RawProjectData;
}
