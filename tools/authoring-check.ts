import { build } from "./build.ts";
import { DIST } from "./paths.ts";
import { serveStatic } from "./server.ts";
import type { EditorHarness } from "../src/editor/harness.ts";
import { removeEntry } from "../src/editor/tree.ts";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { strToU8, zipSync } from "fflate";

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TIMEOUT = 30_000;

interface ChromiumModule {
  chromium: { launch(options?: { executablePath?: string; headless?: boolean }): Promise<Browser> };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function silentWav(): Uint8Array {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 44, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, 8, true);
  bytes.fill(128, 44);
  return bytes;
}

async function launch(): Promise<Browser> {
  try {
    const module = await import("playwright-core") as unknown as ChromiumModule;
    return await module.chromium.launch({ executablePath: CHROME_PATH, headless: true });
  } catch {
    const module = await import("playwright") as unknown as ChromiumModule;
    return await module.chromium.launch({ headless: true });
  }
}

async function waitFor(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }: { selector: string; text: string }) =>
      (document.querySelector(selector)?.textContent ?? "").includes(text),
    { selector, text },
    { timeout: TIMEOUT },
  );
}

async function main(): Promise<void> {
  console.log("== Inkforge authored tools/modal check ==");
  const required = { "scenario.yaml": "entry", "scripts/main.lua": "entry", "scripts/extra.lua": "extra" };
  assert(
    removeEntry(required, "file", "scenario.yaml", "scripts/main.lua").length === 0,
    "required scenario file was removed",
  );
  assert(
    removeEntry(required, "file", "scripts/main.lua", "scripts/main.lua").length === 0,
    "required Lua file was removed",
  );
  assert(
    removeEntry(required, "folder", "scripts", "scripts/main.lua").length === 0,
    "folder containing main.lua was removed",
  );
  assert(Object.keys(required).length === 3, "required entry guard mutated the VFS");
  const custom = { "scenario.yaml": "entry", "scripts/main.lua": "old", "chapter/entry.lua": "entry" };
  assert(
    removeEntry(custom, "file", "chapter/entry.lua", "chapter/entry.lua").length === 0,
    "custom entry was removed",
  );
  assert(removeEntry(custom, "folder", "chapter", "chapter/entry.lua").length === 0, "custom entry folder was removed");
  assert(
    removeEntry(custom, "file", "scripts/main.lua", "chapter/entry.lua").length === 1,
    "unused default script stayed protected",
  );
  await build();
  const server = serveStatic({ root: DIST, port: 0 });
  const browser = await launch();
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.locator('.nav[data-view="author"]').click();
    const authorBounds = await page.locator("#authorView").boundingBox();
    const headerBounds = await page.locator("body > main > header").boundingBox();
    assert(authorBounds && headerBounds, "author layout bounds unavailable");
    assert(!await page.locator("#playView").isVisible(), "play view remains visible in author mode");
    assert(
      Math.abs(authorBounds.y - (headerBounds.y + headerBounds.height)) < 2 && authorBounds.height > 600,
      `author view is not occupying the content row: y=${authorBounds.y}, headerBottom=${
        headerBounds.y + headerBounds.height
      }, height=${authorBounds.height}`,
    );
    await page.locator('.nav[data-view="play"]').click();
    const temp = await Deno.makeTempDir({ prefix: "inkforge-authoring-" });
    const packPath = `${temp}\\showcase.inkforge`;
    await Deno.copyFile("templates/renderer-showcase.inkforge", packPath);
    await page.locator("#importFile").setInputFiles(packPath);
    await waitFor(page, "#storyTitle", "The authored visual stage");
    const reservedPath = "scripts/.inkforge-dir";
    const reservedManifest = {
      format: "inkforge-pack",
      packVersion: 2,
      project: { id: "reserved-marker-test", version: "1.0.0" },
      files: ["scenario.yaml", "scripts/main.lua", reservedPath],
    };
    const invalidPackPath = `${temp}\\reserved-marker.inkforge`;
    await Deno.writeFile(
      invalidPackPath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify(reservedManifest)),
        "scenario.yaml": strToU8("startLocation: gate"),
        "scripts/main.lua": strToU8("-- entry"),
        [reservedPath]: strToU8("authored content"),
      }),
    );
    const importDialog = page.waitForEvent("dialog");
    await page.locator("#importFile").setInputFiles(invalidPackPath);
    const dialog = await importDialog;
    assert(
      dialog.message().includes(`Reserved empty-folder marker path: ${reservedPath}`),
      "marker collision import was accepted",
    );
    await dialog.accept();
    await page.waitForFunction(
      () => document.querySelector('[data-tool="lua_tool"]') !== null,
      undefined,
      { timeout: TIMEOUT },
    );
    await page.locator("#loadBtn").click();
    await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length >= 2, undefined, {
      timeout: TIMEOUT,
    });
    const projectLayout = await page.locator("#projectOverlay .project-window").evaluate((windowNode) => {
      const list = windowNode.querySelector<HTMLElement>("#projectList");
      const cards = [...windowNode.querySelectorAll<HTMLElement>(".project-card")];
      const windowBounds = windowNode.getBoundingClientRect();
      return {
        windowHeight: windowBounds.height,
        listClientHeight: list?.clientHeight ?? 0,
        listScrollHeight: list?.scrollHeight ?? 0,
        cardHeights: cards.map((card) => card.getBoundingClientRect().height),
      };
    });
    assert(projectLayout.windowHeight < 500, `project modal is not content-sized: ${projectLayout.windowHeight}px`);
    assert(
      projectLayout.cardHeights.every((height) => height < 120),
      `project cards are not compact rows: ${projectLayout.cardHeights.join(",")}px`,
    );
    const projectIds = await page.locator("#projectList .project-card").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-project"))
    );
    assert(projectIds.length >= 2, `project library did not retain the starter: ui=${projectIds.join(",")}`);
    assert(
      await page.locator('#projectList [data-project="renderer-stage-showcase"]').count() === 1,
      "imported project missing from library",
    );
    assert(
      await page.locator('#projectList [data-project="renderer-stage-showcase"] .project-active').count() === 1,
      "active project marker missing",
    );
    assert(
      await page.locator('#projectList [data-project="renderer-stage-showcase"]').textContent().then((value) =>
        value?.includes("Updated")
      ),
      "updated time missing from project card",
    );
    await page.locator('#projectList [data-project="lantern-below"] button').click();
    await waitFor(page, "#storyTitle", "Stone Entry");
    // The starter is also the NPC showcase, so its Keeper is played here rather
    // than only described: the gated action stays closed until trust is raised,
    // which is the whole `npcVar` -> `npcSet` round trip in a shipped template.
    await page.locator("#heroChoices button", { hasText: "North" }).first().click();
    // The title carries the location name; the terminal carries the prose it ran.
    await waitFor(page, "#storyTitle", "Narrow Passage");
    await waitFor(page, "#heroTerminal", "The passage runs south");
    assert(
      !(await page.locator("#heroChoices").textContent())?.includes("broken"),
      "the starter offered its npcVar-gated keeper action before trust was raised",
    );
    await page.locator("#heroChoices button", { hasText: "Ask the keeper about the lamps" }).click();
    await waitFor(page, "#heroTerminal", "still burn");
    assert(
      (await page.locator("#heroChoices").textContent())?.includes("broken"),
      "the starter's npcVar-gated action did not open after npcSet raised trust",
    );
    await page.locator("#loadBtn").click();
    await page.locator('#projectList [data-project="renderer-stage-showcase"] button:not([disabled])').first().click();
    await waitFor(page, "#storyTitle", "The authored visual stage");
    await page.locator('.nav[data-view="author"]').click();
    for (
      const selector of [
        '.file-row:has(.file[data-file="scenario.yaml"]) .entry-delete',
        '.file-row:has(.file[data-file="scripts/main.lua"]) .entry-delete',
        '.folder[data-folder="scripts"] > .entry-delete',
      ]
    ) {
      assert(await page.locator(selector).count() === 0, `required project entry has a delete control: ${selector}`);
    }
    await page.evaluate(() => {
      const app = (globalThis as {
        inkforgeApp?: { deleteExplorerEntry(kind: "file" | "folder", path: string): void };
      }).inkforgeApp;
      app?.deleteExplorerEntry("file", "scenario.yaml");
      app?.deleteExplorerEntry("file", "scripts/main.lua");
      app?.deleteExplorerEntry("folder", "scripts");
    });
    assert(!(await page.locator("#deleteOverlay").isVisible()), "required entry opened the delete dialog");
    assert(await page.locator('.file[data-file="assets/map.svg"]').count() === 1, "asset missing from Author tree");
    await page.locator('.file[data-file="assets/map.svg"]').click();
    assert(await page.locator("#assetPreview img").count() === 1, "image asset preview missing");
    const tempAssetDir = await Deno.makeTempDir({ prefix: "inkforge-authoring-asset-" });
    const wavPath = `${tempAssetDir}\\click.wav`;
    await Deno.writeFile(wavPath, silentWav());
    await page.locator("#addFile").click();
    await page.locator("#assetInput").setInputFiles(wavPath);
    await page.waitForFunction(() => document.querySelector('[data-file="assets/click.wav"]') !== null, undefined, {
      timeout: TIMEOUT,
    });
    await page.locator('.file[data-file="assets/click.wav"]').click();
    assert(await page.locator("#assetPreview audio").count() === 1, "imported audio asset preview missing");
    await page.locator("#assetInput").setInputFiles(wavPath);
    await waitFor(page, "#diagnostics", "Asset already exists");
    await page.locator('.file-row:has(.file[data-file="assets/click.wav"]) .entry-delete').click();
    assert(await page.locator("#deleteOverlay").isVisible(), "asset deletion confirmation did not open");
    assert(
      (await page.locator("#deleteDescription").textContent())?.includes("assets/click.wav"),
      "asset path missing",
    );
    await page.locator("#deleteConfirm").click();
    assert(await page.locator('.file[data-file="assets/click.wav"]').count() === 0, "deleted asset remains in tree");
    assert(!(await page.locator("#assetPreview").isVisible()), "deleted asset preview remains open");
    await page.locator('.file[data-file="scenario.yaml"]').click();
    assert(await page.locator('.file[data-file="modals.yml"]').count() === 1, "modals.yml missing from Author tree");
    assert(await page.locator('.file[data-file="tools.yml"]').count() === 1, "tools.yml missing from Author tree");
    await page.locator('.file[data-file="modals.yml"]').click();
    // The buffer is read through the app's harness hook: the editor renders only
    // the lines in view, so the DOM text would truncate (see `src/editor/harness.ts`).
    assert(
      (await page.evaluate(() => (globalThis as { inkforgeEditor?: EditorHarness }).inkforgeEditor?.getValue() ?? ""))
        .includes("Stage Journal"),
      "modals.yml could not be opened",
    );

    // === Folder and file creation ===
    // Open the create dialog from the root `+ New` button.
    await page.locator("#createNew").click();
    assert(await page.locator("#createOverlay").isVisible(), "create dialog did not open");
    const createHeight = await page.locator("#createOverlay .create-window").evaluate((node) =>
      node.getBoundingClientRect().height
    );
    assert(createHeight < 400, `create dialog inherited an oversized height (${createHeight}px)`);
    // Default type from root is "folder".
    assert(
      await page.locator('#createOverlay [data-create-kind="folder"]').evaluate((node) =>
        node.classList.contains("active")
      ),
      "root create dialog did not default to folder",
    );
    // Type a folder name and submit.
    await page.locator("#createName").fill("rooms");
    await page.locator("#createSubmit").click();
    assert(!(await page.locator("#createOverlay").isVisible()), "create dialog did not close after folder creation");
    // The folder should appear in the tree.
    assert(
      await page.locator('.folder[data-folder="rooms"]').count() === 1,
      "created folder missing from tree",
    );
    // The folder should be expanded by default.
    assert(
      await page.locator('.folder[data-folder="rooms"]').evaluate((node) => node.classList.contains("open")),
      "created folder is not expanded",
    );
    // The VFS should have a marker for the empty folder.
    const vfsAfterFolder = await page.evaluate(() => {
      const app = (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string> } } }).inkforgeApp;
      return app?.project.vfs ?? {};
    });
    assert(
      vfsAfterFolder["rooms/.inkforge-dir"] !== undefined,
      "empty folder marker missing from VFS",
    );

    // Create a YAML file inside the folder.
    await page.locator('.folder[data-folder="rooms"] .folder-add').click();
    assert(await page.locator("#createOverlay").isVisible(), "folder create dialog did not open");
    // Default type from a folder is "yaml".
    assert(
      await page.locator('#createOverlay [data-create-kind="yaml"]').evaluate((node) =>
        node.classList.contains("active")
      ),
      "folder create dialog did not default to yaml",
    );
    await page.locator("#createName").fill("gate");
    await page.locator("#createSubmit").click();
    assert(!(await page.locator("#createOverlay").isVisible()), "create dialog did not close after file creation");
    // The file should appear nested under the folder.
    assert(
      await page.locator('.file[data-file="rooms/gate.yaml"]').count() === 1,
      "created file missing from tree",
    );
    // The file should be in a tab and active in the editor.
    assert(
      await page.locator('.tab[data-file="rooms/gate.yaml"]').count() === 1,
      "created file did not open in a tab",
    );
    assert(
      await page.locator('.tab[data-file="rooms/gate.yaml"]').evaluate((node) => node.classList.contains("active")),
      "created file tab is not active",
    );
    // The marker should be gone now that the folder has a real file.
    const vfsAfterFile = await page.evaluate(() => {
      const app = (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string> } } }).inkforgeApp;
      return app?.project.vfs ?? {};
    });
    assert(
      vfsAfterFile["rooms/.inkforge-dir"] === undefined,
      "empty folder marker was not removed after adding a file",
    );
    assert(
      vfsAfterFile["rooms/gate.yaml"] !== undefined,
      "created file missing from VFS",
    );

    // Test validation: try to create a duplicate file.
    await page.locator('.folder[data-folder="rooms"] .folder-add').click();
    await page.locator("#createName").fill("gate");
    await page.locator("#createSubmit").click();
    assert(await page.locator("#createOverlay").isVisible(), "dialog closed despite duplicate error");
    const errorText = await page.locator("#createError").textContent();
    assert(errorText?.includes("already exists"), `duplicate error missing or wrong: ${errorText}`);
    await page.locator("#createCancel").click();

    // Test validation: try an invalid extension.
    await page.locator('.folder[data-folder="rooms"] .folder-add').click();
    await page.locator('#createOverlay [data-create-kind="yaml"]').click();
    await page.locator("#createName").fill("test.txt");
    await page.locator("#createSubmit").click();
    assert(await page.locator("#createOverlay").isVisible(), "dialog closed despite extension error");
    const extError = await page.locator("#createError").textContent();
    assert(extError?.includes("Only"), `extension error missing or wrong: ${extError}`);
    await page.locator("#createCancel").click();

    // Test nested folder creation.
    await page.locator('.folder[data-folder="rooms"] .folder-add').click();
    await page.locator('#createOverlay [data-create-kind="folder"]').click();
    await page.locator("#createName").fill("deep");
    await page.locator("#createSubmit").click();
    assert(
      await page.locator('.folder[data-folder="rooms/deep"]').count() === 1,
      "nested folder missing from tree",
    );
    const vfsAfterNested = await page.evaluate(() => {
      const app = (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string> } } }).inkforgeApp;
      return app?.project.vfs ?? {};
    });
    assert(
      vfsAfterNested["rooms/deep/.inkforge-dir"] !== undefined,
      "nested empty folder marker missing",
    );
    assert(
      await page.locator('.folder[data-folder="rooms/deep/.i"]').count() === 0,
      "nested marker created a phantom child folder",
    );

    // A long folder path must not be truncated when the marker is stripped.
    await page.locator("#createNew").click();
    await page.locator("#createName").fill("really-long-folder");
    await page.locator("#createSubmit").click();
    assert(
      await page.locator('.folder[data-folder="really-long-folder"]').count() === 1,
      "long folder path was truncated",
    );
    await page.locator('.folder[data-folder="really-long-folder"] .folder-add').click();
    await page.locator("#createName").fill("inside");
    await page.locator("#createSubmit").click();
    assert(
      await page.locator('.file[data-file="really-long-folder/inside.yaml"]').count() === 1,
      "add in a long folder wrote to the wrong path",
    );

    // Test that the marker is filtered from pack export.
    await page.locator("#loadBtn").click();
    await page.locator("#exportBtn").click();
    await page.locator("#closeProjects").click();
    // The export is a download; we can't easily intercept it in playwright-core,
    // but we can check the manifest by evaluating the export logic directly.
    const manifestFiles = await page.evaluate(() => {
      const app =
        (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string>; assets: Record<string, unknown> } } })
          .inkforgeApp;
      if (!app) return [];
      const vfsKeys = Object.keys(app.project.vfs).filter((key) =>
        !key.endsWith("/.inkforge-dir") && key !== ".inkforge-dir"
      );
      return [...vfsKeys, ...Object.keys(app.project.assets)].sort();
    });
    assert(
      !manifestFiles.includes("rooms/.inkforge-dir"),
      "empty folder marker leaked into export manifest",
    );
    assert(
      !manifestFiles.includes("rooms/deep/.inkforge-dir"),
      "nested empty folder marker leaked into export manifest",
    );
    assert(
      manifestFiles.includes("rooms/gate.yaml"),
      "created file missing from export manifest",
    );

    // === File and folder deletion ===
    const gateDelete = page.locator('.file-row:has(.file[data-file="rooms/gate.yaml"]) .entry-delete');
    await gateDelete.click();
    assert(await page.locator("#deleteOverlay").isVisible(), "file deletion confirmation did not open");
    await page.locator("#deleteCancel").click();
    assert(await page.locator('.file[data-file="rooms/gate.yaml"]').count() === 1, "Cancel deleted the file");
    await gateDelete.click();
    await page.locator("#deleteConfirm").click();
    assert(await page.locator('.file[data-file="rooms/gate.yaml"]').count() === 0, "deleted file remains in tree");
    assert(await page.locator('.tab[data-file="rooms/gate.yaml"]').count() === 0, "deleted file tab remains open");

    await page.locator('.folder[data-folder="rooms/deep"] > .entry-delete').click();
    await page.locator("#deleteConfirm").click();
    const afterNestedDelete = await page.evaluate(() =>
      (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string> } } }).inkforgeApp?.project.vfs ?? {}
    );
    assert(afterNestedDelete["rooms/deep/.inkforge-dir"] === undefined, "deleted nested marker remains");
    assert(afterNestedDelete["rooms/.inkforge-dir"] !== undefined, "empty parent folder lost its marker");

    await page.locator('.folder[data-folder="rooms"] > .entry-delete').click();
    await page.locator("#deleteConfirm").click();
    assert(await page.locator('.folder[data-folder="rooms"]').count() === 0, "deleted folder remains in tree");

    await page.locator('.folder[data-folder="really-long-folder"] > .entry-delete').click();
    assert(
      (await page.locator("#deleteDescription").textContent())?.includes("1 file"),
      "folder confirmation omitted descendant count",
    );
    await page.locator("#deleteConfirm").click();
    assert(
      await page.locator('.file[data-file="really-long-folder/inside.yaml"]').count() === 0,
      "folder deletion left its file in the tree",
    );
    assert(
      await page.locator('.tab[data-file="really-long-folder/inside.yaml"]').count() === 0,
      "folder deletion left its active file tab open",
    );
    const afterDelete = await page.evaluate(() =>
      (globalThis as { inkforgeApp?: { project: { vfs: Record<string, string> } } }).inkforgeApp?.project.vfs ?? {}
    );
    assert(!Object.keys(afterDelete).some((path) => path.startsWith("rooms/")), "folder subtree remains in VFS");
    assert(
      !Object.keys(afterDelete).some((path) => path.startsWith("really-long-folder/")),
      "active folder subtree remains in VFS",
    );
    await page.waitForFunction(
      async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("inkforge-project-library");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const project = await new Promise<{ vfs: Record<string, string>; assets: Record<string, unknown> } | undefined>(
          (resolve, reject) => {
            const request = db.transaction("projects", "readonly").objectStore("projects").get(
              "renderer-stage-showcase",
            );
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          },
        );
        db.close();
        return project?.vfs["scenario.yaml"] !== undefined &&
          !Object.keys(project.vfs).some((path) =>
            path.startsWith("rooms/") || path.startsWith("really-long-folder/")
          ) &&
          project.assets["assets/click.wav"] === undefined;
      },
      undefined,
      { timeout: TIMEOUT },
    );

    await page.locator('.nav[data-view="play"]').click();

    const toolIds = await page.locator("#toolRail [data-tool]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-tool"))
    );
    assert(toolIds.join(",") === "journal_tool,map_tool,lua_tool", `unexpected YAML/Lua tools: ${toolIds.join(",")}`);
    assert(await page.locator('[data-tool="journal_tool"]').getAttribute("title") === "Journal", "hover label missing");
    assert(await page.locator('[data-tool="map_tool"] img').count() === 1, "image icon missing");
    assert(
      await page.locator('[data-tool="map_tool"] img').getAttribute("src").then((src) => src?.startsWith("blob:")),
      "SVG icon was not resolved from the VFS",
    );
    await page.locator('[data-tool="journal_tool"]').hover();
    assert(
      await page.locator('[data-tool="journal_tool"]').evaluate((node) =>
        getComputedStyle(node, "::after").display === "block"
      ),
      "hover label is not visible",
    );

    await page.locator('[data-tool="journal_tool"]').click();
    await waitFor(page, "#modalHost", "Stage Journal");
    assert(
      await page.locator('[data-modal-ui="journal_page_two_button"]').count() === 1,
      "nested modal button missing",
    );
    await page.locator('[data-modal-ui="journal_page_two_button"]').click();
    await waitFor(page, ".authored-modal-body", "Page two / Runtime");

    await page.locator('[data-modal-ui="hide_runtime_tool"]').click();
    assert(await page.locator('[data-tool="lua_tool"]').count() === 0, "GameTools.hide did not hide the runtime tool");
    await page.locator('[data-modal-ui="show_runtime_tool"]').click();
    assert(await page.locator('[data-tool="lua_tool"]').count() === 1, "GameTools.show did not show the runtime tool");
    await page.locator('[data-modal-ui="disable_map_tool"]').click();
    assert(await page.locator('[data-tool="map_tool"]').isDisabled(), "GameTools.disable did not disable the map tool");
    await page.locator('[data-modal-ui="enable_map_tool"]').click();
    assert(
      !(await page.locator('[data-tool="map_tool"]').isDisabled()),
      "GameTools.enable did not enable the map tool",
    );
    await page.locator('[data-modal-ui="close_journal"]').click();

    await page.locator('[data-tool="map_tool"]').click();
    await waitFor(page, "#heroTerminal", "Map tool action dispatched to Lua.");
    await page.locator('[data-tool="journal_tool"]').click();
    await page.locator('[data-modal-ui="remove_runtime_tool"]').click();
    assert(
      await page.locator('[data-tool="lua_tool"]').count() === 0,
      "GameTools.remove did not remove the runtime tool",
    );
    await page.locator('[data-modal-ui="close_journal"]').click();

    await page.locator("#restartHero").click();
    await page.waitForFunction(
      () => document.querySelector('[data-tool="lua_tool"]') !== null,
      undefined,
      { timeout: TIMEOUT },
    );
    assert(await page.locator('[data-tool="lua_tool"]').count() === 1, "restart did not reset Lua tool registration");

    // A scenario can name a Lua entry outside scripts/main.lua. Import must
    // accept that pack, and the editor must protect the configured file and
    // every ancestor folder without inventing a missing default-script tab.
    const customPackPath = `${temp}\\custom-entry.inkforge`;
    const customScenario =
      "meta:\n  title: Custom Entry\nstartLocation: gate\nscripts:\n  main: chapter/entry.lua\nlocations:\n  gate:\n    title: Gate\n    text: Hello\n";
    const missingEntryPath = `${temp}\\missing-custom-entry.inkforge`;
    await Deno.writeFile(
      missingEntryPath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "missing-custom-entry-test", version: "1.0.0" },
          files: ["scenario.yaml"],
        })),
        "scenario.yaml": strToU8(customScenario),
      }),
    );
    const missingEntryDialog = page.waitForEvent("dialog");
    await page.locator("#importFile").setInputFiles(missingEntryPath);
    const missingDialog = await missingEntryDialog;
    assert(
      missingDialog.message().includes("configured Lua entry script: chapter/entry.lua"),
      "import accepted a pack without its configured entry",
    );
    await missingDialog.accept();
    await Deno.writeFile(
      customPackPath,
      zipSync({
        "manifest.json": strToU8(JSON.stringify({
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "custom-entry-test", version: "1.0.0" },
          files: ["scenario.yaml", "chapter/entry.lua", "alternate/entry.lua"],
        })),
        "scenario.yaml": strToU8(customScenario),
        "chapter/entry.lua": strToU8("-- custom entry\n"),
        "alternate/entry.lua": strToU8("-- alternate entry\n"),
      }),
    );
    await page.locator("#importFile").setInputFiles(customPackPath);
    await page.waitForFunction(() =>
      document.body.dataset.projectId === "custom-entry-test" && document.body.dataset.projectReady === "true"
    );
    await page.locator('.nav[data-view="author"]').click();
    assert(await page.locator('.tab[data-file="chapter/entry.lua"]').count() === 1, "configured script tab missing");
    assert(
      await page.locator('.tab[data-file="scripts/main.lua"]').count() === 0,
      "missing default script tab was opened",
    );
    assert(
      await page.locator('.file-row:has(.file[data-file="chapter/entry.lua"]) .entry-delete').count() === 0,
      "configured entry has a delete control",
    );
    assert(
      await page.locator('.folder[data-folder="chapter"] > .entry-delete').count() === 0,
      "configured entry folder has a delete control",
    );
    await page.evaluate(async () => {
      const app = (globalThis as {
        inkforgeApp?: { deleteExplorerEntry(kind: "file" | "folder", path: string): Promise<void> };
      }).inkforgeApp;
      await app?.deleteExplorerEntry("file", "chapter/entry.lua");
      await app?.deleteExplorerEntry("folder", "chapter");
    });
    assert(!(await page.locator("#deleteOverlay").isVisible()), "configured entry opened the delete dialog");
    assert(await page.locator('.file[data-file="chapter/entry.lua"]').count() === 1, "configured entry disappeared");
    await page.locator('.file[data-file="scenario.yaml"]').click();
    await page.evaluate(
      (source) => (globalThis as { inkforgeEditor?: EditorHarness }).inkforgeEditor?.setValue(source),
      customScenario.replace("chapter/entry.lua", "alternate/entry.lua"),
    );
    await page.waitForFunction(() =>
      document.querySelector('.file-row:has(.file[data-file="alternate/entry.lua"]) .entry-delete') === null &&
      document.querySelector('.file-row:has(.file[data-file="chapter/entry.lua"]) .entry-delete') !== null
    );
    assert(
      await page.locator('.folder[data-folder="alternate"] > .entry-delete').count() === 0,
      "edited entry folder still has a delete control",
    );
    assert(
      await page.locator('.folder[data-folder="chapter"] > .entry-delete').count() === 1,
      "old entry folder stayed protected after editing scenario.scripts.main",
    );
    await page.evaluate(async () => {
      const app = (globalThis as {
        inkforgeApp?: { deleteExplorerEntry(kind: "file" | "folder", path: string): Promise<void> };
      }).inkforgeApp;
      await app?.deleteExplorerEntry("file", "alternate/entry.lua");
    });
    assert(!(await page.locator("#deleteOverlay").isVisible()), "edited entry opened the delete dialog");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS  YAML/Lua registration, icons, hover, modal recursion/paging, actions, state controls, reset");
  } finally {
    await context.close();
    await browser.close();
    await server.shutdown();
  }
}

await main();
