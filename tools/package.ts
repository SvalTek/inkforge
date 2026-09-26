import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { assetMime } from "../src/project/assets.ts";
import { compareVersions } from "../src/import-export/pack.ts";
import { isFolderMarker } from "../src/editor/tree.ts";
import type { ProjectIdentity } from "../src/types/project.ts";

interface SourceManifest {
  format: "inkforge-pack";
  packVersion: 2;
  project: ProjectIdentity;
  files: string[];
}

/** Which SemVer field `--bump` raises. */
type BumpLevel = "major" | "minor" | "patch";

interface PackageOptions {
  folder: string;
  output: string;
  bump?: BumpLevel;
  force: boolean;
}

function usage(): never {
  throw new Error(
    "Usage: deno task pack -- <folder> [--out <file.inkforge>] [--bump major|minor|patch] [--force]",
  );
}

function parseArgs(args: string[]): PackageOptions {
  let folder: string | undefined;
  let output: string | undefined;
  let bump: BumpLevel | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--out" || argument === "-o") {
      output = args[++index];
      if (!output) usage();
      continue;
    }
    if (argument === "--bump" || argument === "-b") {
      const level = args[++index];
      if (level !== "major" && level !== "minor" && level !== "patch") usage();
      bump = level;
      continue;
    }
    if (argument === "--force" || argument === "-f") {
      force = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (folder) throw new Error(`Only one source folder may be provided: ${folder}`);
    folder = argument;
  }
  if (!folder) usage();
  const source = resolve(folder);
  return {
    folder: source,
    output: resolve(output ?? join(dirname(source), `${basename(source)}.inkforge`)),
    bump,
    force,
  };
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
    if (isFolderMarker(entry)) throw new Error(`Reserved empty-folder marker path: ${entry}`);
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

/** Raise one SemVer field. A bump lands on a stable release, so any prerelease is dropped. */
export function bumpVersion(version: string, level: BumpLevel): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Rewrite the manifest's version in place.
 *
 * The version is the one key `--bump` owns, so it is replaced as text rather
 * than by re-serialising: an author's own formatting and key order survive, and
 * the only thing that changes in the diff is the number.
 */
async function writeManifestVersion(root: string, version: string): Promise<void> {
  const path = join(root, "manifest.json");
  const text = await Deno.readTextFile(path);
  const keys = text.match(/"version"\s*:/g) ?? [];
  if (keys.length !== 1) {
    throw new Error(`manifest.json must hold exactly one "version" key to bump, found ${keys.length}`);
  }
  const updated = text.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`);
  if (updated === text) throw new Error("manifest.json version could not be rewritten");
  await Deno.writeTextFile(path, updated);
}

interface ExistingPack {
  version: string;
  entries: Record<string, Uint8Array>;
}

/** The pack already at the output path, which is the last artifact that shipped. */
async function readExistingPack(path: string): Promise<ExistingPack | undefined> {
  if (!(await isFile(path))) return undefined;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(await Deno.readFile(path));
  } catch {
    throw new Error(`Existing pack could not be read: ${path}. Delete it, or pass --force to replace it.`);
  }
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error(`Existing pack has no manifest.json: ${path}`);
  const parsed = JSON.parse(strFromU8(manifestBytes)) as Partial<SourceManifest>;
  if (typeof parsed.project?.version !== "string") {
    throw new Error(`Existing pack has no project.version: ${path}. Delete it, or pass --force to replace it.`);
  }
  return { version: parsed.project.version, entries };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * How the pack about to be written differs from the one on disk.
 *
 * `manifest.json` is excluded: a version change is the answer to a content
 * change, not evidence of one, and the two are reported separately.
 */
function describeChanges(before: Record<string, Uint8Array>, after: Record<string, Uint8Array>): string[] {
  const changes: string[] = [];
  for (const [key, bytes] of Object.entries(after)) {
    if (key === "manifest.json") continue;
    const previous = before[key];
    if (!previous) changes.push(`added ${key}`);
    else if (!sameBytes(previous, bytes)) changes.push(`changed ${key}`);
  }
  for (const key of Object.keys(before)) {
    if (key !== "manifest.json" && !after[key]) changes.push(`removed ${key}`);
  }
  return changes;
}

export async function packageFolder(options: PackageOptions): Promise<void> {
  const stat = await Deno.stat(options.folder);
  if (!stat.isDirectory) throw new Error(`Source path is not a folder: ${options.folder}`);
  if (resolve(options.output).toLowerCase() === resolve(options.folder).toLowerCase()) {
    throw new Error("Output path must be a file, not the source folder");
  }
  const manifest = await readManifest(options.folder);
  const declared = manifest.project.version;
  if (options.bump) {
    manifest.project.version = bumpVersion(declared, options.bump);
    await writeManifestVersion(options.folder, manifest.project.version);
    console.log(`Bumped ${manifest.project.id} ${declared} -> ${manifest.project.version} in manifest.json`);
  }
  const selected = await selectedFiles(options.folder, manifest, options.output);
  const archive: Record<string, Uint8Array> = {
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (const path of selected) {
    const key = relative(options.folder, path).split(sep).join("/");
    archive[key] = await Deno.readFile(path);
  }
  // The importer keeps whichever project is newer, so a pack that changes content
  // under an unchanged version is one nobody can install: it is declined as
  // "already v<version>". Catch that here, where the author still knows what the
  // change was worth, rather than at the far end of an import that quietly did
  // nothing.
  const existing = await readExistingPack(options.output);
  const changes = existing ? describeChanges(existing.entries, archive) : [];
  if (existing && changes.length) {
    const listed = changes.map((change) => `  - ${change}`).join("\n");
    const order = compareVersions(manifest.project.version, existing.version);
    if (order < 0 && !options.force) {
      throw new Error(
        `Content changed, but ${manifest.project.version} is older than the packed ${existing.version}:\n${listed}\n` +
          `An importer declines an older package, so this would ship a change nobody can install. ` +
          `Raise project.version, or pass --force to repack in place.`,
      );
    }
    if (order === 0 && !options.force) {
      throw new Error(
        `Content changed, but project.version is still ${manifest.project.version}:\n${listed}\n` +
          `Importing this pack would be declined as "already v${existing.version}", leaving existing installs ` +
          `on the old content. Re-run with --bump patch|minor|major to raise the version and write it to ` +
          `manifest.json, or pass --force to repack in place.`,
      );
    }
  }
  await Deno.mkdir(dirname(options.output), { recursive: true });
  await Deno.writeFile(options.output, zipSync(archive));
  let note = "";
  if (existing && existing.version !== manifest.project.version) {
    note = ` (v${existing.version} -> v${manifest.project.version})`;
  } else if (existing && changes.length) {
    note = ` (content changed under v${existing.version}, forced)`;
  } else if (existing) {
    note = ` (content unchanged since v${existing.version})`;
  }
  console.log(`Packed ${selected.length} project files into ${options.output}${note}`);
}

if (import.meta.main) {
  try {
    await packageFolder(parseArgs(Deno.args));
  } catch (error) {
    console.error(`Packaging failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
