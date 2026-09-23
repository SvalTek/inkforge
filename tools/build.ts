import { build as esbuild } from "esbuild";
import { join } from "node:path";
import { DIST, INDEX_HTML, SRC, STYLES, TEMPLATES } from "./paths.ts";

export interface BuildOptions {
  minify?: boolean;
  sourcemap?: boolean;
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

async function removeDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function copyDir(from: string, to: string): Promise<number> {
  await Deno.mkdir(to, { recursive: true });
  let count = 0;
  for await (const entry of Deno.readDir(from)) {
    const sourcePath = join(from, entry.name);
    const targetPath = join(to, entry.name);
    if (entry.isDirectory) {
      count += await copyDir(sourcePath, targetPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourcePath, targetPath);
      count += 1;
    }
  }
  return count;
}

async function listStyleFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(STYLES)) {
    if (entry.isFile && entry.name.toLowerCase().endsWith(".css")) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

export async function build(options: BuildOptions = {}): Promise<void> {
  const minify = options.minify ?? true;
  const sourcemap = options.sourcemap ?? false;

  await removeDir(DIST);
  await Deno.mkdir(join(DIST, "assets"), { recursive: true });

  await esbuild({
    entryPoints: [join(SRC, "main.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile: join(DIST, "assets", "main.js"),
    sourcemap,
    minify,
    logLevel: "info",
  });

  await Deno.copyFile(INDEX_HTML, join(DIST, "index.html"));

  const templateCount = await copyDir(TEMPLATES, join(DIST, "templates"));

  const styleFiles = await listStyleFiles();
  if (styleFiles.length === 0) {
    throw new Error(`No CSS partials found in ${STYLES}`);
  }
  const parts: string[] = [];
  for (const file of styleFiles) {
    parts.push(await Deno.readTextFile(join(STYLES, file)));
  }
  await Deno.writeTextFile(
    join(DIST, "style.css"),
    parts.map((part) => part.replace(/\n+$/, "")).join("\n") + "\n",
  );

  console.log("Styles concatenated in order:");
  for (const file of styleFiles) {
    console.log(`  - ${file}`);
  }

  const mainJs = await Deno.stat(join(DIST, "assets", "main.js"));
  const styleCss = await Deno.stat(join(DIST, "style.css"));

  console.log("Build summary:");
  console.log(`  output dir: ${DIST}`);
  console.log(`  dist/assets/main.js: ${mainJs.size} bytes`);
  console.log(`  dist/style.css: ${styleCss.size} bytes`);
  console.log(`  template files copied: ${templateCount}`);
}

if (import.meta.main) {
  try {
    if (!(await pathExists(SRC))) {
      throw new Error(`Source directory not found: ${SRC}`);
    }
    await build();
  } catch (error) {
    console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
