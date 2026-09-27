import { build } from "./build.ts";
import { bumpVersion } from "./package.ts";
import { DIST, TEMPLATES } from "./paths.ts";
import { serveStatic } from "./server.ts";
import { unzipSync, zipSync } from "fflate";
import { join } from "node:path";
import { collectReferencedLuaNames, readScenarioMeta, validateScenario } from "../src/yaml/compose.ts";
import { endRun, npcInstanceDefaults, setLocation } from "../src/engine/state.ts";
import { flushView, markViewDirty } from "../src/engine/events.ts";
import { discoverableTalks } from "../src/engine/conversation.ts";
import type { EngineRuntime } from "../src/types/index.ts";
import type { EditorHarness } from "../src/editor/harness.ts";
import type { Browser, BrowserContext, ConsoleMessage, Dialog, Page, Request } from "playwright-core";

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

/**
 * Read the Author view's buffer.
 *
 * The old `#code` textarea is gone; the editor is CodeMirror, which renders only
 * the lines currently in view, so reading `.cm-content` would silently truncate
 * on a long file. The app publishes its buffer as `globalThis.inkforgeEditor`
 * for exactly this purpose (see `src/editor/harness.ts`). A `page.evaluate`
 * callback is serialised into the page, so the cast has to be written inline
 * rather than through a shared helper.
 */
async function editorValue(page: Page): Promise<string> {
  return await page.evaluate(() => (globalThis as { inkforgeEditor?: EditorHarness }).inkforgeEditor?.getValue() ?? "");
}

/**
 * Wait for the Author view's buffer to hold `needle`.
 *
 * A click's handler runs on the page's main thread, and a `page.evaluate` read
 * can be served before that thread has run it: the click resolves when the
 * browser has queued the event, not when the app has reacted to it. Reading
 * straight after a click is therefore a race, and one this suite loses whenever
 * the machine is busy — the file click lands, and the read that follows still
 * sees the previous file. Waiting for the value the check is about removes the
 * race without changing what is asserted.
 */
async function waitForEditorContains(page: Page, needle: string, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    (value: string) =>
      (globalThis as { inkforgeEditor?: EditorHarness }).inkforgeEditor?.getValue().includes(value) ?? false,
    needle,
    { timeout },
  );
}

/**
 * Replace the buffer wholesale, as the old `#code.fill()` did.
 *
 * This models an author's edit rather than a programmatic file switch: the
 * harness hook runs the same change path typing does, so `#saved`,
 * `schedulePersist` and the export flush are all still exercised.
 */
async function fillEditor(page: Page, text: string): Promise<void> {
  await page.evaluate(
    (value: string) => (globalThis as { inkforgeEditor?: EditorHarness }).inkforgeEditor?.setValue(value),
    text,
  );
}

/**
 * Wait out CodeMirror's `interactionDelay` before acting on a completion popup.
 *
 * `acceptCompletion` and `closeCompletion` both refuse to act until 75 ms have
 * passed since the popup opened, so that the keystroke which opened it cannot
 * also accept or dismiss it. A person never acts inside that window — they have
 * to see the list first — but a check presses Enter the instant the `li` exists,
 * which lands inside the window on a fast machine and outside it on a slow one.
 * That is the whole of the flake this wait removes; the delay is CodeMirror's,
 * not the app's, and the app does not change to suit the test.
 */
async function settleCompletion(page: Page): Promise<void> {
  await page.waitForTimeout(150);
}

/**
 * Assert the editor's gutter numbers a document's final line.
 *
 * The gutter is virtualised along with the content, so its element count is the
 * *visible* line count rather than the file's, and CodeMirror adds one hidden
 * spacer element that sizes the column from the widest number ("999" for a
 * three-digit file). Scroll to the end and wait for the last line's number to
 * appear — which is what the old `#gutter` text comparison was really checking.
 */
async function assertGutterReaches(page: Page, lastLine: number, timeout = 5_000): Promise<void> {
  await page.locator(".cm-scroller").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForFunction(
    (last: number) =>
      [...document.querySelectorAll<HTMLElement>(".cm-gutterElement")].some((element) =>
        element.style.visibility !== "hidden" && element.textContent?.trim() === String(last)
      ),
    lastLine,
    { timeout },
  );
}

/**
 * Move the mouse over a token in the editor, for hover assertions.
 *
 * The coordinates come from a DOM `Range` over the token's own text node — the
 * only reliable way to land on a word in a virtualised, token-split editor.
 * CodeMirror resolves the hover from the pointer's position, so a real mouse
 * move is what it takes.
 */
async function hoverToken(page: Page, lineText: string, token: string): Promise<void> {
  // The line has to be rendered before it has a position: CodeMirror only puts
  // the lines in view into the DOM, and a `setValue` does not oblige it to
  // redraw on the same tick. A line that never appears still fails, on the
  // timeout below.
  await page.waitForFunction(
    (text: string) => [...document.querySelectorAll(".cm-line")].some((node) => node.textContent?.includes(text)),
    lineText,
    { timeout: 5_000 },
  );
  const point = await page.evaluate(({ line, word }: { line: string; word: string }) => {
    const target = [...document.querySelectorAll<HTMLElement>(".cm-line")].find((node) =>
      node.textContent?.includes(line)
    );
    if (!target) return null;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent ?? "").indexOf(word);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + word.length);
      const box = range.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    return null;
  }, { line: lineText, word: token });
  assert(point, `no editable occurrence of ${token} on the line containing ${lineText}`);
  await page.mouse.move(point.x, point.y);
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

function engineRuntimeFixture(location: string): EngineRuntime {
  return {
    location,
    state: {},
    inventory: [],
    events: [],
    droppedEvents: 0,
    over: false,
    ui: { hidden: new Set(), overrides: {}, elements: [] },
    modals: { open: null, activePages: {} },
    items: { hidden: new Set() },
    tools: { entries: new Map() },
    conversation: null,
    lua: null,
    canvasEngine: null,
    viewDirty: false,
  } as EngineRuntime;
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

/**
 * The pack version ladder this suite walks, derived from what the export carries.
 *
 * The starter's version belongs to the template, not to this file: hardcoding the
 * steps would make the next template bump turn the first import into a no-op —
 * an equal version is declined — and fail check 6 for entirely the wrong reason.
 */
function packLadder(base: string, step: number): string {
  let version = base;
  for (let index = 0; index < step; index += 1) version = bumpVersion(version, "patch");
  return version;
}

/** The version of the pinned project as the library holds it. */
async function storedProjectVersion(page: Page): Promise<string> {
  return await page.evaluate(() =>
    new Promise<string>((resolve, reject) => {
      const request = indexedDB.open("inkforge-project-library");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const all = request.result.transaction("projects", "readonly").objectStore("projects").getAll();
        all.onsuccess = () => {
          const rows = all.result as Array<{ identity: { version: string }; pinned?: boolean }>;
          resolve(rows.find((row) => row.pinned)?.identity.version ?? "");
        };
        all.onerror = () => reject(all.error);
      };
    })
  );
}

async function exportPack(page: Page): Promise<PackShape> {
  await page.locator("#loadBtn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportBtn").click();
  const download = await downloadPromise;
  await page.locator("#closeProjects").click();
  const path = await download.path();
  assert(path, "export download produced no local path");
  const archive = unzipSync(await Deno.readFile(path));
  const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"]));
  return { manifest, entries: archive } as PackShape;
}

async function importPack(
  page: Page,
  pack: PackShape,
  storageMarker: string,
  storagePath: string,
  options: { expectReady?: boolean } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "inkforge-smoke-" });
  const filePath = `${dir}\\pack.inkforge`;
  const entries = {
    ...pack.entries,
    "manifest.json": new TextEncoder().encode(`${JSON.stringify(pack.manifest, null, 2)}\n`),
  };
  await Deno.writeFile(filePath, zipSync(entries));
  await page.locator("#loadBtn").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.locator("#importBtn").click();
  await (await chooserPromise).setFiles(filePath);
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
  // A pack whose YAML does not compose is imported on purpose in check 9b, and
  // it never becomes ready. The stored file already says the import landed, so
  // the ready wait is opt-out rather than a 30-second timeout.
  if (options.expectReady !== false) {
    await page.waitForFunction(
      (projectId: string) =>
        document.body.dataset.projectId === projectId && document.body.dataset.projectReady === "true",
      pack.manifest.project.id,
      { timeout: BOOT_TIMEOUT },
    );
  }
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

    await runCheck("1a. Main loop ticks clean (no per-tick Lua errors)", async () => {
      // The bridge's fixed-rate loop runs `Update(dt)` every 16ms, and a failure
      // there is reported to the transcript rather than thrown, so it raises no
      // console or page error. A leaked Lua stack slot used to kill the state
      // after ~40 ticks, which showed up only as a growing pile of transcript
      // entries. Idle for long enough to expose that, and assert it stays quiet.
      await page.waitForTimeout(3000);
      const state = await page.evaluate(() => {
        const entries = [...document.querySelectorAll("#heroTerminal .entry")];
        return {
          total: entries.length,
          errors: entries.filter((node) => node.classList.contains("error")).length,
          diagnostics: (document.querySelector("#diagnostics")?.textContent ?? "").trim(),
        };
      });
      assert(state.errors === 0, `${state.errors} error entries after idle ticking: ${state.diagnostics}`);
      assert(state.diagnostics.includes("Ready"), `diagnostics after idle ticking: ${state.diagnostics}`);
      return `${state.total} transcript entries, 0 errors after 3s idle; diagnostics="${state.diagnostics}"`;
    });

    await runCheck("2. Lua/Wasmoon boot + require()", async () => {
      await waitForText(page, "#gameHud", "Focus", CANVAS_TIMEOUT);
      await waitForText(page, "#uiOutput", "Listen at the threshold", CANVAS_TIMEOUT);
      const hud = await textOf(page, "#gameHud");
      assert(hud.includes("3 / 5"), `Focus meter value missing: ${short(hud, 120)}`);

      // A meter row is anonymous without the authored id, and a skin rule keyed
      // to an id that never reaches the DOM is dead in silence — the focus meter
      // sat on the default fill for as long as the hook was missing. So this
      // reads the rendered colour rather than the attribute: losing the hook
      // makes the two meters match, which is the failure, however it happened.
      const fills = await page.evaluate(() => {
        const fillOf = (selector: string) => {
          const fill = document.querySelector(`${selector} em`);
          return fill ? getComputedStyle(fill).backgroundColor : "";
        };
        return {
          focus: fillOf('#gameHud [data-meter="focus"]'),
          plain: fillOf("#gameHud > div:not([data-meter='focus'])"),
        };
      });
      assert(fills.focus && fills.plain, `meter id hook missing: ${JSON.stringify(fills)}`);
      assert(fills.focus !== fills.plain, `focus meter is not styled apart from the default: ${fills.focus}`);

      await page.locator('#uiOutput button[data-ui="listen"]').click();
      await waitForText(page, "#heroTerminal", "Water moves somewhere beyond the stone.");
      return `#gameHud gained Focus meter ("${short(hud, 90)}"), carrying its authored id into the DOM ` +
        `(fill ${fills.focus} against the default ${fills.plain}); clicked "Listen at the threshold"; ` +
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
      await waitForTextEquals(page, "#format", "YAML");
      await waitForEditorContains(page, "lampLit: false");
      const stateCode = await editorValue(page);
      assert(stateCode.includes("lampLit: false"), "state.yml does not contain lampLit: false");

      await page.locator('.file[data-file="scripts/main.lua"]').first().click();
      await waitForTextEquals(page, "#format", "LUA");
      await waitForEditorContains(page, 'require("scripts/threshold")');
      const luaCode = await editorValue(page);
      assert(luaCode.includes('require("scripts/threshold")'), "main.lua does not contain the require call");

      const codeLines = luaCode.split("\n").length;
      await assertGutterReaches(page, codeLines);
      await page.locator(".cm-content").press("ArrowDown");
      const cursor = await textOf(page, "#cursor");
      assert(/^Ln \d+, Col \d+$/.test(cursor), `#cursor="${cursor}"`);

      // `#` is not a Lua comment; appending it would make the script unparseable and
      // break the restart in assertion 5. Use Lua's line-comment syntax so the edit is
      // still a persisted, non-leaking marker while the script stays valid.
      await fillEditor(page, `${luaCode}\n-- smoke-edit`);
      const saved = await textOf(page, "#saved");
      assert(saved === "saved locally", `#saved=${saved}`);
      await waitForStoredText(page, "smoke-edit", "scripts/main.lua");

      await page.locator('.file[data-file="scenario.yaml"]').first().click();
      await waitForTextEquals(page, "#format", "YAML");
      await waitForEditorContains(page, "startLocation: entry");
      const scenarioCode = await editorValue(page);
      assert(scenarioCode.includes("startLocation: entry"), "scenario.yaml lost startLocation: entry");
      assert(!scenarioCode.includes("smoke-edit"), "the main.lua edit leaked into scenario.yaml");
      return `#authorView shown, #playView hidden; state.yml=YAML/lampLit:false; main.lua=LUA/require; ` +
        `gutter numbering reaches line ${codeLines}; #cursor="${cursor}"; ` +
        `edit persisted (#saved="saved locally", IndexedDB contains smoke-edit); scenario.yaml intact`;
    });

    await runCheck("4a. Editor tabs: opening a file appends and activates a tab", async () => {
      await page.locator('.nav[data-view="author"]').click();
      // Test 4 opened state.yml on top of the two default tabs; close that extra,
      // non-active tab so this check starts from the original two-tab set. The
      // tab bar is read through a wait, not once: the view has just been switched
      // to, and a single read can be served before it has rendered.
      await page.waitForFunction(
        () => document.querySelectorAll(".tabs .tab").length >= 2,
        undefined,
        { timeout: 5_000 },
      );
      if ((await page.locator(".tabs .tab").count()) > 2) {
        await page.locator('.tab[data-file="state.yml"] i').click();
        await page.waitForFunction(
          () => document.querySelectorAll('.tab[data-file="state.yml"]').length === 0,
          undefined,
          { timeout: 5_000 },
        );
      }
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".tabs .tab").length === 2 &&
          document.querySelectorAll('.tab[data-file="scenario.yaml"].active').length === 1,
        undefined,
        { timeout: 5_000 },
      );
      const defaultCount = await page.locator(".tabs .tab").count();
      assert(defaultCount === 2, `expected 2 default tabs, found ${defaultCount}`);
      assert(
        (await page.locator('.tab[data-file="scenario.yaml"].active').count()) === 1,
        "scenario.yaml is not the active tab after startup",
      );
      await page.locator('.file[data-file="instances.yml"]').first().click();
      await page.waitForFunction(
        () => document.querySelectorAll(".tabs .tab").length === 3,
        undefined,
        { timeout: 5_000 },
      );
      const count = await page.locator(".tabs .tab").count();
      assert(count === 3, `expected 3 tabs after opening instances.yml, found ${count}`);
      assert(
        (await page.locator('.tab[data-file="instances.yml"].active').count()) === 1,
        "the instances.yml tab is not active",
      );
      await waitForEditorContains(page, "entry_lantern");
      const code = await editorValue(page);
      assert(code.includes("entry_lantern"), "instances.yml content was not loaded into the editor");
      return `started from the 2 default tabs; clicking instances.yml appended a third tab, ` +
        `marked it active, and loaded its content ("entry_lantern")`;
    });

    await runCheck("4b. Editor tabs: closing the active tab switches to a remaining tab", async () => {
      await page.locator('.tab[data-file="instances.yml"] i').click();
      await page.waitForFunction(
        () => document.querySelectorAll(".tabs .tab").length === 2,
        undefined,
        { timeout: 5_000 },
      );
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
      await waitForTextEquals(page, "#format", "LUA");
      const format = await textOf(page, "#format");
      assert(format === "LUA", `#format=${format} after switching to scripts/main.lua`);
      return `clicking the instances.yml × removed the tab (2 left) and activated the nearest ` +
        `remaining tab scripts/main.lua (#format=LUA)`;
    });

    await runCheck("4c. Editor tabs: reopening after close restores VFS content", async () => {
      await page.locator('.file[data-file="instances.yml"]').first().click();
      await page.waitForFunction(
        () => document.querySelectorAll(".tabs .tab").length === 3,
        undefined,
        { timeout: 5_000 },
      );
      const count = await page.locator(".tabs .tab").count();
      assert(count === 3, `expected 3 tabs after reopening instances.yml, found ${count}`);
      await waitForEditorContains(page, "entry_lantern");
      const code = await editorValue(page);
      assert(code.includes("entry_lantern"), "instances.yml content was lost when its tab was closed");
      return `reopening instances.yml from the explorer created its tab again and restored its ` +
        `content ("entry_lantern") — closing a tab does not delete VFS data`;
    });

    await runCheck("4d. Editor tabs: closing the last tab clears the editor and reopen restores", async () => {
      // Each close is waited for, not assumed: the count is read through a wait,
      // so the loop cannot exit on a read that ran before the handler did.
      while ((await page.locator(".tabs .tab").count()) > 0) {
        const before = await page.locator(".tabs .tab").count();
        await page.locator(".tabs .tab i").first().click();
        await page.waitForFunction(
          (previous: number) => document.querySelectorAll(".tabs .tab").length < previous,
          before,
          { timeout: 5_000 },
        );
      }
      const emptyCode = await editorValue(page);
      const emptyFormat = await textOf(page, "#format");
      assert(emptyCode === "", `the editor was not cleared: "${short(emptyCode)}"`);
      assert(emptyFormat === "", `#format was not cleared: "${emptyFormat}"`);
      assert(
        (await page.locator(".file.active").count()) === 0,
        "an explorer file is still active after the last tab was closed",
      );
      await page.locator('.file[data-file="scenario.yaml"]').first().click();
      await waitForTextEquals(page, "#format", "YAML");
      await waitForEditorContains(page, "startLocation: entry");
      const code = await editorValue(page);
      const format = await textOf(page, "#format");
      assert(code.includes("startLocation: entry"), "scenario.yaml content was lost after closing every tab");
      assert(format === "YAML", `#format=${format} after reopening scenario.yaml`);
      assert(
        (await page.locator(".tabs .tab").count()) === 1,
        "reopening scenario.yaml did not create a tab",
      );
      return `closing every tab left 0 tabs with an empty editor and #format="", and no active explorer ` +
        `file; reopening scenario.yaml restored "startLocation: entry" (YAML) in a fresh active tab`;
    });

    await runCheck("4e. Rapid edits are flushed before export", async () => {
      await page.locator('.nav[data-view="author"]').click();
      await page.locator('.file[data-file="scripts/main.lua"]').first().click();
      // Read `base` only once main.lua is really in the buffer. The click resolves
      // when the browser has queued the event, not when the app has reacted, so a
      // read straight after it can still return the *previous* file — and a check
      // that then writes `base` back would overwrite main.lua with scenario.yaml.
      await waitForEditorContains(page, 'require("scripts/threshold")');
      const base = await editorValue(page);
      await fillEditor(page, `${base}\n-- rapid-edit-1`);
      await fillEditor(page, `${base}\n-- rapid-edit-2`);
      await fillEditor(page, `${base}\n-- rapid-edit-3`);
      const pack = await exportPack(page);
      const script = asText(pack, "scripts/main.lua");
      assert(script.includes("-- rapid-edit-3"), "the last rapid edit was not flushed before export");
      return "three rapid edits were followed immediately by Export; the exported scripts/main.lua " +
        "contains the final edit, proving pending saves flush before export";
    });

    await runCheck("4f. Lua completion and hover come from the API manifest", async () => {
      await page.locator('.nav[data-view="author"]').click();
      await page.locator('.file[data-file="scripts/main.lua"]').first().click();
      // Read `base` only once main.lua is really in the buffer. The click resolves
      // when the browser has queued the event, not when the app has reacted, so a
      // read straight after it can still return the *previous* file — and a check
      // that then writes `base` back would overwrite main.lua with scenario.yaml.
      await waitForEditorContains(page, 'require("scripts/threshold")');
      const base = await editorValue(page);

      try {
        // Typed, not filled: completion has to respond to real keystrokes. The
        // buffer is restored at the end, so the probe text never reaches the
        // script the later checks restart with.
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
        await page.keyboard.type("\n-- smoke-assist\nlocal function smoke_assist()\n  ");
        await page.keyboard.type("GameState.");
        await page.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 5_000 });
        await settleCompletion(page);
        const members = await page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").evaluateAll((nodes) =>
          nodes.map((node) => node.textContent ?? "")
        );
        assert(members.includes("get") && members.includes("set"), `GameState. offered: ${members.join(",")}`);
        const memberInfo = await page.locator(".cm-completionInfo").first().textContent() ?? "";
        assert(
          memberInfo.includes("state value"),
          `the completion panel carries no description: "${short(memberInfo)}"`,
        );

        // A member is inserted with its parentheses, so the author can type the
        // arguments straight into them. Read from the buffer rather than from
        // `.cm-activeLine`: which line CodeMirror marks active is a rendering
        // detail, and the buffer is what the check is actually about.
        await page.keyboard.press("Enter");
        const accepted = await editorValue(page);
        assert(
          accepted.includes("GameState.get()"),
          `accepting the member produced ${short(accepted.slice(-140))}`,
        );

        // The lifecycle functions are offered at statement start, where nothing
        // but our manifest can know them.
        await page.keyboard.press("Control+End");
        await page.keyboard.type("\n");
        await page.keyboard.type("OnIn");
        await page.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 5_000 });
        await settleCompletion(page);
        const lifecycles = await page.locator(".cm-tooltip-autocomplete li .cm-completionLabel").evaluateAll((nodes) =>
          nodes.map((node) => node.textContent ?? "")
        );
        assert(lifecycles.includes("OnInit"), `OnIn offered: ${lifecycles.join(",")}`);
        await page.keyboard.press("Escape");

        // Hover gives the same descriptions without the popup, from the same
        // table, and the segment under the pointer decides the depth: the
        // namespace on `GameState`, the method on `get`. The probe is its own
        // short buffer because CodeMirror renders only the lines in view, so a
        // line appended to the end of `base` would have no DOM to hover — and
        // `base` is restored below regardless.
        await fillEditor(page, 'local function smoke_assist()\n  local oil = GameState.get("oil")\nend');
        await hoverToken(page, "GameState.get", "GameState");
        await page.waitForSelector(".cm-tooltip .lua-doc-signature", { timeout: 5_000 });
        const namespaceSignature = await page.locator(".cm-tooltip .lua-doc-signature").first().textContent() ?? "";
        const namespaceDoc = await page.locator(".cm-tooltip .lua-doc-summary").first().textContent() ?? "";
        assert(
          namespaceSignature === "GameState" && namespaceDoc.includes("Reading and writing state"),
          `hovering GameState showed "${short(namespaceSignature)}" / "${short(namespaceDoc)}"`,
        );
        await hoverToken(page, "GameState.get", "get");
        await page.waitForFunction(
          () => document.querySelector(".cm-tooltip .lua-doc-signature")?.textContent === "GameState.get(path)",
          undefined,
          { timeout: 5_000 },
        );
        const memberDoc = await page.locator(".cm-tooltip .lua-doc-summary").first().textContent() ?? "";
        assert(memberDoc.includes("state value"), `hovering get showed "${short(memberDoc)}"`);

        await fillEditor(page, base);
        assert(await editorValue(page) === base, "the probe text was not cleared from the buffer");
        return `typing "GameState." offered ${members.join(",")} with a description and inserted GameState.get(); ` +
          `"OnIn" offered ${lifecycles.join(",")}; hovering GameState/get showed ` +
          `"${short(namespaceSignature)}" and "GameState.get(path)" with their descriptions`;
      } finally {
        // A safety net, not a tidy-up: an assertion above can throw with the
        // probe still in the buffer, and checks 5 and 6 restart the runtime from
        // this file — a stray `GameState.` fails the Lua load, so one real
        // failure would report as three.
        if (await editorValue(page) !== base) await fillEditor(page, base);
      }
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
        modified.manifest.project.version = packLadder(packA.manifest.project.version, 1);
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
        controlPack.manifest.project.version = packLadder(packA.manifest.project.version, 2);
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
      projected.manifest.project.version = packLadder(originalPack.manifest.project.version, 3);
      const script = `-- projected-scene-fixture
GameCanvas.create({
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
        GameOutput.add('projected ' .. math.floor(event.worldX + 0.5) .. ',' .. math.floor(event.worldY + 0.5))
      end },
    },
    { id = 'overlay', type = 'rect', x = 8, y = 8, width = 90, height = 22, fill = '#182022', layer = 'overlay', space = 'screen' },
    { id = 'offscreen', type = 'rect', x = 50, y = 260, width = 80, height = 20, fill = '#ff0000', layer = 'overlay', space = 'screen',
      events = { pointer_down = function() GameOutput.add('offscreen') end },
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
      audioPack.manifest.project.version = packLadder(originalPack.manifest.project.version, 4);
      audioPack.manifest.files.push("assets/click.wav");
      audioPack.entries["assets/click.wav"] = silentWav();
      const script = `local function add(id, label, callback)
  GameUI.create({id=id, type='button', location='output', fields={{id='label', type='text', value=label}}, events={activate={callback=callback}}})
end
function audio_play() GameAudio.play('assets/click.wav', {id='click', loop=false, volume=0.8}) end
function audio_pause() GameAudio.pause('click') end
function audio_resume() GameAudio.resume('click') end
function audio_volume() GameAudio.setVolume('click', 0.5) end
function audio_loop() GameAudio.setLoop('click', true) end
function audio_stop() GameAudio.stop('click') end
function audio_stop_all() GameAudio.stopAll() end
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
      // The declined version is the one the library holds, which the earlier checks
      // raised from the pack's own version; read it rather than restating the ladder.
      const stored = await storedProjectVersion(page);
      assert(stored && stored !== originalPack.manifest.project.version, `stored version did not advance: ${stored}`);
      await waitForText(page, "#diagnostics", `already v${stored}`);
      assert(
        await page.locator("#title").textContent().then((value) => value?.includes("Lantern Below")),
        "older import changed active project",
      );
      return "an older package was declined and the active newer project remained loaded";
    });

    await runCheck("6f. Authored markup is rendered as text (XSS regression)", async () => {
      const malicious = '<img src=x onerror="window.__xss=1">';
      const scenario = `# xss-fixture
meta:
  title: '${malicious}'
startLocation: entry
state: {}
player: {}
locations:
  entry:
    title: '<script>window.__xss=1</script>'
    text:
      - '${malicious}'
      - give: '${malicious}'
    actions:
      - id: 'evil">${malicious}'
        label: '<b>bold</b>'
        then:
          - text: '<svg onload="window.__xss=1">'
ui:
  elements:
    - id: xss_button
      type: button
      location: sidebar
      fields:
        - id: label
          type: text
          value: '${malicious}'
    - id: xss_meter
      type: meter
      location: hud
      fields:
        - id: label
          type: text
          value: '${malicious}'
        - id: value
          type: state
          path: hp
        - id: max
          type: state
          path: hpMax
`;
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "xss-fixture", title: "XSS Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(scenario),
          "scripts/main.lua": new TextEncoder().encode("-- xss-fixture\n"),
        },
      };
      await importPack(page, pack, "xss-fixture", "scenario.yaml");
      await waitForText(page, "#storyTitle", "window.__xss=1");
      const state = await page.evaluate(() => {
        const regions = [
          "#heroTerminal",
          "#heroChoices",
          "#surfaceHeader",
          "#gameHud",
          "#uiOutput",
          "#eventLog",
          "#storyTitle",
        ];
        const active = regions.flatMap((region) => [
          ...document.querySelectorAll(`${region} img, ${region} svg, ${region} script, ${region} iframe`),
        ]);
        const choice = document.querySelector<HTMLElement>("#heroChoices .choice");
        return {
          marker: (globalThis as typeof globalThis & { __xss?: number }).__xss,
          active: active.length,
          terminal: document.querySelector("#heroTerminal")?.textContent ?? "",
          choiceText: choice?.textContent ?? "",
          choiceCmd: choice?.getAttribute("data-cmd") ?? "",
          choiceChildren: choice?.children.length ?? -1,
          header: document.querySelector("#surfaceHeader")?.textContent ?? "",
        };
      });
      assert(state.marker === undefined, `authored markup executed script (__xss=${state.marker})`);
      assert(state.active === 0, `authored markup created ${state.active} active element(s)`);
      assert(state.terminal.includes(malicious), "terminal did not render authored markup as literal text");
      assert(state.choiceText.includes("<b>bold</b>"), "choice label was not rendered as literal text");
      assert(state.choiceCmd === `@evil">${malicious}`, `choice data-cmd was altered: ${state.choiceCmd}`);
      assert(state.choiceChildren === 0, "choice button gained child elements");
      assert(state.header.includes(malicious), "sidebar label was not rendered as literal text");
      return "malicious scenario text, action label/id, HUD/sidebar labels and inventory item id were all " +
        "rendered as literal text with no active elements and no script execution";
    });

    await runCheck("6g. Authored error text is rendered as text", async () => {
      const malicious = '<img src=x onerror="window.__xss=1">';
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "xss-error-fixture", title: "XSS Error Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`startLocation: entry\nx: !import '${malicious}.yml'\n`),
          "scripts/main.lua": new TextEncoder().encode("-- xss-error-fixture\n"),
        },
      };
      const dir = await Deno.makeTempDir({ prefix: "inkforge-smoke-xss-" });
      const filePath = `${dir}\\pack.inkforge`;
      await Deno.writeFile(
        filePath,
        zipSync({
          ...pack.entries,
          "manifest.json": new TextEncoder().encode(`${JSON.stringify(pack.manifest, null, 2)}\n`),
        }),
      );
      await page.locator("#importFile").setInputFiles(filePath);
      await waitForText(page, "#heroTerminal", "Imported file not found");
      const state = await page.evaluate(() => ({
        marker: (globalThis as typeof globalThis & { __xss?: number }).__xss,
        active: document.querySelectorAll("#heroTerminal img, #heroTerminal script, #heroTerminal svg").length,
        text: document.querySelector("#heroTerminal")?.textContent ?? "",
      }));
      assert(state.marker === undefined, `error text executed script (__xss=${state.marker})`);
      assert(state.active === 0, `error text created ${state.active} active element(s)`);
      assert(state.text.includes("Imported file not found"), "error text was not rendered");
      return "a malicious !import path surfaced through the scenario error path as literal text " +
        "with no active elements and no script execution";
    });

    await runCheck("6h. Markdown renders, and authored links are gated", async () => {
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "markdown-fixture", title: "Markdown Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`startLocation: entry
state: {}
player: {}
locations:
  entry:
    title: 'Entry **bold**'
    text:
      - '- 3 gold coins lie here.'
      - |
        The note lists what to carry:
        - a stub of candle
        - a bent nail
      - 'See [the vault](https://example.invalid/vault) or [bad](javascript:window.__xssLink=1).'
`),
          "scripts/main.lua": new TextEncoder().encode("-- markdown-fixture\n"),
        },
      };
      await importPack(page, pack, "- 3 gold coins lie here.", "scenario.yaml");
      await waitForText(page, "#heroTerminal", "3 gold coins lie here.");

      // The transcript rule, both halves: a one-line string is prose even when it
      // starts with a list marker, and a `|` block is a document.
      const shapes = await page.evaluate(() => {
        const entries = [...document.querySelectorAll("#heroTerminal .entry")];
        const find = (needle: string) => entries.find((entry) => (entry.textContent ?? "").includes(needle));
        const coins = find("3 gold coins");
        const note = find("The note lists");
        const anchors = [...document.querySelectorAll("#heroTerminal a.md-link")];
        const title = document.querySelector("#storyTitle");
        return {
          marker: (globalThis as typeof globalThis & { __xssLink?: number }).__xssLink,
          anchors: anchors.length,
          href: anchors[0]?.getAttribute("href") ?? "",
          coinsLists: coins?.querySelectorAll("ul, ol").length ?? -1,
          coinsText: coins?.textContent ?? "",
          noteItems: note?.querySelectorAll("ul > li").length ?? -1,
          noteItemText: note?.querySelector("ul > li")?.textContent ?? "",
          badLiteral: (document.querySelector("#heroTerminal")?.textContent ?? "")
            .includes("javascript:window.__xssLink=1"),
          titleText: title?.textContent ?? "",
          titleStrong: title?.querySelectorAll("strong").length ?? -1,
        };
      });
      assert(shapes.marker === undefined, `a javascript: link executed (__xssLink=${shapes.marker})`);
      assert(shapes.anchors === 1, `expected one rendered link, found ${shapes.anchors}`);
      assert(
        shapes.href === "https://example.invalid/vault",
        `the surviving anchor pointed at ${shapes.href}`,
      );
      assert(
        shapes.badLiteral,
        "the javascript: link was not left as literal markdown text",
      );
      assert(shapes.coinsLists === 0, `a one-line entry became a list: ${shapes.coinsText}`);
      assert(
        shapes.coinsText.includes("- 3 gold coins lie here."),
        `the leading hyphen was consumed as a list marker: ${shapes.coinsText}`,
      );
      assert(
        shapes.noteItems === 2,
        `the '|' block entry did not render a real list (${shapes.noteItems} item(s))`,
      );
      assert(
        shapes.noteItemText === "a stub of candle",
        `the block list rendered ${shapes.noteItemText}`,
      );
      assert(
        shapes.titleText === "Entry bold" && shapes.titleStrong === 1,
        `the location title was not rendered as markdown: "${shapes.titleText}" / ${shapes.titleStrong} strong`,
      );

      // A link is captured, not followed: the app must stay where it is until the
      // reader has seen the full URL and said yes.
      const appUrl = page.url();
      await page.locator("#heroTerminal a.md-link").click();
      await page.waitForSelector("#linkGuardHost .link-guard-overlay");
      assert(page.url() === appUrl, "clicking an authored link navigated the app");
      const dialog = await page.evaluate(() => {
        const overlay = document.querySelector("#linkGuardHost .link-guard-overlay");
        return {
          role: overlay?.getAttribute("role") ?? "",
          modal: overlay?.getAttribute("aria-modal") ?? "",
          url: overlay?.querySelector(".link-guard-url")?.textContent ?? "",
          warning: overlay?.querySelector(".link-guard-warning")?.textContent ?? "",
          focus: document.activeElement?.className ?? "",
        };
      });
      assert(dialog.role === "dialog" && dialog.modal === "true", "the link dialog is not a modal dialog");
      assert(
        dialog.url === "https://example.invalid/vault",
        `the dialog did not quote the full URL: "${dialog.url}"`,
      );
      assert(
        dialog.warning.includes("leaves Inkforge") && dialog.warning.includes("recognise the address"),
        `the dialog carried no warning: "${dialog.warning}"`,
      );
      assert(dialog.focus.includes("link-guard-cancel"), `Cancel did not take focus: "${dialog.focus}"`);

      await page.locator("#linkGuardHost .link-guard-cancel").click();
      assert(
        await page.locator("#linkGuardHost .link-guard-overlay").count() === 0,
        "Cancel did not close the dialog",
      );
      assert(page.url() === appUrl, "Cancel still navigated the app");

      await page.locator("#heroTerminal a.md-link").click();
      await page.waitForSelector("#linkGuardHost .link-guard-overlay");
      // Asserted on the request, not on the new tab's URL: the fixture points at
      // a reserved TLD that never resolves, so Chromium replaces the navigation
      // with its own error page and the tab's URL stops being the destination.
      // Both listeners are armed before the click — the request is already in
      // flight by the time the popup event arrives, so arming after would miss it.
      const openedPromise = context.waitForEvent("page", { timeout: 10_000 });
      const requestPromise = context.waitForEvent("request", {
        predicate: (request: Request) => request.url().startsWith("https://example.invalid/vault"),
        timeout: 10_000,
      });
      await page.locator("#linkGuardHost .link-guard-open").click();
      const [opened, request] = await Promise.all([openedPromise, requestPromise]);
      await opened.close();
      assert(
        request.url().startsWith("https://example.invalid/vault"),
        `confirming did not open the target: ${request.url()}`,
      );
      assert(page.url() === appUrl, "confirming navigated the app itself");
      assert(
        await page.locator("#linkGuardHost .link-guard-overlay").count() === 0,
        "the dialog stayed open after confirming",
      );
      return "inline and block markdown rendered, a one-line entry stayed prose, a '|' block entry became a " +
        "real list, a javascript: link stayed literal with no script run, and an https: link opened only after " +
        "the confirmation dialog quoted its full URL";
    });

    await runCheck("7. New project restores the starter", async () => {
      await page.locator("#loadBtn").click();
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
      await waitForEditorContains(page, "startLocation: entry");
      const code = await editorValue(page);
      assert(code.includes("startLocation: entry"), "the new project's editor does not contain startLocation: entry");
      await page.locator("#loadBtn").click();
      await page.waitForFunction(() => document.querySelectorAll("#projectList .project-card").length >= 2, undefined, {
        timeout: BOOT_TIMEOUT,
      });
      const activeCard = page.locator("#projectList .project-card").filter({ hasText: "Active" });
      assert(await activeCard.count() === 1, "project library did not mark exactly one active project");
      // The card describes the work, so its version and its description are the
      // scenario's own front matter — never `project.version`, which moves on
      // every pack. Both are read from the template the copy was made from, so a
      // package bump cannot move them and this check cannot go stale.
      const templateMeta = await readScenarioMeta({
        "scenario.yaml": await Deno.readTextFile(join(TEMPLATES, "lantern-below", "scenario.yaml")),
      });
      assert(templateMeta?.description && templateMeta.version, "template front matter has no description/version");
      const activeLine = (await activeCard.textContent()) ?? "";
      assert(
        activeLine.includes(templateMeta.description) && activeLine.includes(`v${templateMeta.version}`),
        `project card did not describe the work: ${activeLine}`,
      );
      assert(activeLine.includes("Updated"), `project card omitted updated time: ${activeLine}`);
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
        `editor has startLocation: entry); the library card described the work from its own front matter, deleted ` +
        `the active copy to the pinned starter, and restored it after reload`;
    });

    await runCheck("8. A Lua timer repaints a bound meter with no command", async () => {
      // The repaint model in one assertion: a mutation marks the view dirty and
      // the canvas frame hook flushes it. Nothing here issues a command, clicks a
      // control or crosses a UI action boundary, so the meter can only move if a
      // `GameState.set` made inside a Lua timer reached the DOM on its own.
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "timer-repaint-fixture", title: "Timer Repaint", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: Timer Repaint
startLocation: entry
state:
  charge: 9
  chargeMax: 9
player: {}
locations:
  entry:
    title: 'Timer Entry'
    text:
      - 'A cell hums.'
ui:
  elements:
    - id: charge_meter
      type: meter
      location: hud
      fields:
        - id: label
          type: text
          value: 'Charge'
        - id: value
          type: state
          path: charge
        - id: max
          type: state
          path: chargeMax
`),
          "scripts/main.lua": new TextEncoder().encode(`-- timer-repaint-fixture
function OnInit()
  timers.setInterval(function()
    GameState.set('charge', (GameState.get('charge') or 0) - 1)
  end, 120)
end
`),
        },
      };
      // A negative reading is still a reading: the regex is signed so a meter
      // that has already run past zero keeps comparing as "lower".
      const read = async () => {
        const text = await textOf(page, "#gameHud");
        return { text, value: Number(/(-?\d+)\s*\/\s*-?\d+/.exec(text)?.[1]) };
      };
      await page.locator("#closeProjects").click();
      await importPack(page, pack, "timer-repaint-fixture", "scripts/main.lua");
      await page.locator('.nav[data-view="play"]').click();
      await waitForText(page, "#gameHud", "Charge");
      const initial = await read();
      assert(Number.isFinite(initial.value), `meter value unreadable: "${initial.text}"`);
      await page.waitForFunction(
        (from: number) => {
          const text = document.querySelector("#gameHud")?.textContent ?? "";
          const value = Number(/(-?\d+)\s*\/\s*-?\d+/.exec(text)?.[1]);
          return Number.isFinite(value) && value < from;
        },
        initial.value,
        { timeout: BOOT_TIMEOUT },
      );
      const after = await read();

      // The other half of the model: a mutation costs one frame, not a spinning
      // loop. This fixture has no canvas scene and no animation, so every frame
      // counted below was caused by the timer's own dirty mark — ~8 over a
      // second at a 120ms interval. A DOM rebuild per animation frame would
      // count ~60.
      await page.evaluate(() => {
        const original = globalThis.requestAnimationFrame.bind(globalThis);
        const state = { frames: 0 };
        (globalThis as typeof globalThis & { __inkforgeFrames?: typeof state }).__inkforgeFrames = state;
        globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
          state.frames += 1;
          return original(callback);
        };
      });
      await page.waitForTimeout(1000);
      const frames = await page.evaluate(() =>
        (globalThis as typeof globalThis & { __inkforgeFrames: { frames: number } }).__inkforgeFrames.frames
      );
      assert(frames <= 15, `${frames} frames in 1s of a static scene with a 120ms timer`);
      return `a Lua timers.setInterval decremented a bound state var with no command or click: ` +
        `#gameHud "${short(initial.text, 30)}" -> "${short(after.text, 30)}"; ${frames} frames in the ` +
        `following second (one per mutation, not one per animation frame)`;
    });

    await runCheck("8a. Inventory item actions keep their invoking instance context", async () => {
      const invalidContextIssues = validateScenario({
        locations: {
          entry: {
            actions: [{
              id: "invalid_item_context",
              if: { itemVar: "lit" },
              then: { itemSet: { lit: true } },
            }],
          },
        },
      });
      assert(
        invalidContextIssues.some((issue) => issue.message.includes("'itemVar' requires")),
        "itemVar outside an inventory action passed validation",
      );
      assert(
        invalidContextIssues.some((issue) => issue.message.includes("'itemSet' requires")),
        "itemSet outside an inventory action passed validation",
      );
      const invalidActionIssues = validateScenario({
        definitions: {
          item: {
            lantern: {
              actions: [
                { label: "Broken", thne: [{ text: "Never runs" }] } as never,
                { id: "bad_set", then: { itemSet: "lit" } as never },
              ],
            },
          },
        },
      });
      assert(
        invalidActionIssues.some((issue) => issue.message === "unknown item action key 'thne'"),
        "misspelled item action key passed validation",
      );
      assert(
        invalidActionIssues.some((issue) => issue.message === "item action id must be a non-empty string"),
        "missing item action id passed validation",
      );
      assert(
        invalidActionIssues.some((issue) => issue.message === "itemSet must be a mapping"),
        "non-mapping itemSet passed validation",
      );
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "item-action-context-fixture", title: "Item Action Context", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: Item Action Context
startLocation: entry
state:
  inspectEnabled: true
  item.cellar_lantern.lit: false
  item.gate_lantern.lit: true
player:
  inventory: [cellar_lantern, gate_lantern]
definitions:
  item:
    lantern:
      name: Brass Lantern
      description: One definition, two concrete lanterns.
      inspect: The brass is scratched around the hinge.
      material: brass
      weight: 3.2
      usableAsWeapon: false
      actions:
        - id: inspect
          label: Inspect
          if:
            and:
              - { var: inspectEnabled }
              - { itemVar: inspected, neq: true }
          then:
            - if: { var: inspectEnabled }
              then:
                - call: item.inspect
                  params: { marker: called }
                - itemSet: { inspected: true }
                - emit: item:inspected
                  data: { marker: emitted }
        - id: light
          label: Light
          if: { itemVar: lit, neq: true }
          then:
            - if: { itemVar: lit, neq: true }
              then:
                - itemSet: { lit: true }
        - id: extinguish
          label: Extinguish
          if: { itemVar: lit, eq: true }
          then:
            - itemSet: { lit: false }
        - id: disable
          label: Disable inspections
          if: { var: inspectEnabled }
          then:
            - set: { inspectEnabled: false }
        - id: finish
          label: End run
          then:
            - call: item.finish
            - end: true
instances:
  item:
    cellar_lantern: { def: lantern }
    gate_lantern: { def: lantern }
locations:
  entry:
    title: Context Room
    text: Two lanterns share one definition.
ui:
  elements:
    - id: context_inventory
      type: button
      location: sidebar
      fields:
        - { id: label, type: text, value: Inventory }
      events:
        activate: { type: inventory.open, title: Inventory }
`),
          "scripts/main.lua": new TextEncoder().encode(`-- item-action-context-fixture
item = {}

function item.inspect(params, context)
  local inspectCalls = (GameState.get('inspectCalls') or 0) + 1
  GameState.set('inspectCalls', inspectCalls)
  GameOutput.add('inspect-call:' .. inspectCalls)
  local resolved = GameItems.get(context.item.id)
  local definition = GameItems.definition(context.item.definitionId)
  GameOutput.add('data:' .. resolved.id .. ':' .. resolved.def .. ':' .. resolved.definition.material .. ':' .. resolved.definition.inspect .. ':' .. definition.weight .. ':' .. tostring(definition.usableAsWeapon))
  resolved.definition.material = 'rust'
  GameOutput.add('fresh:' .. GameItems.get(context.item.id).definition.material)
  if GameItems.get('missing') == nil and GameItems.definition('missing') == nil then
    GameOutput.add('missing:nil')
  end
  GameOutput.add('call:' .. params.marker .. ':' .. context.item.id .. ':' .. context.item.definitionId .. ':' .. context.item.actionId)
  context.item.id = 'redirected_item'
  context.item.definitionId = 'redirected_definition'
  context.item.actionId = 'redirected_action'
end

function item.finish(params, context)
  local calls = (GameState.get('finishCalls') or 0) + 1
  GameState.set('finishCalls', calls)
  GameOutput.add('finish:' .. calls)
end

Events:On('item:inspected', function(data, context)
  GameOutput.add('emit:' .. data.marker .. ':' .. context.item.id .. ':' .. context.item.definitionId .. ':' .. context.item.actionId)
end)
`),
        },
      };
      await importPack(page, pack, "item-action-context-fixture", "scripts/main.lua");
      await page.locator('.nav[data-view="play"]').click();
      await page.locator('[data-ui="context_inventory"]').click();

      await page.locator('[data-slot="0"]').click();
      const inspectButton = await page.locator('[data-item-action="inspect"]').elementHandle();
      assert(inspectButton, "inspect action was not available");
      const disabledWhilePending = await inspectButton.evaluate((button) => {
        const actionButton = button as HTMLButtonElement;
        const handler = actionButton.onclick;
        handler?.call(actionButton, new PointerEvent("click"));
        handler?.call(actionButton, new PointerEvent("click"));
        return actionButton.disabled;
      });
      assert(disabledWhilePending, "inventory actions were not disabled while the first invocation was pending");
      await waitForText(page, "#terminal", "inspect-call:1");
      await waitForText(
        page,
        "#terminal",
        "data:cellar_lantern:lantern:brass:The brass is scratched around the hinge.:3.2:false",
      );
      await waitForText(page, "#terminal", "fresh:brass");
      await waitForText(page, "#terminal", "missing:nil");
      await waitForText(page, "#terminal", "call:called:cellar_lantern:lantern:inspect");
      await waitForText(page, "#terminal", "emit:emitted:cellar_lantern:lantern:inspect");
      assert(
        !(await page.locator("#terminal").textContent())?.includes("inspect-call:2"),
        "a second item action invocation ran while the first was pending",
      );
      assert(
        await page.locator('[data-item-action="inspect"]').count() === 0,
        "itemSet did not mark the invoking cellar lantern as inspected",
      );
      assert(
        await page.locator('[data-item-action="light"]').count() === 1,
        "unlit cellar lantern has no Light action",
      );
      assert(
        await page.locator('[data-item-action="extinguish"]').count() === 0,
        "unlit cellar lantern offered Extinguish",
      );
      await page.locator('[data-item-action="light"]').click();
      assert(await page.locator('[data-item-action="light"]').count() === 0, "itemSet did not light cellar lantern");
      assert(
        await page.locator('[data-item-action="extinguish"]').count() === 1,
        "lit cellar lantern did not refresh to Extinguish",
      );

      await page.locator('[data-slot="1"]').click();
      assert(await page.locator('[data-item-action="light"]').count() === 0, "lit gate lantern offered Light");
      assert(
        await page.locator('[data-item-action="extinguish"]').count() === 1,
        "lit gate lantern has no Extinguish action",
      );
      assert(
        await page.locator('[data-item-action="inspect"]').count() === 1,
        "cellar inspection state leaked into the gate lantern",
      );
      await page.locator('[data-item-action="inspect"]').click();
      await waitForText(page, "#terminal", "call:called:gate_lantern:lantern:inspect");
      await waitForText(page, "#terminal", "emit:emitted:gate_lantern:lantern:inspect");
      await page.locator('[data-item-action="extinguish"]').click();
      assert(await page.locator('[data-item-action="light"]').count() === 1, "itemSet did not extinguish gate lantern");
      assert(
        await page.locator('[data-item-action="extinguish"]').count() === 0,
        "extinguished gate lantern did not refresh to Light",
      );

      await page.locator('[data-item-action="disable"]').click();
      assert(
        await page.locator('[data-item-action="inspect"]').count() === 0,
        "conditioned item action remained after its state changed",
      );
      assert(
        await page.locator('[data-item-action="disable"]').count() === 0,
        "item action inspector did not refresh after execution",
      );
      const finishButton = await page.locator('[data-item-action="finish"]').elementHandle();
      assert(finishButton, "end action was not available before game over");
      await finishButton.click();
      await waitForText(page, "#terminal", "finish:1");
      assert(
        await page.locator("[data-item-action]").count() === 0,
        "inventory actions remained available after game over",
      );
      await finishButton.evaluate((button) => (button as HTMLButtonElement).click());
      assert(
        !(await page.locator("#terminal").textContent())?.includes("finish:2"),
        "a stale action ran after game over",
      );
      await page.locator("#closeInventory").click();
      return "two instances shared definition actions while itemVar/itemSet kept independent state; GameItems " +
        "resolved arbitrary definition metadata as detached copies; Lua could not redirect retained action context; " +
        "pending actions serialized; malformed payloads failed validation; game over removed and guarded actions";
    });

    await runCheck("8b. An NPC is authored data; an instance places it; its values are state", async () => {
      // The static half: every way an NPC can be authored wrong has to be loud.
      const npcIssues = validateScenario({
        npcs: {
          keeper: { portrait: "keeper.webp", state: ["trust"] as never },
          hollow: { name: 7 as never },
        },
        instances: { npc: { passage_keeper: { def: "keeper" }, stray: { def: "nobody" }, nameless: {} as never } },
        locations: { passage: { npcs: ["passage_keeper", "ghost"] } },
      });
      assert(
        npcIssues.some((issue) => issue.message.includes("npc portrait must be a project asset path")),
        "an npc portrait outside assets/ passed validation",
      );
      assert(
        npcIssues.some((issue) => issue.message === "npc state must be a mapping of value names to values"),
        "a non-mapping npc state passed validation",
      );
      assert(
        npcIssues.some((issue) => issue.message === "npc name must be a string"),
        "a non-string npc name passed validation",
      );
      assert(
        npcIssues.some((issue) => issue.message === "unknown npc definition 'nobody'"),
        "an npc instance pointing at no definition passed validation",
      );
      assert(
        npcIssues.some((issue) => issue.message === "npc instance must name a definition with 'def'"),
        "an npc instance with no def passed validation",
      );
      assert(
        npcIssues.some((issue) => issue.message === "unknown npc instance 'ghost'"),
        "a location listing an undeclared npc instance passed validation",
      );

      // `npcVar` names its own instance, so it needs no context — but the instance
      // has to exist, or the gate is silently never open.
      const subjectIssues = validateScenario({
        instances: { npc: { passage_keeper: { def: "keeper" } } },
        locations: {
          passage: {
            actions: [
              { id: "bad_subject", if: { npcVar: "tresh" } as never, then: [] },
              { id: "unresolvable", if: { npcVar: "ghost.trust", gte: 3 }, then: [] },
              { id: "valid", if: { npcVar: "passage_keeper.trust", gte: 3 }, then: [] },
            ],
          },
        },
      });
      assert(
        subjectIssues.some((issue) => issue.message.includes("npcVar must be '<npc-instance>.<value>'")),
        "an npcVar with no path passed validation",
      );
      assert(
        subjectIssues.some((issue) => issue.message === "npcVar names unknown NPC instance 'ghost'"),
        "an npcVar naming an undeclared instance passed validation",
      );
      assert(
        !subjectIssues.some((issue) => issue.path.includes("actions.2")),
        "a valid npcVar was reported as a problem",
      );

      // A misspelled `npcSet` key would write nothing at runtime, so it is caught
      // here rather than left to the directive's own error line.
      const setIssues = validateScenario({
        instances: { npc: { passage_keeper: { def: "keeper" } } },
        locations: {
          passage: {
            actions: [
              { id: "bad_key", then: { npcSet: { trust: 3 } } as never },
              { id: "bad_subject", then: { npcSet: { "ghost.trust": 3 } } },
              { id: "not_a_mapping", then: { npcSet: "trust" } as never },
            ],
          },
        },
      });
      assert(
        setIssues.some((issue) => issue.message === "key must be '<npc-instance>.<value>'"),
        "an unqualified npcSet key passed validation",
      );
      assert(
        setIssues.some((issue) => issue.message === "unknown NPC instance 'ghost'"),
        "an npcSet key naming an undeclared instance passed validation",
      );
      assert(
        setIssues.some((issue) => issue.message === "npcSet must be a mapping"),
        "a non-mapping npcSet passed validation",
      );

      // `npcVar` and `npcSet` are siblings, not alternatives: combining them is
      // the same mistake as combining `var` and `itemVar`.
      const combinedIssues = validateScenario({
        instances: { npc: { passage_keeper: { def: "keeper" } } },
        locations: {
          passage: { actions: [{ id: "two_subjects", if: { var: "a", npcVar: "passage_keeper.trust" }, then: [] }] },
        },
      });
      assert(
        combinedIssues.some((issue) => issue.message.includes("condition cannot combine")),
        "a condition combining var and npcVar passed validation",
      );

      // A UI element's `if` is evaluated on every render, and `actions` is read as
      // an alternative to `events`, so a validator that only walked top-level
      // `events` would skip a condition it could have reported.
      const uiIssues = validateScenario({
        instances: { npc: { passage_keeper: { def: "keeper" } } },
        ui: {
          elements: [
            { id: "ghosted", type: "button", location: "output", if: { npcVar: "ghost.trust", gte: 3 } },
            {
              id: "panel",
              type: "panel",
              elements: [
                { id: "nested", type: "text", location: "output", if: { npcVar: "ghost.trust" } },
              ],
              actions: { activate: { then: { npcSet: { "ghost.trust": 1 } } } },
            },
          ],
        },
      });
      assert(
        uiIssues.some((issue) =>
          issue.path === "ui.elements.0.if.npcVar" && issue.message.includes("unknown NPC instance 'ghost'")
        ),
        "a UI element's npcVar naming an undeclared instance passed validation",
      );
      assert(
        uiIssues.some((issue) => issue.path === "ui.elements.1.elements.0.if.npcVar"),
        "a nested UI element's condition was never validated",
      );
      assert(
        uiIssues.some((issue) =>
          issue.path === "ui.elements.1.actions.activate.then.0.npcSet.ghost.trust" &&
          issue.message === "unknown NPC instance 'ghost'"
        ),
        "a UI element's actions: directive list was never validated",
      );

      // The instance id is the left side of `<instance>.<value>`; a dot in it would
      // make the instance listable and seedable but unreachable by name.
      const dottedIssues = validateScenario({
        npcs: { keeper: {} },
        instances: { npc: { "court.keeper": { def: "keeper" } } },
      });
      assert(
        dottedIssues.some((issue) => issue.message.includes("must not contain '.'")),
        "an npc instance id containing a dot passed validation",
      );

      // The live half, against a self-contained fixture. The Keeper's `state:`
      // block seeds trust, so the gated action is closed until something raises
      // it. A location action dispatches, so each turn replaces the terminal —
      // the appending behaviour under test later belongs to conversations.
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "npc-fixture", title: "NPC Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: NPC Fixture
startLocation: hall
npcs:
  keeper:
    name: The Keeper
    description: A stooped figure who tends the lamps.
    # Shape is validated at load; whether the asset is present is the resolver's
    # report, so a scenario can ship the key before uploading the file.
    portrait: assets/portraits/keeper.svg
    role: lampkeeper
    lamps: 7
    state:
      trust: 2
      lampsLit: 0
instances:
  npc:
    passage_keeper:
      def: keeper
locations:
  hall:
    text: "A lamp burns low along the wall."
    npcs: [passage_keeper]
    actions:
      - id: ask
        label: Ask the keeper about the lamps
        then:
          - call: keeper.asked
          - npcSet: { passage_keeper.trust: 3 }
          - { inc: { var: npc.passage_keeper.lampsLit, by: 1 } }
      - id: which
        label: Ask which lamp is broken
        if:
          npcVar: passage_keeper.trust
          gte: 3
        then:
          - call: keeper.which
`),
          "scripts/main.lua": new TextEncoder().encode(`keeper = {}

function keeper.asked()
  local npc = GameNPCs.get("passage_keeper")
  if npc == nil then
    GameOutput.add("There is nobody here to ask.", "warning")
    return
  end
  GameOutput.add("The Keeper grunts. " .. npc.definition.lamps .. " still burn.")
  GameOutput.add("Trust is " .. tostring(GameState.get("npc.passage_keeper.trust")) .. ".")
end

function keeper.which()
  local npc = GameNPCs.get("passage_keeper")
  local lit = GameState.get("npc.passage_keeper.lampsLit") or 0
  GameOutput.add("You have lit " .. lit .. " of " .. npc.definition.lamps .. ".")
end
`),
        },
      };
      await importPack(page, pack, "passage_keeper", "scenario.yaml");
      await page.locator('.nav[data-view="play"]').click();
      await waitForText(page, "#terminal", "A lamp burns low");
      assert(
        !(await page.locator("#heroChoices").textContent())?.includes("broken"),
        "an npcVar-gated action was offered before its condition was met",
      );
      await page.locator("#heroChoices button", { hasText: "Ask the keeper about the lamps" }).click();
      // The handler reads trust before the action's npcSet raises it, so seeing
      // the seeded value here proves the default reached runtime state.
      await waitForText(page, "#terminal", "still burn");
      await waitForText(page, "#terminal", "Trust is 2");
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("broken"),
        "raising npc trust did not reveal the npcVar-gated action",
      );
      await page.locator("#heroChoices button", { hasText: "Ask which lamp is broken" }).click();
      await waitForText(page, "#terminal", "lit 1 of 7");
      return "an NPC definition carried portrait and state defaults; an instance placed it; a dotted id was refused; " +
        "a location listed the instance; trust seeded from state gated an action, npcSet raised it, inc reached the " +
        "same store, and GameNPCs read the authored half as a detached copy while GameState read the values; " +
        "npcVar and npcSet subjects were checked in UI element conditions, nested elements and actions: lists too";
    });

    await runCheck("8c. A conversation owns the choice list, the command box, and its own ending", async () => {
      // The static half: every way a conversation can be authored wrong.
      const bad = validateScenario({
        npcs: { keeper: {} },
        instances: { npc: { hall_keeper: { def: "keeper" } } },
        conversations: {
          broken: {
            start: "nowhere",
            participants: ["player", "ghost"],
            nodes: {
              here: {
                dialogue: [
                  { speaker: "nobody", text: "..." } as never,
                  { speker: "hall_keeper", text: "..." } as never,
                ],
                options: [
                  { id: "a", text: "A", next: "nowhere" } as never,
                  { id: "b", text: "B", talk: "missing" } as never,
                  { id: "c", text: "C", nxt: "here" } as never,
                ],
              },
            },
          },
        },
      });
      assert(
        bad.some((issue) => issue.message === "unknown node 'nowhere'" && issue.path.endsWith(".start")),
        "a conversation start naming no node passed validation",
      );
      assert(
        bad.some((issue) => issue.message.includes("unknown node 'nowhere'") && issue.path.includes("options.0.next")),
        "an option next naming no node passed validation",
      );
      assert(
        bad.some((issue) => issue.message === "unknown conversation 'missing'"),
        "an option talk naming no conversation passed validation",
      );
      assert(
        bad.some((issue) => issue.message.includes("unknown participant 'ghost'")),
        "a conversation naming an undeclared participant passed validation",
      );
      assert(
        bad.some((issue) => issue.message.includes("unknown speaker 'nobody'")),
        "a dialogue line with an unknown speaker passed validation",
      );
      assert(
        bad.some((issue) => issue.message === "unknown dialogue line key 'speker'"),
        "a misspelled dialogue line key passed validation",
      );
      assert(
        bad.some((issue) => issue.message === "unknown conversation option key 'nxt'"),
        "a misspelled conversation option key passed validation",
      );
      // An option is chosen by its id, so a repeated one makes two buttons that both
      // run the first option's directives.
      const duplicate = validateScenario({
        conversations: {
          dup: {
            start: "only",
            nodes: {
              only: {
                options: [
                  { id: "same", text: "One", then: { text: "one" } },
                  { id: "same", text: "Two", then: { text: "two" } },
                ],
              },
            },
          },
        },
      } as never);
      assert(
        duplicate.some((issue) => issue.message === "duplicate conversation option id 'same' in this node"),
        "two options sharing an id passed validation",
      );

      // A list authored as a mapping must be reported, not thrown on: iterating it
      // would replace a path-specific diagnostic with `forEach is not a function`.
      for (
        const [shape, issues] of [
          [
            "options",
            validateScenario({ conversations: { s: { start: "n", nodes: { n: { options: { a: 1 } } } } } } as never),
          ],
          [
            "dialogue",
            validateScenario({ conversations: { s: { start: "n", nodes: { n: { dialogue: { a: 1 } } } } } } as never),
          ],
          [
            "participants",
            validateScenario(
              { conversations: { s: { start: "n", participants: { a: 1 }, nodes: { n: {} } } } } as never,
            ),
          ],
          ["npcs", validateScenario({ locations: { l: { npcs: { a: 1 } } } } as never)],
        ] as [string, ReturnType<typeof validateScenario>][]
      ) {
        assert(
          issues.some((issue) => issue.message.endsWith("must be a list")),
          `a ${shape} list authored as a mapping was not reported as a list`,
        );
      }

      // A definition's `state:` is materialised once per instance, so a list or
      // mapping default shared by reference would let a write through one instance
      // reach another — and keep the authored definition's own object alive inside
      // mutable state, where `GameNPCs` would go on cloning it.
      const defaults = npcInstanceDefaults({
        npcs: { keeper: { state: { trust: 2, ledger: ["one"] } } },
        instances: { npc: { first: { def: "keeper" }, second: { def: "keeper" } } },
      } as never);
      const firstLedger = defaults["npc.first.ledger"] as string[];
      const secondLedger = defaults["npc.second.ledger"] as string[];
      assert(firstLedger !== secondLedger, "two instances of one definition share a single default object");
      firstLedger.push("mutated");
      assert(secondLedger.length === 1, "mutating one instance's default reached the other");
      assert(
        (defaults["npc.first.trust"] as number) === 2 && (defaults["npc.second.trust"] as number) === 2,
        "primitive defaults are still seeded per instance",
      );

      // A `call:` inside an option is a name that has to resolve at boot. Leaving
      // conversations out of the collector would make this the one authored place a
      // typo is never reported.
      const references = collectReferencedLuaNames({
        conversations: {
          hall_talk: {
            start: "opening",
            nodes: {
              opening: { options: [{ id: "a", text: "A", then: { call: "keeper.named" } }] },
            },
          },
        },
      } as never);
      assert(
        references.some((issue) => issue.message === "keeper.named" && issue.path.includes("conversations.hall_talk")),
        "a call: inside a conversation option was never collected for the boot check",
      );

      // Presence-driven: the opt-in, and the two ways it can be authored wrong.
      const presenceIssues = validateScenario({
        instances: { npc: { hall_keeper: { def: "keeper" } } },
        conversations: {
          no_npc: {
            discoverable: true,
            participants: ["player"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
          not_boolean: {
            discoverable: "yes" as never,
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
        },
      } as never);
      assert(
        presenceIssues.some((issue) => issue.message.includes("needs an npc instance in participants")),
        "a discoverable conversation with nobody to offer it from passed validation",
      );
      assert(
        presenceIssues.some((issue) => issue.message === "discoverable must be true or false"),
        "a non-boolean discoverable passed validation",
      );

      // Two ungated discoverable conversations for one NPC: `Talk to <npc>` cannot mean
      // two things, and the engine would take the first rather than report the second.
      const ambiguous = validateScenario({
        instances: { npc: { hall_keeper: { def: "keeper" } } },
        conversations: {
          first: {
            discoverable: true,
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
          second: {
            discoverable: true,
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
        },
      } as never);
      assert(
        ambiguous.some((issue) => issue.message.includes("cannot mean two things")),
        "two ungated discoverable conversations for one NPC passed validation",
      );

      // A gate is enough to make the overlap deliberate, so this must be allowed:
      // mutually exclusive conditions are how an author writes two conversations
      // with the same person.
      const gatedOverlap = validateScenario({
        instances: { npc: { hall_keeper: { def: "keeper" } } },
        conversations: {
          morning: {
            discoverable: true,
            if: { var: "morning", eq: true },
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
          evening: {
            discoverable: true,
            if: { var: "morning", eq: false },
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
        },
      } as never);
      assert(
        !gatedOverlap.some((issue) => issue.message.includes("cannot mean two things")),
        "two gated discoverable conversations for one NPC were rejected; that is the supported way to write them",
      );

      // A gate is not proof of exclusivity. Two conversations whose conditions can both
      // hold — `morning` and `questActive` are the obvious pair — are still two things
      // one `Talk to …` button cannot mean, so the engine takes the first and says so.
      // The alternative, refusing every gated pair, would take away the ordinary way to
      // write two conversations with one person.
      const overlapLines: string[] = [];
      const overlapScenario = {
        locations: { hall: { npcs: ["hall_keeper"] } },
        conversations: {
          morning_talk: {
            discoverable: true,
            if: { var: "gateOpen", eq: true },
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
          evening_talk: {
            discoverable: true,
            if: { var: "morning", eq: true },
            participants: ["player", "hall_keeper"],
            start: "n",
            nodes: { n: { options: [{ id: "a", text: "A" }] } },
          },
        },
      } as never;
      const collect = (text: unknown, kind?: string): void => {
        overlapLines.push(`${kind}:${text}`);
      };
      const overlapRuntime = engineRuntimeFixture("hall");
      // Both gates true at once — the whole point. An author who wrote these two
      // expecting them to be exclusive has not, and only the engine can see it.
      overlapRuntime.state = { gateOpen: true, morning: true };
      const overlapFirst = discoverableTalks(overlapRuntime, overlapScenario, "hall", collect);
      assert(
        overlapFirst.length === 1 && overlapFirst[0].conversationId === "morning_talk",
        "two simultaneously-live discoverable conversations did not resolve to the first in authored order",
      );
      assert(
        overlapLines.some((line) =>
          line.startsWith("warning:") && line.includes("morning_talk") && line.includes("evening_talk")
        ),
        "two simultaneously-live discoverable conversations were resolved in silence, so the author never learns why the second is unreachable",
      );
      // Once per pair, not once per repaint: `available()` runs on every paint, and a
      // warning that repeated would flood the terminal the moment the author looked.
      discoverableTalks(overlapRuntime, overlapScenario, "hall", collect);
      assert(
        overlapLines.length === 1,
        "the overlapping-gates warning repeated on the next repaint instead of being reported once",
      );

      // A location action is dispatched as `@<its id>`, so an id that happens to begin
      // `talk:` collides with any conversation dispatch keyed the same way. The offer is
      // now a payload on the choice rather than a smuggled command string, so the action
      // can keep any id at all.
      const collidingIssues = validateScenario({
        instances: { npc: { hall_keeper: { def: "keeper" } } },
        locations: { hall: { actions: [{ id: "talk:bell", label: "Ring", then: ["A bell."] }] } },
      } as never);
      assert(
        !collidingIssues.some((issue) => issue.path.includes("actions")),
        `a location action may not be authored as 'talk:bell': ${
          collidingIssues.filter((i) => i.path.includes("actions")).map((i) => i.message).join("; ")
        }`,
      );

      // `npcs: { keeper: }` is null in YAML, and it is a normal half-written state. The
      // validator has to survive it: reading a field off it throws, which would abort
      // every other check and surface at boot as a raw exception instead of the one
      // issue that would have told the author what to finish writing.
      const nullNpc = validateScenario({ npcs: { keeper: null, broken: [] } } as never);
      assert(
        nullNpc.some((issue) => issue.path === "npcs.keeper" && issue.message.includes("mapping")),
        "a null npc definition was not reported as a mapping",
      );
      assert(
        nullNpc.some((issue) => issue.path === "npcs.broken"),
        "a non-mapping npc definition was not reported",
      );

      // A modal's elements are authored content with the same `if` and bindings as
      // screen elements, and `renderModals` evaluates both. Walking only `ui.elements`
      // left a whole surface unchecked: a modal element gated on an npcVar naming an
      // NPC that does not exist booted cleanly and then simply never appeared.
      const modalIssues = validateScenario({
        modals: [
          {
            id: "notes",
            elements: [
              {
                id: "trust_row",
                type: "text",
                if: { npcVar: "ghost.trust" },
                fields: [{ id: "t", type: "text", value: "—" }],
              },
              {
                id: "press",
                type: "button",
                events: { activate: { callback: "notes.press" } },
              },
            ],
          },
        ],
      } as never);
      assert(
        modalIssues.some((issue) => issue.path.startsWith("modals.0.elements.0") && issue.message.includes("ghost")),
        "an unknown npc in a modal element condition was not reported at load",
      );
      const modalRefs = collectReferencedLuaNames({
        modals: [
          {
            id: "notes",
            elements: [
              { id: "press", type: "button", events: { activate: { callback: "notes.press" } } },
            ],
          },
        ],
      } as never);
      assert(
        modalRefs.some((issue) => issue.message === "notes.press" && issue.path.includes("modals.0")),
        "a Lua callback bound inside a modal was never collected for the boot check",
      );

      // A conversation is ended by moving away, but not by entering the room you are
      // already in — and boot's own `move` to the starting location is exactly that, so
      // clearing unconditionally meant a `GameConversations.start()` in OnInit was wiped
      // by the next line of boot.
      const moveRuntime = engineRuntimeFixture("hall");
      moveRuntime.conversation = { id: "keeper_greeting", nodeId: "opening" };
      setLocation(moveRuntime, "hall");
      assert(
        moveRuntime.conversation?.id === "keeper_greeting",
        "entering the location you are already in ended a conversation, which is what boot does to every OnInit start",
      );
      setLocation(moveRuntime, "cellar");
      assert(
        moveRuntime.conversation === null,
        "moving to a different location did not end the conversation, so a player could not walk out of one",
      );

      // Ending the run ends the conversation holding it. `available()` reads the
      // conversation before it reads `over`, so a conversation left set by `end: true`
      // kept rendering its remaining options as live buttons on a screen the player has
      // been told is over: they look answerable, accept a click, and do nothing.
      const overRuntime = engineRuntimeFixture("hall");
      overRuntime.conversation = { id: "keeper_greeting", nodeId: "opening" };
      endRun(overRuntime);
      assert(
        overRuntime.conversation === null,
        "ending the run left the conversation in place, so its options stayed on screen as buttons that do nothing",
      );
      assert(overRuntime.over, "endRun did not end the run");

      // A paint that settles a conversation must not leave a repaint behind it. The flag
      // is cleared before the paint so a repaint from inside one is not re-entrant, and
      // consuming what the paint raises is what makes "one command repaints once" true
      // on this path too.
      const flushRuntime = engineRuntimeFixture("hall");
      let paints = 0;
      flushRuntime.viewDirty = true;
      flushView(flushRuntime, () => {
        paints += 1;
        // Only the first paint settles; a second one would mean the loop cannot settle.
        if (paints === 1) markViewDirty(flushRuntime);
      });
      assert(paints === 2, `a paint that marked the view dirty was followed by ${paints} paints, expected 2`);
      assert(
        !flushRuntime.viewDirty,
        "a repaint was left scheduled after the paint that caused it, rebuilding a DOM that already showed the result",
      );

      // `and` and `or` are recursed into by index, so `and: true` has no `.forEach` and
      // reading it unguarded threw out of the entire validation — the one thing that
      // turns a typo into a boot crash rather than a line in the diagnostics list.
      for (const key of ["and", "or"]) {
        const malformed = validateScenario({
          locations: { hall: { actions: [{ id: "a", label: "A", if: { [key]: true } }] } },
        } as never);
        assert(
          malformed.some((issue) =>
            issue.path === `locations.hall.actions.0.if.${key}` && issue.message.includes("list of conditions")
          ),
          `a malformed '${key}' condition was not reported against its own path`,
        );
      }
      // `not` recurses through the same guard, so a scalar there is already caught by
      // the object check rather than by the new list check. Worth pinning: the two
      // recursion sites have to agree, and only one of them needed a new branch.
      const badNot = validateScenario({
        locations: { hall: { actions: [{ id: "a", label: "A", if: { not: "nope" } }] } },
      } as never);
      assert(
        badNot.some((issue) =>
          issue.path === "locations.hall.actions.0.if.not" && issue.message.includes("must be an object")
        ),
        "a scalar 'not' was not reported against its own path",
      );

      // The live half, against a self-contained fixture.
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "conversation-fixture", title: "Conversation Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: Conversation Fixture
startLocation: hall
state:
  gateOpen: true
npcs:
  keeper:
    name: The Keeper
    state:
      trust: 2
instances:
  npc:
    hall_keeper:
      def: keeper
  item:
    satchel_bag:
      def: satchel
locations:
  hall:
    text: "A lamp burns low along the wall."
    npcs: [hall_keeper]
    items: [satchel_bag]
    actions:
      - id: greet
        label: Greet the keeper
        then:
          - talk: hall_talk
      - id: look_around
        label: Look around
        then:
          - "Dust, and a guttering lamp."
      - id: talk_gated
        label: Talk about the gate
        then:
          - talk: gated_talk
      - id: farewell
        label: Say goodbye
        then:
          - talk: farewell_talk
      - id: "talk:bell"
        label: Ring the bell
        then:
          - "The bell answers once, somewhere below."
ui:
  elements:
    - id: open_pack
      type: button
      location: sidebar
      fields:
        - { id: label, type: text, value: Inventory }
      events:
        activate: { type: inventory.open, title: Inventory }
    - id: look_around_again
      type: button
      location: output
      allowInConversation: false
      fields:
        - { id: label, type: text, value: "Look around again" }
      events:
        activate: { type: command, command: look }
    - id: shut_gate
      type: button
      location: output
      fields:
        - { id: label, type: text, value: "Shut the gate" }
      events:
        activate: { type: instructions, then: [{ set: { gateOpen: false } }] }
    - id: start_from_lua
      type: button
      location: output
      fields:
        - { id: label, type: text, value: "Start from Lua" }
      events:
        activate: { callback: "start_from_lua" }
    - id: finish_from_lua
      type: button
      location: output
      fields:
        - { id: label, type: text, value: "Finish from Lua" }
      events:
        activate: { callback: "finish_from_lua" }
    - id: show_notebook
      type: button
      location: output
      fields:
        - { id: label, type: text, value: "Fetch the notebook" }
      events:
        activate: { callback: "show_notebook_again" }
    - id: show_rifle
      type: button
      location: output
      fields:
        - { id: label, type: text, value: "Feel for the false bottom" }
      events:
        activate: { callback: "show_rifle_again" }
conversations:
  ambient_talk:
    discoverable: true
    participants: [player, hall_keeper]
    start: only
    nodes:
      only:
        dialogue:
          - speaker: hall_keeper
            text: "The Keeper looks up. Ambient line."
        options:
          - id: nod
            text: "Nod."
  gated_talk:
    start: only
    nodes:
      only:
        dialogue:
          - speaker: hall_keeper
            text: "Ask while the lamp burns."
        options:
          - id: ask_now
            text: "What do you know?"
            if: { var: gateOpen, neq: false }
            then:
              - "Nothing you did not already know."
  farewell_talk:
    participants: [player, hall_keeper]
    start: only
    nodes:
      only:
        dialogue:
          - speaker: hall_keeper
            text: "Then go, and mind the third lamp."
        options:
          - id: go
            text: Goodnight.
            then:
              - end: true
          - id: not_yet
            text: Not yet.
  hall_talk:
    participants: [player, hall_keeper]
    start: opening
    nodes:
      opening:
        dialogue:
          - speaker: hall_keeper
            text: "You came down."
        options:
          - id: ask_name
            text: "What is your name?"
            then:
              - call: keeper.named
            next: named
          - id: walk_away
            text: "Walk away."
      named:
        dialogue:
          - speaker: hall_keeper
            text: "A name is a thing you are given."
        options:
          - id: press
            text: "Then give me one."
            then:
              - npcSet: { hall_keeper.trust: 4 }
            next: warm
          - id: ask_again
            text: "Start over."
            then:
              - talk: hall_talk
            next: warm
      warm:
        dialogue:
          - speaker: hall_keeper
            if: { npcVar: hall_keeper.trust, gte: 4 }
            text: "Rowan. It is Rowan."
definitions:
  item:
    satchel:
      name: Satchel
      description: "A worn bag with a false bottom."
      actions:
        - id: rifle
          label: "Check the false bottom"
          allowInConversation: false
          then:
            - "Something heavy, wrapped in oilcloth."
        - id: tally
          label: "Count the nails"
          then:
            - "Eleven. You were sure it was twelve."
tools:
  - id: notebook
    label: Notebook
    allowInConversation: false
    action: open_notebook
  - id: compass
    label: Compass
    action: open_compass
`),
          "scripts/main.lua": new TextEncoder().encode(`keeper = {}

function keeper.named(params, context)
  local trust = GameState.get("npc.hall_keeper.trust") or 0
  GameOutput.add("The Keeper does not look up. Trust is " .. tostring(trust) .. ".")
  if context and context.conversation then
    GameOutput.add("[talking: " .. context.conversation.id .. "/" .. context.conversation.nodeId .. "]")
  end
end

function start_from_lua()
  GameConversations.start("ambient_talk")
end

function finish_from_lua()
  GameConversations.finish()
end

function open_notebook()
  GameOutput.add("The notebook is open. Nothing to be done about that here.")
end

function open_compass()
  GameOutput.add("The needle settles on the passage behind you.")
end

-- A conversation hid these through the same state a script addresses, so a script can
-- put them back for the exchange that needs them. Nothing here is conversation-aware:
-- the flag only ever touched a hidden set, which is why \`show\` can undo it.
function show_notebook_again()
  GameTools.show("notebook")
  GameOutput.add("You dig the notebook back out.")
end

function show_rifle_again()
  GameItemActions.show("satchel.rifle")
  GameOutput.add("You take the false bottom in your hands.")
end
`),
        },
      };
      await importPack(page, pack, "hall_talk", "scenario.yaml");
      await page.locator('.nav[data-view="play"]').click();
      await waitForText(page, "#terminal", "A lamp burns low");
      assert(
        await page.locator("#heroCommand").isVisible(),
        "the command box was hidden before any conversation ran",
      );

      // The satchel is here for the item-action surface, which is the third player-facing
      // place a trigger can come from. Taken now rather than later so its "Take" choice
      // is gone before any assertion reads the room's list.
      await page.locator("#heroChoices button", { hasText: "Take Satchel" }).click();
      await waitForText(page, "#terminal", "Taken: Satchel.");

      // Presence-driven: the offer exists because the NPC is in the room, with no
      // action written to start it, and its label is built from the NPC's name.
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("Talk to The Keeper"),
        "a discoverable conversation was not offered for the NPC standing in the room",
      );
      assert(
        (await page.locator("#heroChoices button", { hasText: "Talk to" }).count()) === 1,
        "more than one talk choice was offered for a single NPC",
      );

      // A location action is dispatched as `@<its id>`, so an action authored as
      // `id: "talk:bell"` used to produce `@talk:bell` and be intercepted as a request
      // to start a conversation called `bell` — its own directives could never run, and
      // nothing rejected the id. The offer is a payload on the choice now, so the two
      // namespaces cannot meet.
      await page.locator("#heroChoices button", { hasText: "Ring the bell" }).click();
      await waitForText(page, "#terminal", "The bell answers once");
      assert(
        await page.locator("#heroCommand").isVisible(),
        "a location action whose id begins 'talk:' was taken for a conversation, so its own directives never ran",
      );
      // And the offer still works afterwards, from a transcript the room description
      // shares rather than one it replaced.
      await page.locator("#heroChoices button", { hasText: "Talk to The Keeper" }).click();
      await waitForText(page, "#terminal", "Ambient line.");
      // Walking away from it is a terminal node, so the room comes back.
      await page.locator("#heroChoices button", { hasText: "Nod." }).click();
      await waitForText(page, "#choices", "Greet the keeper");

      // The same conversation started from Lua through a UI callback. Proves the
      // namespace reaches the same state machine a `talk:` does rather than a
      // parallel one that could drift from it.
      await page.locator('[data-ui="start_from_lua"]').click();
      await waitForText(page, "#terminal", "Ambient line.");
      assert(
        !(await page.locator("#heroCommand").isVisible()),
        "a conversation started from Lua did not take the command boxes",
      );
      // And finished from Lua mid-exchange, which is the case a script needs and no
      // `talk:` can express: the player is mid-conversation and something else
      // decides they are not any more. The method is `finish` rather than `end`
      // because `end` is a Lua keyword and `GameConversations.end()` would not
      // parse — so calling it here is also the check that the name is usable.
      await page.locator('[data-ui="finish_from_lua"]').click();
      await waitForText(page, "#choices", "Greet the keeper");
      assert(
        await page.locator("#heroCommand").isVisible(),
        "GameConversations.finish() did not hand the player back to the room",
      );

      await page.locator("#heroChoices button", { hasText: "Greet the keeper" }).click();
      await waitForText(page, "#terminal", "The Keeper: You came down.");
      // The conversation owns the choice list and the command box while it runs.
      assert(
        !(await page.locator("#heroChoices").textContent())?.includes("Look around"),
        "a location action was offered beside the conversation's options",
      );
      assert(
        !(await page.locator("#heroCommand").isVisible()),
        "the command box stayed visible during a conversation",
      );
      assert(
        !(await page.locator("#commandForm").isVisible()),
        "the author run panel's command box stayed visible during a conversation",
      );
      // `allowInConversation: false` withdraws a surface for the duration. It is the
      // author's call, not a guess from the activation type: an earlier attempt inferred
      // "hide the ones that dispatch a command", which is a different question, and that
      // kept a perfectly live `callback` button on screen that had no business there.
      // The three surfaces a player can click are each checked below, because getting
      // only one of them right is how the last attempt shipped.
      assert(
        (await page.locator('#uiOutput [data-ui="look_around_again"]').count()) === 0,
        "a UI element marked allowInConversation: false stayed on screen during a conversation",
      );
      // Absent means shown, so nothing opts in and an existing project is unaffected.
      // `finish_from_lua` is the load-bearing case: it is how a conversation gets ended
      // from outside it, and an author must not have to special-case their way to it.
      assert(
        (await page.locator('#uiOutput [data-ui="finish_from_lua"]').count()) === 1,
        "a UI element with no allowInConversation key was hidden during a conversation",
      );
      // A tool, which is a separate surface with its own rail and was not covered at all
      // by the first attempt.
      assert(
        (await page.locator('#toolRail [data-tool="notebook"]').count()) === 0,
        "a tool marked allowInConversation: false stayed in the rail during a conversation",
      );
      assert(
        (await page.locator('#toolRail [data-tool="compass"]').count()) === 1,
        "a tool with no allowInConversation key was hidden during a conversation",
      );
      // The point of hiding through each surface's own state rather than through a render
      // filter: the rest of the engine can see it and undo it. `GameTools.show` clears the
      // same flag the conversation set, so a script can bring one back for the exchange
      // that needs it. A filter would have made this impossible without a second concept
      // of "shown", which is what the first attempt built.
      await page.locator('#uiOutput [data-ui="show_notebook"]').click();
      await waitForText(page, "#terminal", "You dig the notebook back out");
      assert(
        (await page.locator('#toolRail [data-tool="notebook"]').count()) === 1,
        "a script could not bring a withdrawn tool back for the conversation that wants it",
      );
      // And the inventory, a third surface with a state of its own, reached through the
      // inspector rather than the rail.
      await page.locator('[data-ui="open_pack"]').click();
      await page.locator('[data-slot="0"]').click();
      assert(
        (await page.locator('[data-item-action="rifle"]').count()) === 0,
        "an item action marked allowInConversation: false was still offered during a conversation",
      );
      assert(
        (await page.locator('[data-item-action="tally"]').count()) === 1,
        "an item action with no allowInConversation key was hidden during a conversation",
      );
      // The same override for the third surface, through the class added for it. The
      // trigger has to be clicked with the overlay closed — it lives in the output strip
      // behind it — so the sequence is close, trigger, reopen, check.
      await page.locator("#closeInventory").click();
      await page.locator('[data-ui="show_rifle"]').click();
      await waitForText(page, "#terminal", "You take the false bottom");
      await page.locator('[data-ui="open_pack"]').click();
      await page.locator('[data-slot="0"]').click();
      assert(
        (await page.locator('[data-item-action="rifle"]').count()) === 1,
        "a script could not bring a withdrawn item action back mid-conversation",
      );
      await page.locator("#closeInventory").click();
      await page.locator("#heroChoices button", { hasText: "What is your name?" }).click();
      await waitForText(page, "#terminal", "[talking: hall_talk/opening]");
      await waitForText(page, "#terminal", "A name is a thing you are given.");
      // The exchange is a transcript, not a log held by the engine: taking an option
      // appends, so the opening beat is still on screen with the new one.
      const afterOption = (await page.locator("#terminal").textContent()) || "";
      assert(
        afterOption.includes("You came down.") && afterOption.includes("A name is a thing you are given."),
        "taking a conversation option replaced the transcript instead of appending to it",
      );

      // A `talk:` inside `then` targeting the conversation already running replaces
      // the state with a *new* object carrying the same id, so a guard comparing ids
      // alone reads the cut as "nothing changed" and then applies this option's own
      // `next` on top of the exchange it just restarted.
      await page.locator("#heroChoices button", { hasText: "Start over." }).click();
      await waitForText(page, "#terminal", "The Keeper: You came down.");
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("What is your name?"),
        "a talk: inside an option's then was overwritten by that option's own next",
      );

      // Back at the opening node, so walk forward again to reach the terminal one.
      await page.locator("#heroChoices button", { hasText: "What is your name?" }).click();
      await waitForText(page, "#terminal", "A name is a thing you are given.");
      await page.locator("#heroChoices button", { hasText: "Then give me one." }).click();
      await waitForText(page, "#terminal", "Rowan. It is Rowan.");

      // `warm` declares no options, so it is a terminal beat: the conversation ends
      // rather than stranding the player on a node with nothing to answer.
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("Look around"),
        "a terminal node did not return the player to the room",
      );
      assert(
        await page.locator("#heroCommand").isVisible(),
        "the command box did not come back after the conversation ended",
      );
      // Every withdrawn surface comes back with the room, not just the inline one.
      // Asserted rather than trusted, because the failure mode of a fix like this is not
      // "they stay hidden" but "they never come back" — quieter, and permanent.
      assert(
        (await page.locator('#uiOutput [data-ui="look_around_again"]').count()) === 1,
        "a withdrawn UI element did not come back after the conversation ended",
      );
      assert(
        (await page.locator('#toolRail [data-tool="notebook"]').count()) === 1,
        "a withdrawn tool did not come back after the conversation ended",
      );
      await page.locator('[data-ui="open_pack"]').click();
      await page.locator('[data-slot="0"]').click();
      assert(
        (await page.locator('[data-item-action="rifle"]').count()) === 1,
        "a withdrawn item action did not come back after the conversation ended",
      );
      await page.locator("#closeInventory").click();

      // Gates closing *mid-exchange*, with no node change at all. Every option on
      // this node is gated on a state key, and a UI control sets it — so settling on
      // node entry never runs, and without a settle on availability the choice list
      // would empty while both command boxes stayed hidden.
      await page.locator("#heroChoices button", { hasText: "Talk about the gate" }).click();
      await waitForText(page, "#terminal", "Ask while the lamp burns.");
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("What do you know?"),
        "the gated conversation did not offer its option while the gate was open",
      );
      await page.locator('[data-ui="shut_gate"]').click();
      // Wait on the room coming back rather than on a timer, then assert both halves
      // of the state: the conversation ended, and the command box came with it.
      await waitForText(page, "#choices", "Look around");
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("Look around"),
        "a conversation whose every gate closed mid-exchange stayed active and emptied the choice list",
      );
      assert(
        await page.locator("#heroCommand").isVisible(),
        "a conversation whose every gate closed mid-exchange left the command boxes hidden",
      );

      // The last thing 8c does, because it ends the run: an option whose `then` ends
      // the game has to take the conversation down with it. `available()` reads the
      // conversation before it reads `over`, so a conversation left set by `end: true`
      // went on rendering its *other* options as live buttons on a finished screen.
      await page.locator("#heroChoices button", { hasText: "Say goodbye" }).click();
      await waitForText(page, "#terminal", "mind the third lamp");
      assert(
        (await page.locator("#heroChoices").textContent())?.includes("Goodnight."),
        "the farewell conversation did not offer its options",
      );
      await page.locator("#heroChoices button", { hasText: "Goodnight." }).click();
      assert(
        !(await page.locator("#heroChoices").textContent())?.includes("Not yet."),
        "an option that ended the run left the conversation's other options on screen as buttons that do nothing",
      );
      assert(
        await page.locator("#heroCommand").isVisible(),
        "an option that ended the run left the command boxes hidden, as if a conversation were still running",
      );
      // And the surfaces that conversation had withdrawn come back here too. `endRun`
      // sets `conversation` directly rather than going through `endConversation`, so
      // nothing else would hand them back — and a run that ended mid-exchange with the
      // rail permanently emptied is the kind of thing nobody notices until they reload.
      assert(
        (await page.locator('#uiOutput [data-ui="look_around_again"]').count()) === 1,
        "ending the run mid-conversation left a UI element withdrawn with nothing left to restore it",
      );
      assert(
        (await page.locator('#toolRail [data-tool="notebook"]').count()) === 1,
        "ending the run mid-conversation left a tool withdrawn with nothing left to restore it",
      );
      return "a talk: directive entered the start node; options replaced the location's choices and both command " +
        "boxes hid; a dotted call: inside an option received its conversation context; taking options appended to " +
        "the transcript; a talk: inside an option's then beat that option's own next; npcSet raised trust and " +
        "opened a gated line; a node with no options ended the exchange and restored the room; a gate closing " +
        "mid-exchange also ended it; a discoverable conversation was offered from the NPC's presence alone, once, " +
        "labelled from its name; GameConversations.start and .finish drove that same machine from Lua; bad " +
        "start/next/talk/speaker/participant/keys and duplicate option ids were " +
        "rejected at load; a list authored as a mapping was reported rather than thrown on; two ungated " +
        "discoverable conversations for one NPC were rejected while gated ones were allowed; and NPC defaults are " +
        "cloned per instance";
    });

    await runCheck("9. Save, restart, and resume a per-scenario slot", async () => {
      // The whole persistence contract in one pass: a save is keyed to its own
      // project, survives a genuine restart, is never picked up automatically,
      // and — the part a fresh boot gets wrong on its own — is not clobbered by
      // the entry script's own `GameState.set` on the way back in.
      const pack: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "save-fixture", title: "Save Fixture", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: Save Fixture
startLocation: gate
state:
  visits: 0
player:
  inventory:
    - coin
locations:
  gate:
    title: 'Iron Gate'
    text:
      - 'A gate bars the way north.'
    exits:
      north: 'vault'
  vault:
    title: 'Cold Vault'
    text:
      - 'The vault smells of iron and old rain.'
      - give: vault_relic
    exits:
      south: 'gate'
ui:
  elements:
    - id: save_consume
      type: button
      location: output
      fields:
        - id: label
          type: text
          value: 'Consume relic'
      events:
        activate:
          type: instructions
          then:
            - remove: vault_relic
`),
          // The clobber this has to survive: a top-level write on every boot,
          // which a seeded-but-not-re-applied restore would leave at 2.
          "scripts/main.lua": new TextEncoder().encode(`-- save-fixture
function OnInit()
  GameState.set('visits', (GameState.get('visits') or 0) + 1)
  GameTools.register({id='saved_hidden', label='Hidden'})
  GameTools.register({id='saved_disabled', label='Disabled'})
  GameTools.register({id='saved_removed', label='Removed'})
  GameUI.create({id='save_mutate', type='button', location='output', fields={{id='label', type='text', value='Change save state'}}, events={activate={callback='changeSaveState'}}})
  GameUI.create({id='saved_removed_panel', type='button', location='output', fields={{id='label', type='text', value='Removable panel'}}})
end
function changeSaveState()
  GameTools.hide('saved_hidden')
  GameTools.disable('saved_disabled')
  GameTools.remove('saved_removed')
  GameUI.remove('saved_removed_panel')
end
`),
        },
      };
      await importPack(page, pack, "startLocation: gate", "scenario.yaml");

      const headerActions = await page.locator(".app > header .actions button").allTextContents();
      assert(
        headerActions.map((label) => label.trim()).join(",") === "Save,Restart,Manage Saves,Scenarios",
        `unexpected header actions: ${headerActions.join(",")}`,
      );
      await page.locator("#savesBtn").click();
      await waitForText(page, "#saveOverlay", "No saves yet");
      assert(await page.locator("#importSaveBtn").isVisible(), "Import save is missing from Manage Saves");
      await page.locator("#closeSaves").click();

      await waitForText(page, "#heroChoices", "North");
      await page.locator("#heroChoices button", { hasText: "North" }).first().click();
      await waitForTextEquals(page, "#storyTitle", "Cold Vault");
      await waitForText(page, "#heroTerminal", "The vault smells of iron and old rain.");
      // The vault grants a relic on entry, so a save made after spending it is
      // the one case where boot behaviour and the snapshot disagree. The spend
      // is a UI activation rather than a typed command so the turn boundary does
      // not clear the transcript out from under the save.
      await waitForTextEquals(page, "#inventoryCount", "2 / 12");
      await page.locator('[data-ui="save_mutate"]').click();
      assert(await page.locator('[data-tool="saved_hidden"]').count() === 0, "hidden tool remained visible");
      assert(await page.locator('[data-tool="saved_disabled"]').isDisabled(), "tool did not disable");
      assert(await page.locator('[data-tool="saved_removed"]').count() === 0, "removed tool remained visible");
      assert(await page.locator('[data-ui="saved_removed_panel"]').count() === 0, "removed panel remained visible");
      await page.locator('[data-ui="save_consume"]').click();
      await waitForTextEquals(page, "#inventoryCount", "1 / 12");

      await page.locator("#saveBtn").click();
      await waitForText(page, "#diagnostics", "Saved");
      await page.locator("#savesBtn").click();
      await waitForText(page, "#saveOverlay", "Save Fixture");
      assert(
        await page.locator("#saveList button", { hasText: "Resume" }).count() === 1,
        "saved run has no Resume action",
      );
      await page.locator("#closeSaves").click();

      const readSave = async (): Promise<
        { location: string; snapshot: { state: Record<string, number>; inventory?: string[] } } | undefined
      > =>
        await page.evaluate(async (projectId: string) => {
          const request = indexedDB.open("inkforge-project-library");
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const found = await new Promise<unknown>((resolve, reject) => {
            const get = db.transaction("saves", "readonly").objectStore("saves").get([projectId, "manual"]);
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          });
          db.close();
          return found ?? undefined;
        }, pack.manifest.project.id) as
          | { location: string; snapshot: { state: Record<string, number>; inventory?: string[] } }
          | undefined;

      const stored = await readSave();
      assert(stored, "no save record was written to the saves store");
      assert(stored.location === "vault", `save recorded location "${stored.location}", expected vault`);
      assert(stored.snapshot.state.visits === 1, `save recorded visits=${stored.snapshot.state.visits}, expected 1`);
      assert(
        stored.snapshot.inventory?.join() === "coin",
        `save recorded inventory [${stored.snapshot.inventory?.join() ?? ""}], expected [coin]`,
      );

      // A restart is a genuine reset, so the save must be untouched by it and
      // must not be applied on its own.
      await page.locator("#restartHero").click();
      await waitForTextEquals(page, "#storyTitle", "Iron Gate");
      const afterRestart = await readSave();
      assert(afterRestart?.location === "vault", "restarting the run overwrote the save");

      await page.locator("#savesBtn").click();
      await page.locator("#saveList button", { hasText: "Resume" }).click();
      await waitForTextEquals(page, "#storyTitle", "Cold Vault");
      await waitForText(page, "#heroTerminal", "The vault smells of iron and old rain.");
      assert(await page.locator('[data-tool="saved_hidden"]').count() === 0, "resume restored a hidden Lua tool");
      assert(await page.locator('[data-tool="saved_disabled"]').isDisabled(), "resume enabled a disabled Lua tool");
      assert(await page.locator('[data-tool="saved_removed"]').count() === 0, "resume restored a removed Lua tool");
      assert(
        await page.locator('[data-ui="saved_removed_panel"]').count() === 0,
        "resume restored a removed UI element",
      );
      const resumed = await readSave();
      assert(
        resumed?.snapshot.state.visits === 1,
        `resumed visits=${resumed?.snapshot.state.visits}, expected 1 — the entry script's GameState.set was not re-applied over the save`,
      );
      // The same contract for the inventory: the entry directive that granted
      // the relic has just run again, and the save's own contents must still
      // be the ones that count.
      await waitForTextEquals(page, "#inventoryCount", "1 / 12");
      const inventory = await textOf(page, "#inventoryCount");
      assert(inventory === "1 / 12", `resume re-granted a spent item: #inventoryCount=${inventory}`);

      // The manager lists the slot, and the slot belongs to this project alone.
      await page.locator("#savesBtn").click();
      await waitForText(page, "#saveOverlay", "Save Fixture");
      await waitForText(page, "#saveOverlay", "vault");
      const rows = await page.locator("#saveList .project-card").count();
      assert(rows === 1, `save manager listed ${rows} rows, expected 1`);
      for (const label of ["Resume", "Export", "Delete"]) {
        assert(
          await page.locator("#saveList button", { hasText: label }).count() === 1,
          `save row has no ${label} action`,
        );
      }
      await page.locator("#closeSaves").click();

      return `saved location=vault visits=1 inventory=[coin]; restart returned to Iron Gate with the save intact; ` +
        `Manage Saves restored Cold Vault with visits=1 and the spent relic still spent ` +
        `(neither the entry script's GameState.set nor the vault's give directive clobbered the save); ` +
        `save manager listed 1 row with Resume/Export/Delete`;
    });

    await runCheck("9a. Export a save to JSON, delete it, and import it back", async () => {
      // The escape hatch against a browser reset, and the one path that leaves
      // IndexedDB entirely. Exercised as a full round trip — export, destroy the
      // stored record, re-import — because a save file that can be written but
      // not read back is not a backup.
      await page.locator("#savesBtn").click();
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#saveList button", { hasText: "Export" }).click();
      const download = await downloadPromise;
      const exported = await download.path();
      assert(exported, "export produced no local path");
      assert(download.suggestedFilename().endsWith(".json"), `export was named "${download.suggestedFilename()}"`);
      const body = JSON.parse(await Deno.readTextFile(exported)) as {
        format: string;
        saveVersion: number;
        record: { projectId: string; snapshot: { location: string } };
      };
      assert(body.format === "inkforge-save", `export envelope format was "${body.format}"`);
      assert(body.saveVersion === 1, `export envelope saveVersion was ${body.saveVersion}`);
      assert(body.record.projectId === "save-fixture", "export carried the wrong project id");
      assert(body.record.snapshot.location === "vault", "export did not carry the saved location");

      // Delete the stored slot so the import is a real restore, not a no-op
      // overwrite. "Delete this save?" is auto-accepted by the dialog handler.
      await page.locator("#saveList button", { hasText: "Delete" }).click();
      await waitForText(page, "#saveOverlay", "No saves yet");
      const goneSave = await page.evaluate(async (projectId: string) => {
        const request = indexedDB.open("inkforge-project-library");
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const found = await new Promise<unknown>((resolve, reject) => {
          const get = db.transaction("saves", "readonly").objectStore("saves").get([projectId, "manual"]);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        db.close();
        return found ?? null;
      }, "save-fixture");
      assert(goneSave === null, "deleting the save left a record behind");

      // Import stays in the manager, then refreshes its list in place.
      const chooserPromise = page.waitForEvent("filechooser");
      await page.locator("#importSaveBtn").click();
      await (await chooserPromise).setFiles(exported);
      await waitForText(page, "#diagnostics", "Save imported");
      await waitForText(page, "#saveOverlay", "Save Fixture");
      const restoredSave = await page.evaluate(async (projectId: string) => {
        const request = indexedDB.open("inkforge-project-library");
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const found = await new Promise<{ location: string; origin?: { projectId: string } } | undefined>(
          (resolve, reject) => {
            const get = db.transaction("saves", "readonly").objectStore("saves").get([projectId, "manual"]);
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          },
        );
        db.close();
        return found;
      }, "save-fixture");
      assert(restoredSave, "importing the file back did not restore a record");
      assert(restoredSave.location === "vault", `re-imported location was "${restoredSave.location}"`);
      assert(restoredSave.origin?.projectId === "save-fixture", "the import did not record where it came from");

      // And the re-imported save is resumable, not merely stored.
      await page.locator("#saveList button", { hasText: "Resume" }).click();
      await waitForTextEquals(page, "#storyTitle", "Cold Vault");

      return `exported "${download.suggestedFilename()}" with format=inkforge-save saveVersion=1 and location=vault; ` +
        `deleted the stored slot (store confirmed empty); re-imported it and resumed to Cold Vault, ` +
        `with the origin project recorded`;
    });

    await runCheck("9b. Importing over a stored save asks first, even after a boot that failed", async () => {
      // The cached save is refreshed once a boot settles, so a project that
      // cannot boot leaves the previous project's record sitting in it. Reading
      // only the cache would then replace the active project's own save with no
      // question asked — the one import path that can lose a run outright.
      const target: PackShape = {
        manifest: {
          format: "inkforge-pack",
          packVersion: 2,
          project: { id: "import-target", title: "Import Target", version: "1.0.0" },
          files: ["scenario.yaml", "scripts/main.lua"],
        },
        entries: {
          "scenario.yaml": new TextEncoder().encode(`meta:
  title: Import Target
startLocation: hall
locations:
  hall:
    title: 'Import Hall'
    text:
      - 'A quiet hall, and nothing in it yet.'
`),
          "scripts/main.lua": new TextEncoder().encode("-- import-target\n"),
        },
      };
      await importPack(page, target, "startLocation: hall", "scenario.yaml");
      await waitForTextEquals(page, "#storyTitle", "Import Hall");
      await page.locator("#saveBtn").click();
      await waitForText(page, "#diagnostics", "Saved");

      // Away to a project that has a save of its own, so the cache holds that
      // project's record rather than the target's. A load is a fresh boot, so
      // it lands on the start location and nothing is resumed.
      await page.locator("#loadBtn").click();
      await page.locator('#projectList [data-project="save-fixture"] button', { hasText: "Load" }).click();
      await waitForTextEquals(page, "#storyTitle", "Iron Gate");

      // Then a newer pack for the target whose YAML does not compose: the
      // import lands and the boot fails, so nothing refreshes the cache. The
      // slot itself is untouched — a pack has nothing to say about saves.
      const broken: PackShape = {
        manifest: { ...target.manifest, project: { ...target.manifest.project, version: "1.0.1" } },
        entries: {
          ...target.entries,
          "scenario.yaml": new TextEncoder().encode("startLocation: hall\nlocations: [oops\n"),
        },
      };
      await importPack(page, broken, "startLocation: hall", "scenario.yaml", { expectReady: false });
      // The switch is observable on the body, and `projectReady` is the signal
      // the harness trusts: a boot that failed leaves it false, and only the
      // boot that reaches the end — where the save cache is refreshed — sets it.
      await page.waitForFunction(
        () => document.body.dataset.projectId === "import-target" && document.body.dataset.projectReady === "false",
        undefined,
        { timeout: BOOT_TIMEOUT },
      );
      // What the author sees, not the wording of the YAML library's complaint.
      const failedBoot = await page.evaluate(() => ({
        diagnostics: (document.querySelector("#diagnostics")?.textContent ?? "").trim(),
        entries: document.querySelectorAll("#heroTerminal .entry").length,
      }));
      assert(failedBoot.entries > 0, "the boot that failed left no entry in the terminal");
      assert(failedBoot.diagnostics !== "● Ready", `a boot that failed still reported "${failedBoot.diagnostics}"`);

      // The target's own save is still there to be protected.
      await page.locator("#savesBtn").click();
      await waitForText(page, "#saveOverlay", "Import Target");
      const row = page.locator("#saveList .project-card", { hasText: "Import Target" });
      assert(await row.count() === 1, "the target's save was not listed");
      const before = (await row.textContent()) ?? "";
      const downloadPromise = page.waitForEvent("download");
      await row.locator("button", { hasText: "Export" }).click();
      const file = await (await downloadPromise).path();
      assert(file, "export produced no save file to re-import");

      // The harness dismisses every dialog it is not expecting, so a declined
      // prompt is the outcome here — which is exactly what must happen.
      const prompted = page.waitForEvent("dialog", { timeout: BOOT_TIMEOUT }).then(() => true).catch(() => false);
      const chooserPromise = page.waitForEvent("filechooser");
      await page.locator("#importSaveBtn").click();
      await (await chooserPromise).setFiles(file);
      assert(await prompted, "importing over the active project's own save did not ask first");
      assert(
        await page.locator("#saveList .project-card", { hasText: "Import Target" }).locator(".save-origin").count() ===
          0,
        "a declined import still replaced the save",
      );
      assert(
        ((await row.textContent()) ?? "") === before,
        "the target's save row changed after a declined import",
      );

      return `imported a project, saved, left for another project, then re-imported a pack whose YAML does not ` +
        `compose; the boot failed and the stale cache was not consulted: re-importing over the target's own save ` +
        `asked first and, declined, left the row unchanged ("${before.trim()}")`;
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
