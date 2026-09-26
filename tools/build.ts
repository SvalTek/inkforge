import { build as esbuild, transform } from "esbuild";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { join, relative } from "node:path";
import { DIST, INDEX_HTML, ROOT, SRC, STYLES, TEMPLATES } from "./paths.ts";

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

/**
 * Build the `wasmUri` data URI for the Lua runtime.
 *
 * wasmoon's Emscripten glue would otherwise resolve `glue.wasm` relative to its
 * own script URL, which breaks once the runtime is bundled into the app. An
 * inlined data URI makes the bundle self-contained: nothing extra to ship,
 * nothing to go stale, and no way for the load to fail.
 *
 * `wasmoon` is resolved through the import map, so the version is whatever
 * `deno.json` pins rather than a second copy of the version number here.
 */
async function wasmDataUri(): Promise<string> {
  const glue = new URL("glue.wasm", import.meta.resolve("wasmoon"));
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(glue);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`wasmoon glue.wasm not found at ${glue.href} — check the "wasmoon" entry in deno.json.`);
    }
    throw error;
  }

  // Chunked to stay under the argument-spread limit for large binaries.
  const chunkSize = 8192;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}

export async function build(options: BuildOptions = {}): Promise<void> {
  const minify = options.minify ?? true;
  const sourcemap = options.sourcemap ?? false;

  await removeDir(DIST);
  await Deno.mkdir(join(DIST, "assets"), { recursive: true });

  const wasmUri = await wasmDataUri();

  await esbuild({
    // The Deno resolver plugin handles entry points as specifiers, so this must
    // be a project-relative path (or a URL) — an absolute Windows path is
    // mangled into a bogus URL and fails to resolve.
    entryPoints: [relative(ROOT, join(SRC, "main.ts"))],
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    outfile: join(DIST, "assets", "main.js"),
    sourcemap,
    minify,
    logLevel: "info",
    // esbuild does not read `deno.json`, so `experimentalDecorators` must be
    // restated here. Without it esbuild emits standard TC39 decorators, whose
    // `(value, context)` signature does not match the legacy
    // `(target, propertyKey, descriptor)` form WebLuaBridge's `@LuaBinding`
    // expects — the bindings then register no methods and install nothing.
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    // The Lua runtime's WASM binary, inlined so the bundle is self-contained.
    define: { __INKFORGE_WASM_URI__: JSON.stringify(wasmUri) },
    // Resolve `https:`, `npm:` and `jsr:` specifiers (and the `deno.json`
    // import map) through Deno's module graph and global cache, so the app can
    // depend on WebLuaBridge by pinned commit without vendoring it.
    plugins: [...denoPlugins()],
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
  const css = parts.map((part) => part.replace(/\n+$/, "")).join("\n") + "\n";

  // The partials are formatted to be read by a person; minifying here is what
  // keeps that free at runtime. `charset: "utf8"` leaves literal punctuation
  // (em dashes, the ◇ glyph) alone instead of escaping it into \2014-style
  // codes. Concatenating in filename order is the cascade, so it happens before
  // this and nothing is reordered.
  const style = minify ? (await transform(css, { loader: "css", minify: true, charset: "utf8" })).code : css;
  await Deno.writeTextFile(join(DIST, "style.css"), style);

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
