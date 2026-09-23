import { strToU8, zipSync } from "fflate";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assetMime } from "../src/project/assets.ts";
import type { ProjectIdentity } from "../src/types/project.ts";

interface SourceManifest {
  format: "inkforge-pack";
  packVersion: 2;
  project: ProjectIdentity;
  files: string[];
}

interface PackageOptions {
  folder: string;
  output: string;
}

function usage(): never {
  throw new Error("Usage: deno task pack -- <folder> [--out <file.inkforge>]");
}

function parseArgs(args: string[]): PackageOptions {
  let folder: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--out" || argument === "-o") {
      output = args[++index];
      if (!output) usage();
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (folder) throw new Error(`Only one source folder may be provided: ${folder}`);
    folder = argument;
  }
  if (!folder) usage();
  const source = resolve(folder);
  return { folder: source, output: resolve(output ?? join(dirname(source), `${basename(source)}.inkforge`)) };
}

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = resolve(parent).toLowerCase();
  const normalizedCandidate = resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent + sep);
}

function validateVersion(version: unknown): asserts version is string {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("manifest.json project.version must be semantic version text");
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function readManifest(root: string): Promise<SourceManifest> {
  const path = join(root, "manifest.json");
  if (!(await isFile(path))) throw new Error("Source folder must contain manifest.json");
  const parsed = JSON.parse(await Deno.readTextFile(path)) as Partial<SourceManifest>;
  if (
    parsed.format !== "inkforge-pack" || parsed.packVersion !== 2 || typeof parsed.project?.id !== "string" ||
    !parsed.project.id.trim() || !Array.isArray(parsed.files) ||
    !parsed.files.every((entry) => typeof entry === "string")
  ) {
    throw new Error("manifest.json must be an Inkforge pack version 2 manifest");
  }
  validateVersion(parsed.project.version);
  return parsed as SourceManifest;
}

async function selectedFiles(root: string, manifest: SourceManifest, excluded: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (
      !entry || entry === "manifest.json" || entry.startsWith("/") || entry.includes("\\") ||
      entry.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) throw new Error(`Manifest path is not a safe relative path: ${entry}`);
    const normalized = entry.replace(/[\\/]/g, sep);
    const path = resolve(root, normalized);
    if (!isInside(root, path)) throw new Error(`Manifest path escapes source folder: ${entry}`);
    if (path.toLowerCase() === resolve(excluded).toLowerCase()) continue;
    if (!(await isFile(path))) throw new Error(`Manifest file not found: ${entry}`);
    const key = relative(root, path).split(sep).join("/");
    if (key === "manifest.json") throw new Error("manifest.json is reserved for the package manifest");
    if (seen.has(key)) throw new Error(`Duplicate manifest path: ${key}`);
    if (key.startsWith("assets/") && !assetMime(key)) throw new Error(`Unsupported asset type: ${key}`);
    seen.add(key);
    files.push(path);
  }
  if (!manifest.files.includes("scenario.yaml")) throw new Error("Manifest must include scenario.yaml");
  if (!manifest.files.includes("scripts/main.lua")) throw new Error("Manifest must include scripts/main.lua");
  return files;
}

export async function packageFolder(options: PackageOptions): Promise<void> {
  const stat = await Deno.stat(options.folder);
  if (!stat.isDirectory) throw new Error(`Source path is not a folder: ${options.folder}`);
  if (resolve(options.output).toLowerCase() === resolve(options.folder).toLowerCase()) {
    throw new Error("Output path must be a file, not the source folder");
  }
  const manifest = await readManifest(options.folder);
  const selected = await selectedFiles(options.folder, manifest, options.output);
  const archive: Record<string, Uint8Array> = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (const path of selected) {
    const key = relative(options.folder, path).split(sep).join("/");
    archive[key] = await Deno.readFile(path);
  }
  await Deno.mkdir(dirname(options.output), { recursive: true });
  await Deno.writeFile(options.output, zipSync(archive));
  console.log(`Packed ${selected.length} project files into ${options.output}`);
}

if (import.meta.main) {
  try {
    await packageFolder(parseArgs(Deno.args));
  } catch (error) {
    console.error(`Packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
