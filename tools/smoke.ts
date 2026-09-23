import { build } from "./build.ts";
import { DIST } from "./paths.ts";
import { serveStatic } from "./server.ts";
import { unzipSync, zipSync } from "fflate";
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Page } from "playwright-core";

/**
 * Inkforge production smoke harness.
 *
 * Builds `dist/`, serves it on 127.0.0.1, drives the app in a real headless
 * Chromium, and asserts the seven required smoke tests through the DOM only.
 * Exits non-zero when any assertion fails.
 */

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PRIMARY_PORT = 4173;
const VIEWPORT = { width: 1440, height: 900 };
const BOOT_TIMEOUT = 30_000;
const CANVAS_TIMEOUT = 30_000;
const SCENE_CANVAS = '#gameSurface canvas[data-scene="entry_scene"]';
const CANVAS_VIRTUAL = { width: 960, height: 720 };
/** Virtual centre of the `lantern` rect node (x=598,y=430,w=68,h=104). */
const LANTERN_CENTRE = { x: 632, y: 482 };

interface LaunchOptions {
  executablePath?: string;
  headless?: boolean;
}

interface ChromiumLauncher {
  launch(options?: LaunchOptions): Promise<Browser>;
}

interface PlaywrightModule {
  chromium: ChromiumLauncher;
}

interface PackShape {
  manifest: {
    format: string;
    packVersion: number;
    project: { id: string; title?: string; author?: string; version: string };
    files: string[];
  };
  entries: Record<string, Uint8Array>;
}

interface CheckResult {
  name: string;
  passed: boolean;
  evidence: string;
}

interface CapturedLog {
  kind: "console" | "pageerror";
  level: string;
  text: string;
}

const results: CheckResult[] = [];
const logs: CapturedLog[] = [];
let activePage: Page | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function short(value: string, limit = 320): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

async function describeDom(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const text = (selector: string): string =>
        (document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
      return [
        `storyTitle="${text("#storyTitle")}"`,
        `heroTerminal="${text("#heroTerminal")}"`,
        `heroChoices="${text("#heroChoices")}"`,
        `gameHud="${text("#gameHud")}"`,
        `uiOutput="${text("#uiOutput")}"`,
        `location="${text("#location")}"`,
        `diagnostics="${text("#diagnostics")}"`,
      ].join("; ");
    });
  } catch (error) {
    return `DOM diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runCheck(name: string, body: () => Promise<string>): Promise<void> {
  try {
    const evidence = await body();
    results.push({ name, passed: true, evidence });
    console.log(`PASS  ${name} - ${short(evidence)}`);
  } catch (error) {
    const base = error instanceof Error ? error.message : String(error);
    const message = activePage ? `${base} | DOM: ${await describeDom(activePage)}` : base;
    results.push({ name, passed: false, evidence: message });
    console.log(`FAIL  ${name} - ${short(message)}`);
  }
}

async function textOf(page: Page, selector: string): Promise<string> {
  return await page.evaluate((sel: string) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function waitForText(page: Page, selector: string, text: string, timeout = BOOT_TIMEOUT): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }: { selector: string; text: string }) =>
      (document.querySelector(selector)?.textContent ?? "").includes(text),
    { selector, text },
    { timeout },
  );
}

async function waitForTextEquals(page: Page, selector: string, text: string, timeout = BOOT_TIMEOUT): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }: { selector: string; text: string }) =>
      (document.querySelector(selector)?.textContent ?? "") === text,
    { selector, text },
    { timeout },
  );
}

async function waitForCanvas(page: Page, selector: string, timeout = CANVAS_TIMEOUT): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const canvas = document.querySelector(sel);
      if (!(canvas instanceof HTMLCanvasElement)) return false;
      const bounds = canvas.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    },
    selector,
    { timeout },
  );
}

async function clickChoice(page: Page, label: string): Promise<void> {
  await page.locator("#heroChoices .choice", { hasText: label }).first().click();
}

async function choiceLabels(page: Page): Promise<string[]> {
  return await page.locator("#heroChoices .choice").allTextContents();
}

function asText(pack: PackShape, path: string): string {
  const bytes = pack.entries[path];
  assert(bytes, `pack entry is missing: ${path}`);
  return new TextDecoder().decode(bytes);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function silentWav(): Uint8Array {
  const dataLength = 8;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, dataLength, true);
  bytes.fill(128, 44);
  return bytes;
}

async function exportPack(page: Page): Promise<PackShape> {
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportBtn").click();
  const download = await downloadPromise;
  const path = await download.path();
  assert(path, "export download produced no local path");
  const archive = unzipSync(await Deno.readFile(path));
  const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"]));
  return { manifest, entries: archive } as PackShape;
}

async function importPack(page: Page, pack: PackShape, storageMarker: string, storagePath: string): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "inkforge-smoke-" });
  const filePath = `${dir}\\pack.inkforge`;
  const entries = {
    ...pack.entries,
    "manifest.json": new TextEncoder().encode(`${JSON.stringify(pack.manifest, null, 2)}\n`),
  };
  await Deno.writeFile(filePath, zipSync(entries));
  await page.locator("#importFile").setInputFiles(filePath);
  await page.waitForFunction(
    ({ marker, path }: { marker: string; path: string }) =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("inkforge-project-library");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result.transaction("projects", "readonly").objectStore("projects").getAll();
          all.onsuccess = () =>
            resolve((all.result as Array<{ vfs: Record<string, string> }>).some((project) =>
              (project.vfs[path] ?? "").includes(marker)
            ));
          all.onerror = () =>
            reject(all.error);
        };
      }),
    { marker: storageMarker, path: storagePath },
    { timeout: BOOT_TIMEOUT },
  );
  await page.waitForFunction(
    (projectId: string) =>
      document.body.dataset.projectId === projectId && document.body.dataset.projectReady === "true",
    pack.manifest.project.id,
    { timeout: BOOT_TIMEOUT },
  );
}

async function waitForStoredText(page: Page, marker: string, path: string): Promise<void> {
  await page.waitForFunction(
    ({ needle, path }: { needle: string; path: string }) =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("inkforge-project-library");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result.transaction("projects", "readonly").objectStore("projects").getAll();
          all.onsuccess = () =>
            resolve((all.result as Array<{ vfs: Record<string, string> }>).some((project) =>
              (project.vfs[path] ?? "").includes(needle)
            ));
          all.onerror = () =>
            reject(all.error);
        };
      }),
    { needle: marker, path },
    { timeout: BOOT_TIMEOUT },
  );
}

async function launchBrowser(): Promise<{ browser: Browser; approach: string }> {
  try {
    const module = (await import("playwright-core")) as unknown as PlaywrightModule;
    const browser = await module.chromium.launch({ executablePath: CHROME_PATH, headless: true });
    return { browser, approach: `playwright-core@1.58.2 + system Chrome (${browser.version()})` };
  } catch (coreError) {
    console.log(
      `playwright-core unavailable (${coreError instanceof Error ? coreError.message : String(coreError)}); ` +
        "falling back to playwright",
    );
    const module = (await import("playwright")) as unknown as PlaywrightModule;
    const browser = await module.chromium.launch({ headless: true });
    return { browser, approach: `playwright@1.58.2 + bundled Chromium (${browser.version()})` };
  }
}

function startServer(): { port: number; shutdown: () => Promise<void> } {
  try {
    return serveStatic({ root: DIST, port: PRIMARY_PORT });
  } catch (error) {
    console.log(
      `port ${PRIMARY_PORT} unavailable (${
        error instanceof Error ? error.message : String(error)
      }); using an ephemeral port`,
    );
    return serveStatic({ root: DIST, port: 0 });
  }
}

async function main(): Promise<void> {
  console.log("== Inkforge smoke harness ==");
  console.log("1. Production build");
  await build();

  console.log("2. Static server");
  const server = startServer();
  const origin = `http://127.0.0.1:${server.port}`;
  console.log(`   serving ${DIST} at ${origin}/`);

  console.log("3. Browser");
  const { browser, approach } = await launchBrowser();
  console.log(`   using ${approach}`);

  const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT });
  const page: Page = await context.newPage();
  activePage = page;
  page.on("console", (message: ConsoleMessage) => {
    logs.push({ kind: "console", level: message.type(), text: message.text() });
  });
  page.on("pageerror", (error: Error) => {
    logs.push({ kind: "pageerror", level: "error", text: error.message });
  });
  page.on("dialog", async (dialog: Dialog) => {
    const expectedDelete = dialog.message().startsWith("Delete ");
    if (!expectedDelete) logs.push({ kind: "console", level: "dialog", text: `${dialog.type()}: ${dialog.message()}` });
    if (expectedDelete) await dialog.accept();
    else await dialog.dismiss();
  });

  try {
    await runCheck("1. Play boot (starter project)", async () => {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: BOOT_TIMEOUT });
      await waitForTextEquals(page, "#storyTitle", "Stone Entry");
      await waitForText(page, "#heroTerminal", "Cold air rises from the passage ahead.");
      await waitForText(page, "#heroTerminal", "A brass lantern rests beside the threshold.");
      await waitForText(page, "#heroChoices", "North");
      await waitForText(page, "#heroChoices", "Take Brass Lantern");
      await waitForText(page, "#surfaceHeader", "Inventory");
      await waitForText(page, "#gameHud", "Health");
      await waitForText(page, "#gameHud", "Stamina");
      const hud = await textOf(page, "#gameHud");
      return `title=Stone Entry; both entry lines in #heroTerminal; choices North + Take Brass Lantern; ` +
        `#surfaceHeader has Inventory; #gameHud="${short(hud, 90)}"`;
    });

    await runCheck("2. Lua/Wasmoon boot + require()", async () => {
      await waitForText(page, "#gameHud", "Focus", CANVAS_TIMEOUT);
      await waitForText(page, "#uiOutput", "Listen at the threshold", CANVAS_TIMEOUT);
      const hud = await textOf(page, "#gameHud");
      assert(hud.includes("3 / 5"), `Focus meter value missing: ${short(hud, 120)}`);
      await page.locator('#uiOutput button[data-ui="listen"]').click();
      await waitForText(page, "#heroTerminal", "Water moves somewhere beyond the stone.");
      return `#gameHud gained Focus meter ("${short(hud, 90)}"); clicked "Listen at the threshold"; ` +
        `#heroTerminal gained "Water moves somewhere beyond the stone."`;
    });

    await runCheck("3. Canvas composition + runtime (hit-test, tween, timer)", async () => {
      await waitForCanvas(page, SCENE_CANVAS);
      const box = await page.locator(SCENE_CANVAS).boundingBox();
      assert(box, "canvas bounding box unavailable");
      const scale = Math.min(box.width / CANVAS_VIRTUAL.width, box.height / CANVAS_VIRTUAL.height);
      const offsetX = (box.width - CANVAS_VIRTUAL.width * scale) / 2;
      const offsetY = (box.height - CANVAS_VIRTUAL.height * scale) / 2;
      const clickX = offsetX + LANTERN_CENTRE.x * scale;
      const clickY = offsetY + LANTERN_CENTRE.y * scale;
      await page.locator(SCENE_CANVAS).click({ position: { x: clickX, y: clickY } });
      await waitForText(page, "#heroTerminal", "The lantern's hood is warm.");
      const before = logs.filter((log) => log.kind === "pageerror").length;
      await page.waitForTimeout(3000);
      const after = logs.filter((log) => log.kind === "pageerror").length;
      assert(after === before, `pageerror during canvas interaction: ${short(pageErrorText(), 200)}`);
      return `canvas box ${Math.round(box.width)}x${Math.round(box.height)}; scale=${scale.toFixed(3)}; ` +
        `offset=(${offsetX.toFixed(1)},${offsetY.toFixed(1)}); click=(${clickX.toFixed(1)},${clickY.toFixed(1)}); ` +
        `lantern inspect output observed; no pageerror across a >2.4s timer window`;
    });

    await runCheck("4. Author mode: switching + editing + persistence", async () => {
      await page.locator('.nav[data-view="author"]').click();
      const authorVisible = await page.locator("#authorView").isVisible();
      const playVisible = await page.locator("#playView").isVisible();
      assert(authorVisible && !playVisible, `authorView visible=${authorVisible}, playView visible=${playVisible}`);

      await page.locator('.file[data-file="state.yml"]').first().click();
      const stateFormat = await textOf(page, "#format");
      assert(stateFormat === "YAML", `#format=${stateFormat}`);
      const stateCode = await page.locator("#code").inputValue();
      assert(stateCode.includes("lampLit: false"), "state.yml does not contain lampLit: false");

      await page.locator('.file[data-file="scripts/main.lua"]').first().click();
      const luaFormat = await textOf(page, "#format");
      assert(luaFormat === "LUA", `#format=${luaFormat}`);
      const luaCode = await page.locator("#code").inputValue();
      assert(luaCode.includes('require("scripts/threshold")'), "main.lua does not contain the require call");

      const gutterLines = (await textOf(page, "#gutter")).split("\n").length;
      const codeLines = luaCode.split("\n").length;
      assert(gutterLines === codeLines, `#gutter lines ${gutterLines} != #code lines ${codeLines}`);
      await page.locator("#code").press("ArrowDown");
      const cursor = await textOf(page, "#cursor");
      assert(/^Ln \d+, Col \d+$/.test(cursor), `#cursor="${cursor}"`);

      // `#` is not a Lua comment; appending it would make the script unparseable and
      // break the restart in assertion 5. Use Lua's line-comment syntax so the edit is
      // still a persisted, non-leaking marker while the script stays valid.
      await page.locator("#code").fill(`${luaCode}\n-- smoke-edit`);
      const saved = await textOf(page, "#saved");
      assert(saved === "saved locally", `#saved=${saved}`);
      await waitForStoredText(page, "smoke-edit", "scripts/main.lua");

      await page.locator('.file[data-file="scenario.yaml"]').first().click();
      const scenarioCode = await page.locator("#code").inputValue();
      assert(scenarioCode.includes("startLocation: entry"), "scenario.yaml lost startLocation: entry");
      assert(!scenarioCode.includes("smoke-edit"), "the main.lua edit leaked into scenario.yaml");
      return `#authorView shown, #playView hidden; state.yml=YAML/lampLit:false; main.lua=LUA/require; ` +
        `gutter=${gutterLines} lines matches #code; #cursor="${cursor}"; ` +
        `edit persisted (#saved="saved locally", IndexedDB contains smoke-edit); scenario.yaml intact`;
    });

    await runCheck("4a. Editor tabs: opening a file appends and activates a tab", async () => {
      await page.locator('.nav[data-view="author"]').click();
      // Test 4 opened state.yml on top of the two default tabs; close that extra,
      // non-active tab so this check starts from the original two-tab set.
      if ((await page.locator(".tabs .tab").count()) > 2) {
        await page.locator('.tab[data-file="state.yml"] i').click();
      }
      const defaultCount = await page.locator(".tabs .tab").count();
      assert(defaultCount === 2, `expected 2 default tabs, found ${defaultCount}`);
      assert(
        (await page.locator('.tab[data-file="scenario.yaml"].active').count()) === 1,
        "scenario.yaml is not the active tab after startup",
      );
      await page.locator('.file[data-file="instances.yml"]').first().click();
      const count = await page.locator(".tabs .tab").count();
      assert(count === 3, `expected 3 tabs after opening instances.yml, found ${count}`);
      assert(
        (await page.locator('.tab[data-file="instances.yml"].active').count()) === 1,
        "the instances.yml tab is not active",
      );
      const code = await page.locator("#code").inputValue();
      assert(code.includes("entry_lantern"), "instances.yml content was not loaded into #code");
      return `started from the 2 default tabs; clicking instances.yml appended a third tab, ` +
        `marked it active, and loaded its content ("entry_lantern")`;
    });

    await runCheck("4b. Editor tabs: closing the active tab switches to a remaining tab", async () => {
      await page.locator('.tab[data-file="instances.yml"] i').click();
      const count = await page.locator(".tabs .tab").count();
      assert(count === 2, `expected 2 tabs after closing instances.yml, found ${count}`);
      assert(
        (await page.locator('.tab[data-file="instances.yml"]').count()) === 0,
        "the instances.yml tab is still present after its × was clicked",
      );
      assert(
        (await page.locator('.tab[data-file="scripts/main.lua"].active').count()) === 1,
        "closing the active tab did not activate the nearest remaining tab (scripts/main.lua)",
      );
      const format = await textOf(page, "#format");
      assert(format === "LUA", `#format=${format} after switching to scripts/main.lua`);
      return `clicking the instances.yml × removed the tab (2 left) and activated the nearest ` +
        `remaining tab scripts/main.lua (#format=LUA)`;
    });

    await runCheck("4c. Editor tabs: reopening after close restores VFS content", async () => {
      await page.locator('.file[data-file="instances.yml"]').first().click();
      const count = await page.locator(".tabs .tab").count();
      assert(count === 3, `expected 3 tabs after reopening instances.yml, found ${count}`);
      const code = await page.locator("#code").inputValue();
      assert(code.includes("entry_lantern"), "instances.yml content was lost when its tab was closed");
      return `reopening instances.yml from the explorer created its tab again and restored its ` +
        `content ("entry_lantern") — closing a tab does not delete VFS data`;
    });

    await runCheck("4d. Editor tabs: closing the last tab clears the editor and reopen restores", async () => {
      while ((await page.locator(".tabs .tab").count()) > 0) {
        await page.locator(".tabs .tab i").first().click();
      }
      const emptyCode = await page.locator("#code").inputValue();
      const emptyFormat = await textOf(page, "#format");
      assert(emptyCode === "", `#code was not cleared: "${short(emptyCode)}"`);
      assert(emptyFormat === "", `#format was not cleared: "${emptyFormat}"`);
      assert(
        (await page.locator(".file.active").count()) === 0,
        "an explorer file is still active after the last tab was closed",
      );
      await page.locator('.file[data-file="scenario.yaml"]').first().click();
      const code = await page.locator("#code").inputValue();
      const format = await textOf(page, "#format");
      assert(code.includes("startLocation: entry"), "scenario.yaml content was lost after closing every tab");
      assert(format === "YAML", `#format=${format} after reopening scenario.yaml`);
      assert(
        (await page.locator(".tabs .tab").count()) === 1,
        "reopening scenario.yaml did not create a tab",
      );
      return `closing every tab left 0 tabs with #code="" and #format="", and no active explorer ` +
        `file; reopening scenario.yaml restored "startLocation: entry" (YAML) in a fresh active tab`;
    });

    await runCheck("5. YAML project loading (!import composition)", async () => {
      let stage = "switch to play";
      const step = (name: string): void => {
        stage = name;
        console.log(`   [5] ${name}`);
      };
      try {
        step("switch to play and restart");
        await page.locator('.nav[data-view="play"]').click();
        await page.locator("#restartHero").click();
        step("await title");
        await waitForTextEquals(page, "#storyTitle", "Stone Entry");
        step("await entry line 1");
        await waitForText(page, "#heroTerminal", "Cold air rises from the passage ahead.");
        step("await entry line 2");
        await waitForText(page, "#heroTerminal", "A brass lantern rests beside the threshold.");
        step("await North choice");
        await waitForText(page, "#heroChoices", "North");
        step("await inventory count");
        const inventory = await textOf(page, "#inventoryCount");
        assert(inventory === "0 / 12", `#inventoryCount=${inventory}`);
        step("await HUD health");
        await waitForText(page, "#gameHud", "10 / 10");
        const hud = await textOf(page, "#gameHud");
        return `restart re-rendered Stone Entry + both lines + North; #inventoryCount="${inventory}"; ` +
          `composed player state visible as #gameHud="${short(hud, 90)}"`;
      } catch (error) {
        throw new Error(`stage "${stage}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    let originalPack: PackShape | null = null;

    await runCheck("6. Import/export round-trip (!import, state effect, VFS identity)", async () => {
      let stage = "export original pack";
      const step = (name: string): void => {
        stage = name;
        console.log(`   [6] ${name}`);
      };
      try {
        await page.locator('.nav[data-view="author"]').click();

        step("export original pack");
        const packA = await exportPack(page);
        originalPack = packA;
        assert(packA.manifest.format === "inkforge-pack", `format=${String(packA.manifest.format)}`);
        assert(packA.manifest.packVersion === 2, `packVersion=${String(packA.manifest.packVersion)}`);
        const scenarioA = asText(packA, "scenario.yaml");
        assert(
          scenarioA.includes("startLocation: entry"),
          "export scenario.yaml missing startLocation: entry",
        );

        step("modify state.yml and import");
        const modified = structuredClone(packA);
        modified.manifest.project.version = "0.1.1";
        const modifiedState = asText(modified, "state.yml").replace("lampLit: false", "lampLit: true");
        modified.entries["state.yml"] = new TextEncoder().encode(modifiedState);
        assert(modifiedState.includes("lampLit: true"), "failed to modify state.yml");
        await importPack(page, modified, "lampLit: true", "state.yml");
        await waitForTextEquals(page, "#storyTitle", "Stone Entry");
        await waitForText(page, "#heroChoices", "Take Brass Lantern");
        await waitForStoredText(page, "lampLit: true", "state.yml");
        await page.waitForFunction(
          () => !(document.querySelector("#heroChoices")?.textContent || "").includes("Light the lantern"),
          undefined,
          { timeout: BOOT_TIMEOUT },
        );
        step("observe lampLit:true effect in Play");
        await page.locator('.nav[data-view="play"]').click();
        await clickChoice(page, "Take Brass Lantern");
        await clickChoice(page, "North");
        await waitForTextEquals(page, "#storyTitle", "Narrow Passage");
        const labelsTrue = await choiceLabels(page);
        assert(
          !labelsTrue.includes("Light the lantern"),
          `"Light the lantern" still offered with lampLit=true: [${labelsTrue.join(", ")}]`,
        );

        step("re-import original pack and control the lampLit:false action");
        const controlPack = structuredClone(packA);
        controlPack.manifest.project.version = "0.1.2";
        await importPack(page, controlPack, "lampLit: false", "state.yml");
        await waitForTextEquals(page, "#storyTitle", "Stone Entry");
        await page.locator('.nav[data-view="play"]').click();
        await clickChoice(page, "Take Brass Lantern");
        await clickChoice(page, "North");
        await waitForTextEquals(page, "#storyTitle", "Narrow Passage");
        await waitForText(page, "#heroChoices", "Light the lantern");
        const labelsFalse = await choiceLabels(page);

        step("re-export and compare VFS");
        await page.locator('.nav[data-view="author"]').click();
        const packC = await exportPack(page);
        const textEntriesA = Object.fromEntries(
          packA.manifest.files.filter((path) => !path.startsWith("assets/")).map((path) => [path, asText(packA, path)]),
        );
        const textEntriesC = Object.fromEntries(
          packC.manifest.files.filter((path) => !path.startsWith("assets/")).map((path) => [path, asText(packC, path)]),
        );
        assert(deepEqual(textEntriesC, textEntriesA), "re-imported text VFS is not identical to the original export");
        return `export format=inkforge-pack/packVersion=2; manifest and ZIP entries validated; ` +
          `lampLit:true import took effect (action absent: [${labelsTrue.join(", ")}]); original pack re-import ` +
          `newer control version restored text files; lampLit:false offers action: [${labelsFalse.join(", ")}]`;
      } catch (error) {
        throw new Error(`stage "${stage}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await runCheck("6a. Lua-authored projected scene + world pointer coordinates", async () => {
      assert(originalPack, "original pack was not captured");
      const projected = structuredClone(originalPack);
      projected.manifest.project.version = "0.1.3";
      const script = `-- projected-scene-fixture
game.canvas.create({
  id = 'projected_scene',
  viewport = {
    width = 320,
    height = 240,
    fit = 'contain',
    projection = { type = 'isometric', originX = 160, originY = 30, tileWidth = 48, tileHeight = 24 },
  },
  layers = {
    { id = 'world', order = 0, space = 'world', sort = 'depth' },
    { id = 'overlay', order = 10, space = 'screen' },
  },
  nodes = {
    { id = 'ground', type = 'rect', x = 0, y = 0, width = 8, height = 8, fill = '#263a3c', layer = 'world' },
    {
      id = 'target', type = 'marker', x = 3, y = 2, radius = 12, fill = '#e7c97a', layer = 'world',
      events = { pointer_down = function(event)
        game.output('projected ' .. math.floor(event.worldX + 0.5) .. ',' .. math.floor(event.worldY + 0.5))
      end },
    },
    { id = 'overlay', type = 'rect', x = 8, y = 8, width = 90, height = 22, fill = '#182022', layer = 'overlay', space = 'screen' },
    { id = 'offscreen', type = 'rect', x = 50, y = 260, width = 80, height = 20, fill = '#ff0000', layer = 'overlay', space = 'screen',
      events = { pointer_down = function() game.output('offscreen') end },
    },
  },
})
`;
      projected.entries["scripts/main.lua"] = new TextEncoder().encode(script);
      const scenario = `${asText(projected, "scenario.yaml")}\n# projected-scene-fixture\n`;
      projected.entries["scenario.yaml"] = new TextEncoder().encode(scenario);
      assert(script.includes("projected_scene"), "projected Lua fixture was not written to the VFS");
      await importPack(page, projected, "projected-scene-fixture", "scripts/main.lua");
      await page.locator('.nav[data-view="play"]').click();
      const selector = '#gameSurface canvas[data-scene="projected_scene"]';
      await waitForCanvas(page, selector);
      const box = await page.locator(selector).boundingBox();
      assert(box, "projected scene canvas bounding box unavailable");
      const scale = Math.min(box.width / 320, box.height / 240);
      const offsetX = (box.width - 320 * scale) / 2;
      const offsetY = (box.height - 240 * scale) / 2;
      const projectedTarget = { x: 160 + (3 - 2) * 24, y: 30 + (3 + 2) * 12 };
      await page.locator(selector).click({
        position: {
          x: offsetX + projectedTarget.x * scale,
          y: offsetY + projectedTarget.y * scale,
        },
      });
      await waitForText(page, "#heroTerminal", "projected 3,2");
      return `Lua created projected_scene with isometric world + screen layers; clicked projected marker ` +
        `at (${projectedTarget.x},${projectedTarget.y}); callback output confirmed world coordinates 3,2`;
    });

    await runCheck("6b. Viewport bounds clip content and input", async () => {
      const selector = '#gameSurface canvas[data-scene="projected_scene"]';
      const offscreen = await page.evaluate((canvasSelector: string) => {
        const canvas = document.querySelector<HTMLCanvasElement>(canvasSelector);
        if (!canvas) throw new Error("projected scene canvas unavailable");
        const bounds = canvas.getBoundingClientRect();
        const scale = Math.min(bounds.width / 320, bounds.height / 240);
        const offsetX = (bounds.width - 320 * scale) / 2;
        const offsetY = (bounds.height - 240 * scale) / 2;
        const x = offsetX + 50 * scale;
        const y = offsetY + 270 * scale;
        const ratioX = canvas.width / bounds.width;
        const ratioY = canvas.height / bounds.height;
        const pixel = canvas.getContext("2d")?.getImageData(
          Math.round(x * ratioX),
          Math.round(y * ratioY),
          1,
          1,
        ).data;
        return { x, y, alpha: pixel?.[3] ?? -1, red: pixel?.[0] ?? -1 };
      }, selector);
      assert(offscreen.alpha === 0, `content outside logical viewport was visible: ${JSON.stringify(offscreen)}`);
      await page.locator(selector).click({ position: { x: offscreen.x, y: offscreen.y } });
      assert(!(await textOf(page, "#heroTerminal")).includes("offscreen"), "offscreen content received pointer input");
      return `logical viewport clipped contain letterbox content (alpha=${offscreen.alpha}, red=${offscreen.red}) ` +
        `and rejected pointer input outside the viewport`;
    });

    await runCheck("6c. Responsive viewport fills remaining panel space", async () => {
      const selector = '#gameSurface canvas[data-scene="projected_scene"]';
      const measure = async () =>
        await page.evaluate((canvasSelector: string) => {
          const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
          const host = rect("#gameSurface"),
            canvas = rect(canvasSelector),
            header = rect("#surfaceHeader"),
            hud = rect("#gameHud");
          if (!host || !canvas || !header || !hud) throw new Error("viewport layout bounds unavailable");
          return {
            host: { x: host.x, y: host.y, right: host.right, bottom: host.bottom },
            canvas: { x: canvas.x, y: canvas.y, right: canvas.right, bottom: canvas.bottom },
            headerBottom: header.bottom,
            hudTop: hud.top,
          };
        }, selector);
      const assertLayout = (layout: Awaited<ReturnType<typeof measure>>, label: string) => {
        const borderTolerance = 2.1;
        assert(
          Math.abs(layout.canvas.x - layout.host.x) <= borderTolerance &&
            Math.abs(layout.canvas.right - layout.host.right) <= borderTolerance,
          `${label}: canvas does not fill viewport width`,
        );
        assert(
          Math.abs(layout.canvas.y - layout.host.y) <= borderTolerance &&
            Math.abs(layout.canvas.bottom - layout.host.bottom) <= borderTolerance,
          `${label}: canvas does not fill viewport height`,
        );
        assert(layout.host.y >= layout.headerBottom - 1, `${label}: viewport overlaps top UI`);
        assert(layout.host.bottom <= layout.hudTop + 1, `${label}: viewport overlaps lower UI`);
      };
      assertLayout(await measure(), "large");
      await page.setViewportSize({ width: 900, height: 900 });
      await page.waitForTimeout(100);
      assertLayout(await measure(), "responsive");
      await page.setViewportSize(VIEWPORT);
      return "canvas tracks the remaining viewport host at large and responsive panel sizes; flat UI bounds remain separate";
    });

    await runCheck("6d. Binary audio asset preview and Lua lifecycle", async () => {
      assert(originalPack, "original pack was not captured");
      const audioPack = structuredClone(originalPack);
      audioPack.manifest.project.version = "0.1.4";
      audioPack.manifest.files.push("assets/click.wav");
      audioPack.entries["assets/click.wav"] = silentWav();
      const script = `local function add(id, label, callback)
  game.ui.create({id=id, type='button', location='output', fields={{id='label', type='text', value=label}}, events={activate={callback=callback}}})
end
function audio_play() game.audio.play('assets/click.wav', {id='click', loop=false, volume=0.8}) end
function audio_pause() game.audio.pause('click') end
function audio_resume() game.audio.resume('click') end
function audio_volume() game.audio.set_volume('click', 0.5) end
function audio_loop() game.audio.set_loop('click', true) end
function audio_stop() game.audio.stop('click') end
function audio_stop_all() game.audio.stop_all() end
add('audio_play', 'Play audio', 'audio_play')
add('audio_pause', 'Pause audio', 'audio_pause')
add('audio_resume', 'Resume audio', 'audio_resume')
add('audio_volume', 'Set volume', 'audio_volume')
add('audio_loop', 'Loop audio', 'audio_loop')
add('audio_stop', 'Stop audio', 'audio_stop')
add('audio_stop_all', 'Stop all', 'audio_stop_all')
`;
      audioPack.entries["scripts/main.lua"] = new TextEncoder().encode(script);
      await page.evaluate(() => {
        const trace: string[] = [];
        const media = HTMLMediaElement.prototype;
        const pause = media.pause;
        const load = media.load;
        media.play = function () {
          trace.push("play");
          return Promise.resolve();
        };
        media.pause = function () {
          trace.push("pause");
          return pause.call(this);
        };
        media.load = function () {
          trace.push("load");
          return load.call(this);
        };
        Object.defineProperty(globalThis, "__inkforgeAudioTrace", { configurable: true, value: trace });
      });
      await importPack(page, audioPack, "audio_play", "scripts/main.lua");
      await page.locator('.nav[data-view="author"]').click();
      await page.locator('.file[data-file="assets/click.wav"]').click();
      assert(await page.locator("#assetPreview audio").count() === 1, "WAV preview controls missing");
      await page.locator('.nav[data-view="play"]').click();
      await waitForText(page, "#uiOutput", "Play audio");
      await page.locator('[data-ui="audio_play"]').click();
      await page.locator('[data-ui="audio_volume"]').click();
      await page.locator('[data-ui="audio_loop"]').click();
      await page.locator('[data-ui="audio_pause"]').click();
      await page.locator('[data-ui="audio_resume"]').click();
      await page.locator('[data-ui="audio_stop"]').click();
      await page.locator('[data-ui="audio_stop_all"]').click();
      const trace = await page.evaluate(() =>
        (globalThis as typeof globalThis & { __inkforgeAudioTrace: string[] }).__inkforgeAudioTrace
      );
      assert(trace.includes("play"), `audio play was not bridged: ${trace.join(",")}`);
      assert(
        trace.filter((entry) => entry === "pause").length >= 2,
        `audio pause/stop lifecycle missing: ${trace.join(",")}`,
      );
      assert(trace.includes("load"), `audio stop did not dispose the element: ${trace.join(",")}`);
      return `WAV asset round-tripped through ZIP/IndexedDB, Author preview rendered native controls, and Lua play/pause/resume/volume/loop/stop/stop_all reached AudioManager (${
        trace.join(",")
      })`;
    });

    await runCheck("6e. Equal/older import is declined", async () => {
      assert(originalPack, "original pack was not captured");
      const oldPack = structuredClone(originalPack);
      const temp = await Deno.makeTempDir({ prefix: "inkforge-smoke-older-" });
      const path = `${temp}\\older.inkforge`;
      const entries = {
        ...oldPack.entries,
        "manifest.json": new TextEncoder().encode(`${JSON.stringify(oldPack.manifest, null, 2)}\n`),
      };
      await Deno.writeFile(path, zipSync(entries));
      await page.locator("#importFile").setInputFiles(path);
      await waitForText(page, "#diagnostics", "already v0.1.4");
      assert(
        await page.locator("#title").textContent().then((value) => value?.includes("Lantern Below")),
        "older import changed active project",
      );
      return "an older package was declined and the active newer project remained loaded";
    });

    await runCheck("7. New project restores the starter", async () => {
      await page.locator("#newBtn").click();
      await waitForTextEquals(page, "#storyTitle", "Stone Entry");
      await page.waitForFunction(
        () => (document.querySelector("#title")?.textContent ?? "").includes("Copy"),
        undefined,
        { timeout: BOOT_TIMEOUT },
      );
      const projectTitle = await textOf(page, "#title");
      assert(projectTitle.includes("Copy"), `new project did not receive a copy identity: ${projectTitle}`);
      await page.locator('.nav[data-view="author"]').click();
      const code = await page.locator("#code").inputValue();
      assert(code.includes("startLocation: entry"), "#code does not contain startLocation: entry");
      await page.locator("#loadBtn").click();
      await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length >= 2, undefined, {
        timeout: BOOT_TIMEOUT,
      });
      const activeCard = page.locator("#projectList .project-card").filter({ hasText: "Active" });
      assert(await activeCard.count() === 1, "project library did not mark exactly one active project");
      assert(
        await activeCard.textContent().then((value) => value?.includes("Updated")),
        "project card omitted updated time",
      );
      await activeCard.locator("button", { hasText: "Delete" }).click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLElement>("#projectList .project-card")].every((card) =>
            !card.dataset.project?.startsWith("lantern-below-copy-")
          ),
        undefined,
        { timeout: BOOT_TIMEOUT },
      );
      await waitForTextEquals(page, "#storyTitle", "Stone Entry");
      assert(
        await page.locator("#projectList .project-card").filter({ hasText: "Active" }).count() === 1,
        "deleting active project did not select a fallback",
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForTextEquals(page, "#storyTitle", "Stone Entry");
      await page.locator("#loadBtn").click();
      await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length >= 1, undefined, {
        timeout: BOOT_TIMEOUT,
      });
      assert(
        await page.locator('#projectList [data-project="lantern-below"] .project-active').count() === 1,
        "active project did not persist across reload",
      );
      return `#newBtn created an independent starter copy (play title Stone Entry, project "${projectTitle}", ` +
        `#code has startLocation: entry); library showed active/updated metadata, deleted the active copy to the pinned starter, and restored it after reload`;
    });
  } finally {
    await context.close();
    await browser.close();
    await server.shutdown();
  }

  const consoleErrors = logs.filter((log) => log.kind === "console" && log.level === "error");
  const pageErrors = logs.filter((log) => log.kind === "pageerror");
  const dialogs = logs.filter((log) => log.kind === "console" && log.level === "dialog");

  console.log("\n== Smoke summary ==");
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name}`);
  }
  console.log(`\n${results.filter((r) => r.passed).length} / ${results.length} assertions passed`);
  console.log(`console error messages: ${consoleErrors.length}`);
  for (const log of consoleErrors) console.log(`  - ${short(log.text, 200)}`);
  console.log(`page errors: ${pageErrors.length}`);
  for (const log of pageErrors) console.log(`  - ${short(log.text, 200)}`);
  console.log(`dialogs: ${dialogs.length}`);
  for (const log of dialogs) console.log(`  - ${short(log.text, 200)}`);

  const failed = results.filter((result) => !result.passed);
  if (failed.length) {
    console.log("\n== Failed assertion evidence ==");
    for (const result of failed) console.log(`- ${result.name}: ${short(result.evidence, 600)}`);
  }

  Deno.exit(failed.length ? 1 : 0);
}

function pageErrorText(): string {
  return logs.filter((log) => log.kind === "pageerror").map((log) => log.text).join(" | ");
}

await main();
