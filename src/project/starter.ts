import type { ProjectData } from "../types/index.ts";
import { normalizeProject, TEMPLATE_PATHS } from "./project.ts";

export const TEMPLATE_BASE = "templates/lantern-below";

export async function loadStarterProject(): Promise<ProjectData> {
  const entries = Object.fromEntries(
    await Promise.all(
      TEMPLATE_PATHS.map(async (path): Promise<[string, string]> => {
        const response = await fetch(`${TEMPLATE_BASE}/${path}`);
        if (!response.ok) throw Error(`Bundled file could not be loaded: ${path}`);
        return [path, await response.text()];
      }),
    ),
  );
  return normalizeProject({ vfs: entries, assets: [] });
}
