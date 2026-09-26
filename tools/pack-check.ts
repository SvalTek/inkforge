import { strFromU8, unzipSync } from "fflate";
import { basename, join } from "node:path";
import { compareVersions } from "../src/import-export/pack.ts";
import { TEMPLATES } from "./paths.ts";

/**
 * Focused SemVer precedence checks for `.inkforge` manifest versions, and a drift
 * guard that every committed pack still matches the folder it was built from.
 * Mirrors the `tools/renderer-check.ts` pattern: assert in-process and exit
 * non-zero on failure.
 */

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectOrder(lower: string, higher: string): void {
  assert(compareVersions(lower, higher) < 0, `${lower} should sort before ${higher}`);
  assert(compareVersions(higher, lower) > 0, `${higher} should sort after ${lower}`);
  assert(compareVersions(lower, lower) === 0, `${lower} should equal itself`);
}

expectOrder("1.0.0-beta", "1.0.0");
expectOrder("1.0.0-alpha", "1.0.0-beta");
expectOrder("1.0.0-alpha.1", "1.0.0-alpha.2");
expectOrder("1.0.0-alpha.1", "1.0.0-alpha.beta");
expectOrder("1.0.0-alpha.beta", "1.0.0-beta");
expectOrder("1.0.0-beta.2", "1.0.0-beta.11");
expectOrder("1.0.0-beta.11", "1.0.0-rc.1");
expectOrder("1.0.0-rc.1", "1.0.0");
expectOrder("1.0.0", "1.0.1");
expectOrder("1.0.0", "1.1.0");
expectOrder("1.0.0", "2.0.0");
expectOrder("1.0.0-1", "1.0.0-alpha");
expectOrder("1.0.0-alpha", "1.0.0-alpha.1");

assert(compareVersions("1.2.3", "1.2.3") === 0, "equal stable versions should compare equal");
assert(compareVersions("1.0.0-rc.1", "1.0.0-rc.1") === 0, "equal prereleases should compare equal");

for (const malformed of ["1.0", "1.0.0.0", "v1.0.0", "1.0.0+build", "1.0.0-", "abc", ""]) {
  let rejected = false;
  try {
    compareVersions(malformed, "1.0.0");
  } catch {
    rejected = true;
  }
  assert(rejected, `malformed version should be rejected: ${JSON.stringify(malformed)}`);
}

console.log("Pack version precedence checks passed.");

/**
 * Every `templates/<name>.inkforge` must be what packing `templates/<name>` would
 * produce right now.
 *
 * A pack is the artifact people actually import, so a folder that has moved on
 * without a re-pack ships stale content under a version that says otherwise — and
 * the importer, seeing an equal version, declines it without a word. `deno task
 * pack` refuses to *create* that state; this catches one that already exists,
 * including a pack left behind by an edit nobody packed.
 */
function committedPacks(): string[] {
  const packs: string[] = [];
  for (const entry of Deno.readDirSync(TEMPLATES)) {
    if (entry.isFile && entry.name.endsWith(".inkforge")) packs.push(join(TEMPLATES, entry.name));
  }
  return packs.sort();
}

function verifyCommittedPack(packPath: string): string {
  const name = basename(packPath, ".inkforge");
  const folder = join(TEMPLATES, name);
  const entries = unzipSync(Deno.readFileSync(packPath));
  const manifestBytes = entries["manifest.json"];
  assert(manifestBytes, `${name}: pack has no manifest.json`);
  const manifest = JSON.parse(strFromU8(manifestBytes)) as {
    format?: string;
    packVersion?: number;
    project?: { id?: string; version?: string };
    files?: string[];
  };
  assert(manifest.format === "inkforge-pack" && manifest.packVersion === 2, `${name}: pack is not version 2`);
  assert(manifest.project?.id, `${name}: pack has no project.id`);
  assert(typeof manifest.project.version === "string", `${name}: pack has no project.version`);
  const listed = manifest.files ?? [];
  assert(listed.length > 0, `${name}: pack lists no files`);

  const sourceManifest = JSON.parse(Deno.readTextFileSync(join(folder, "manifest.json"))) as {
    project?: { id?: string; version?: string };
  };
  assert(
    sourceManifest.project?.id === manifest.project.id,
    `${name}: pack id ${manifest.project.id} does not match the folder's ${sourceManifest.project?.id}`,
  );
  assert(
    sourceManifest.project?.version === manifest.project.version,
    `${name}: pack is v${manifest.project.version} but ${name}/manifest.json is v${sourceManifest.project?.version}` +
      ` — re-pack the folder`,
  );

  for (const path of listed) {
    const packed = entries[path];
    assert(packed, `${name}: pack is missing ${path}`);
    const source = Deno.readFileSync(join(folder, path));
    assert(
      packed.length === source.length && packed.every((byte, index) => byte === source[index]),
      `${name}: ${path} in the pack differs from ${name}/${path} — re-pack the folder`,
    );
  }
  const extra = Object.keys(entries).filter((entry) => entry !== "manifest.json" && !listed.includes(entry));
  assert(extra.length === 0, `${name}: pack carries unpackaged entries: ${extra.join(", ")}`);
  return `${name} v${manifest.project.version}`;
}

const verified = committedPacks().map(verifyCommittedPack);
console.log(`Committed packs match their folders: ${verified.join(", ")}.`);
