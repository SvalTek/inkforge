import { build } from "./build.ts";
import { DIST } from "./paths.ts";
import { serveStatic } from "./server.ts";
import type { Browser, BrowserContext, Page } from "playwright-core";

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
    await page.locator("#loadBtn").click();
    await page.locator('#projectList [data-project="renderer-stage-showcase"] button:not([disabled])').first().click();
    await waitFor(page, "#storyTitle", "The authored visual stage");
    await page.locator('.nav[data-view="author"]').click();
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
    await page.locator('.file[data-file="scenario.yaml"]').click();
    assert(await page.locator('.file[data-file="modals.yml"]').count() === 1, "modals.yml missing from Author tree");
    assert(await page.locator('.file[data-file="tools.yml"]').count() === 1, "tools.yml missing from Author tree");
    await page.locator('.file[data-file="modals.yml"]').click();
    assert((await page.locator("#code").inputValue()).includes("Stage Journal"), "modals.yml could not be opened");
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
    assert(await page.locator('[data-tool="lua_tool"]').count() === 0, "game.tool.hide did not hide the runtime tool");
    await page.locator('[data-modal-ui="show_runtime_tool"]').click();
    assert(await page.locator('[data-tool="lua_tool"]').count() === 1, "game.tool.show did not show the runtime tool");
    await page.locator('[data-modal-ui="disable_map_tool"]').click();
    assert(await page.locator('[data-tool="map_tool"]').isDisabled(), "game.tool.disable did not disable the map tool");
    await page.locator('[data-modal-ui="enable_map_tool"]').click();
    assert(
      !(await page.locator('[data-tool="map_tool"]').isDisabled()),
      "game.tool.enable did not enable the map tool",
    );
    await page.locator('[data-modal-ui="close_journal"]').click();

    await page.locator('[data-tool="map_tool"]').click();
    await waitFor(page, "#heroTerminal", "Map tool action dispatched to Lua.");
    await page.locator('[data-tool="journal_tool"]').click();
    await page.locator('[data-modal-ui="remove_runtime_tool"]').click();
    assert(
      await page.locator('[data-tool="lua_tool"]').count() === 0,
      "game.tool.remove did not remove the runtime tool",
    );
    await page.locator('[data-modal-ui="close_journal"]').click();

    await page.locator("#restartHero").click();
    await page.waitForFunction(
      () => document.querySelector('[data-tool="lua_tool"]') !== null,
      undefined,
      { timeout: TIMEOUT },
    );
    assert(await page.locator('[data-tool="lua_tool"]').count() === 1, "restart did not reset Lua tool registration");
    assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
    console.log("PASS  YAML/Lua registration, icons, hover, modal recursion/paging, actions, state controls, reset");
  } finally {
    await context.close();
    await browser.close();
    await server.shutdown();
  }
}

await main();
