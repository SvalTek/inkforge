import type { AppContext } from "../app/context.ts";
import type { PackFile } from "../types/index.ts";
import { normalizeProject } from "../project/project.ts";
import { DEFAULT_OPEN_FILES } from "../editor/editor.ts";

/** Download the project as an `.inkforge` pack after flushing the editor. */
export function exportPack(app: AppContext): void {
  app.project = normalizeProject(app.project);
  if (app.project.vfs[app.current] !== undefined) app.project.vfs[app.current] = app.dom.code.value;
  app.project.scenario = app.project.vfs["scenario.yaml"] ?? "";
  app.project.script = app.project.vfs["scripts/main.lua"] ?? "";
  const data: PackFile = { format: "inkforge-pack", version: 1, files: app.project, assets: app.project.assets };
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  anchor.download = "adventure.inkforge";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** Load an `.inkforge` pack, switch to the scenario, and restart the engine. */
export async function importPack(app: AppContext, file: File): Promise<void> {
  const parsed = JSON.parse(await file.text()) as Partial<PackFile>;
  if (parsed.format !== "inkforge-pack") throw new Error("Invalid pack");
  app.project = normalizeProject({
    vfs: parsed.files?.vfs,
    assets: parsed.assets ?? parsed.files?.assets ?? [],
    scenario: parsed.files?.scenario,
    script: parsed.files?.script,
  });
  app.openFiles = [...DEFAULT_OPEN_FILES];
  app.current = "scenario.yaml";
  app.dom.code.value = app.project.vfs["scenario.yaml"] ?? "";
  app.persist();
  app.switchFile("scenario.yaml");
  await app.start();
}
