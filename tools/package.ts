import { basename, dirname, join, relative, resolve, sep } from "node:path";

interface PackProject {
  vfs: Record<string, string>;
  assets: string[];
  scenario: string;
  script: string;
}

interface PackFile {
  format: "inkforge-pack";
  version: 1;
  files: PackProject;
  assets: string[];
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

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function manifestFiles(root: string, excluded: string): Promise<string[]> {
  const manifestPath = join(root, "manifest.json");
  if (!(await isFile(manifestPath))) throw new Error("Source folder must contain manifest.json");
  const parsed: unknown = JSON.parse(await Deno.readTextFile(manifestPath));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("manifest.json must be an array of relative file paths");
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const path = resolve(root, entry.replace(/[\\/]/g, sep));
    if (!isInside(root, path)) throw new Error(`Manifest path escapes source folder: ${entry}`);
    if (path.toLowerCase() === resolve(excluded).toLowerCase()) continue;
    if (!(await isFile(path))) throw new Error(`Manifest file not found: ${entry}`);
    const key = relative(root, path).split(sep).join("/");
    if (seen.has(key)) throw new Error(`Duplicate manifest path: ${key}`);
    seen.add(key);
    files.push(path);
  }
  return files;
}

async function readVfs(root: string, files: string[]): Promise<Record<string, string>> {
  const vfs: Record<string, string> = {};
  for (const path of files) {
    const key = relative(root, path).split(sep).join("/");
    try {
      vfs[key] = new TextDecoder("utf-8", { fatal: true }).decode(await Deno.readFile(path));
    } catch (error) {
      throw new Error(`Cannot package ${key} as UTF-8 text; binary assets are not supported by pack version 1.`, {
        cause: error,
      });
    }
  }
  return vfs;
}

export async function packageFolder(options: PackageOptions): Promise<void> {
  const stat = await Deno.stat(options.folder);
  if (!stat.isDirectory) throw new Error(`Source path is not a folder: ${options.folder}`);
  if (resolve(options.output).toLowerCase() === resolve(options.folder).toLowerCase()) {
    throw new Error("Output path must be a file, not the source folder");
  }
  const selected = await manifestFiles(options.folder, options.output);
  const vfs = await readVfs(options.folder, selected);
  if (!vfs["scenario.yaml"]) throw new Error("Source folder must contain scenario.yaml");
  if (!vfs["scripts/main.lua"]) throw new Error("Source folder must contain scripts/main.lua");
  const files: PackProject = {
    vfs,
    assets: [],
    scenario: vfs["scenario.yaml"],
    script: vfs["scripts/main.lua"],
  };
  const pack: PackFile = { format: "inkforge-pack", version: 1, files, assets: [] };
  await Deno.mkdir(dirname(options.output), { recursive: true });
  await Deno.writeTextFile(options.output, `${JSON.stringify(pack, null, 2)}\n`);
  console.log(`Packed ${Object.keys(vfs).length} VFS files into ${options.output}`);
}

if (import.meta.main) {
  try {
    await packageFolder(parseArgs(Deno.args));
  } catch (error) {
    console.error(`Packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
