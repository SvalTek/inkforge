import { normalize, sep } from "node:path";
import { build } from "./build.ts";
import { DIST, INDEX_HTML, SRC, STYLES, TEMPLATES } from "./paths.ts";
import { serveStatic } from "./server.ts";

function parsePort(args: string[], fallback: number): number {
  const index = args.indexOf("--port");
  if (index === -1) return fallback;
  const raw = args[index + 1] ?? "";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid --port value: ${raw === "" ? "(missing)" : raw}`);
  }
  return parsed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = normalize(parent).toLowerCase();
  const normalizedCandidate = normalize(candidate).toLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent + sep);
}

let running = false;
let queued = false;

async function rebuild(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  try {
    console.log("Change detected, rebuilding...");
    await build();
    console.log("Rebuild complete.");
  } catch (error) {
    console.error(`Rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void rebuild();
    }
  }
}

async function watchSources(): Promise<void> {
  const targets: string[] = [];
  for (const candidate of [SRC, STYLES, TEMPLATES, INDEX_HTML]) {
    if (await pathExists(candidate)) targets.push(candidate);
  }
  if (targets.length === 0) {
    console.warn("No source paths found to watch; live rebuild is disabled.");
    return;
  }

  console.log(`Watching: ${targets.join(", ")}`);
  const watcher = Deno.watchFs(targets);
  let pending: ReturnType<typeof setTimeout> | undefined;
  for await (const event of watcher) {
    if (event.paths.length > 0 && event.paths.every((path) => isInside(DIST, path))) continue;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      void rebuild();
    }, 150);
  }
}

const port = parsePort(Deno.args, 4173);

await build();

serveStatic({ root: DIST, port });
console.log(`Dev server running at http://localhost:${port}/`);
console.log("Press Ctrl+C to stop.");

await watchSources();
