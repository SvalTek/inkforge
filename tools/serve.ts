import { join } from "node:path";
import { DIST } from "./paths.ts";
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

const port = parsePort(Deno.args, 4173);
const builtIndex = join(DIST, "index.html");

let exists = true;
try {
  await Deno.stat(builtIndex);
} catch (error) {
  if (error instanceof Deno.errors.NotFound) {
    exists = false;
  } else {
    throw error;
  }
}

if (!exists) {
  console.error(`Missing build output: ${builtIndex}`);
  console.error('Run "deno task build" first, then re-run "deno task serve".');
  Deno.exit(1);
}

serveStatic({ root: DIST, port });
console.log(`Serving production preview at http://localhost:${port}/`);
console.log("Press Ctrl+C to stop.");
