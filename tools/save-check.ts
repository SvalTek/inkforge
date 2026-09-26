/**
 * Save and transcript-bound checks.
 *
 * These are the parts of saving that no browser run can reach directly: the cap
 * arithmetic, the snapshot round-trip, the tolerance of a hand-edited file, and
 * the export envelope. The end-to-end path — boot, save, reload, resume — is
 * `tools/smoke.ts`.
 */
import { clearTranscript, MAX_EVENTS, pushEvent } from "../src/engine/events.ts";
import { dedupeUiElements, fromSnapshot, hashScenario, toSnapshot } from "../src/engine/save.ts";
import { parseSaveFile, serializeSaveFile } from "../src/project/save-storage.ts";
import { saveFileStem } from "../src/types/save.ts";
import type { EngineRuntime, SaveRecord } from "../src/types/index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function throws(run: () => unknown, expected: string, message: string): void {
  try {
    run();
  } catch (error) {
    assert((error as Error).message.includes(expected), `${message}: got "${(error as Error).message}"`);
    return;
  }
  throw new Error(`${message}: did not throw`);
}

function runtimeFixture(): EngineRuntime {
  return {
    location: "stone_entry",
    state: { lamp: true, coins: 3, nested: { deep: "value" } },
    inventory: ["coin", "lamp"],
    events: [
      { type: "output", text: "The door is heavy.", kind: "normal" },
      { type: "inventory:add", itemId: "coin" },
    ],
    droppedEvents: 0,
    over: false,
    ui: {
      hidden: new Set(["panel_b"]),
      overrides: { meter: { fields: [{ id: "value", type: "text", value: "7" }] } },
      elements: [{ id: "meter", type: "meter" }],
    },
    modals: { open: "notes", activePages: { notes: "page_two" } },
    tools: {
      entries: new Map([
        ["lantern", { definition: { id: "lantern", label: "Lantern" }, hidden: true, disabled: false, source: "lua" }],
      ]),
    },
    conversation: { speaker: "keeper", line: 3 },
    lua: null,
    canvasEngine: null,
    viewDirty: false,
  };
}

// The transcript cap --------------------------------------------------------

const capped = runtimeFixture();
// Emptied so the arithmetic below is about the cap alone; the fixture ships
// with two entries, which would make the expected drop count depend on them.
capped.events = [];
for (let i = 0; i < MAX_EVENTS + 40; i += 1) {
  pushEvent(capped, { type: "output", text: `line ${i}`, kind: "normal" });
}
assert(capped.events.length === MAX_EVENTS, `cap kept ${capped.events.length} events, expected ${MAX_EVENTS}`);
assert(capped.droppedEvents === 40, `cap counted ${capped.droppedEvents} dropped, expected 40`);
const oldest = capped.events[0];
assert(
  oldest.type === "output" && oldest.text === "line 40",
  "cap trimmed from the head, so the newest entries are the ones kept",
);

const underCap = runtimeFixture();
underCap.events = [];
for (let i = 0; i < MAX_EVENTS; i += 1) pushEvent(underCap, { type: "output", text: `line ${i}`, kind: "normal" });
assert(underCap.droppedEvents === 0, "a run at exactly the cap must not report a drop");

// The clear button resets both halves, or the terminal is left announcing an
// elision it no longer has anything to do with.
const cleared = runtimeFixture();
for (let i = 0; i < MAX_EVENTS + 25; i += 1) pushEvent(cleared, { type: "output", text: `line ${i}`, kind: "normal" });
clearTranscript(cleared);
assert(cleared.events.length === 0, "a cleared transcript is empty");
assert(cleared.droppedEvents === 0, "a cleared transcript reports no elision");

// Snapshot round-trip -------------------------------------------------------

const original = runtimeFixture();
const restored = fromSnapshot(toSnapshot(original));
assert(restored !== null, "a snapshot must resume");
assert(restored.location === "stone_entry", "location survives the round trip");
assert(restored.inventory.join(",") === "coin,lamp", "inventory survives the round trip");
assert(restored.events.length === 2, "transcript survives the round trip");
assert(restored.over === false, "the run is not over");
assert(restored.ui.hidden instanceof Set && restored.ui.hidden.has("panel_b"), "hidden is a Set again");
assert(restored.ui.elements.length === 1 && restored.ui.elements[0].id === "meter", "elements survive");
assert(restored.tools.entries instanceof Map, "the tool registry is a Map again");
assert(restored.tools.entries.get("lantern")?.hidden === true, "tool state survives");
assert(restored.tools.entries.get("lantern")?.source === "lua", "tool provenance survives");
assert(restored.modals.open === "notes" && restored.modals.activePages.notes === "page_two", "modal state survives");
assert(
  (restored.conversation as { speaker: string }).speaker === "keeper",
  "conversation survives",
);
const nested = restored.state.nested as { deep: string };
assert(nested.deep === "value", "a nested state value survives, not just a flat one");

// The snapshot is JSON, which is what both the save store and an export need.
const asJson = JSON.parse(JSON.stringify(toSnapshot(original))) as unknown;
assert(fromSnapshot(asJson) !== null, "a snapshot survives JSON, so a save round-trips through storage");

// Tolerance ----------------------------------------------------------------

assert(fromSnapshot(null) === null, "a null snapshot is not a snapshot");
assert(fromSnapshot("nonsense") === null, "a string is not a snapshot");
assert(fromSnapshot([]) === null, "an array is not a snapshot");

const partial = fromSnapshot({ location: "cellar", events: [{ type: "output", text: "ok" }, null, 7], ui: {} });
assert(partial !== null, "a sparse snapshot still resumes");
assert(partial.location === "cellar", "a present field is used");
assert(partial.events.length === 1, "entries with no string `type` are dropped rather than rendered");
assert(partial.inventory.length === 0, "a missing inventory is empty, not undefined");
assert(partial.ui.hidden.size === 0, "a missing `hidden` is an empty Set");
assert(partial.ui.overrides !== null, "missing overrides are an object");
assert(partial.droppedEvents === 0, "a negative or non-numeric drop count is not trusted");
assert(fromSnapshot({ droppedEvents: -5 })?.droppedEvents === 0, "a negative drop count is not trusted");
assert(
  fromSnapshot({ droppedEvents: 2.7 })?.droppedEvents === 2,
  "a fractional drop count is floored, not rendered as a fraction",
);
assert(fromSnapshot({ inventory: [1, "coin", null] })?.inventory.join() === "coin", "inventory is string-only");
assert(
  fromSnapshot({ ui: { elements: [{ id: "meter" }, { type: "panel" }, null, { id: "" }] } })?.ui.elements.length === 1,
  "a UI element with no usable id is dropped, not cast into the renderer",
);
assert(
  fromSnapshot({ ui: { elements: [{ id: "meter" }], overrides: { panel: "not-an-object" } } })?.ui.overrides.panel ===
    undefined,
  "a malformed override entry is dropped rather than stored",
);

// A save that cannot be written back out is worse than a lossy one, so the one
// field the engine never reads is checked for representability on the way in.
const cyclic: Record<string, unknown> = { lines: ["hi"] };
cyclic.self = cyclic;
assert(fromSnapshot({ conversation: cyclic })?.conversation === null, "a cyclic conversation is dropped, not kept");
const bigint = { count: 1n } as unknown as Record<string, unknown>;
assert(fromSnapshot({ conversation: bigint })?.conversation === null, "a BigInt conversation is dropped, not kept");
assert(
  fromSnapshot({ conversation: { lines: ["kept"] } })?.conversation !== null,
  "an ordinary conversation survives the check",
);

// Element dedupe -----------------------------------------------------------

const deduped = dedupeUiElements([
  { id: "meter", type: "meter", accessibleLabel: "saved" },
  { id: "notes", type: "panel" },
  { id: "meter", type: "meter", accessibleLabel: "rebuilt by boot" },
]);
assert(deduped.length === 2, "a re-created element is collapsed to one");
assert(deduped[0].id === "meter", "the first position wins, so authored order is stable");
assert(deduped[0].accessibleLabel === "rebuilt by boot", "the last value wins, so the fresh element is used");

// Scenario identity --------------------------------------------------------

assert(hashScenario("a", "b") === hashScenario("a", "b"), "the hash is stable");
assert(hashScenario("a", "b") !== hashScenario("a", "c"), "the hash tracks the script");
assert(hashScenario("ab", "c") !== hashScenario("a", "bc"), "the parts cannot be shifted into one another");

// Export envelope ----------------------------------------------------------

const record: SaveRecord = {
  projectId: "lantern-below",
  slot: "manual",
  savedAt: 1_757_000_000_000,
  location: "stone_entry",
  scenarioVersion: "1.0.0",
  scenarioHash: "abc123",
  snapshot: toSnapshot(original),
};
const parsed = parseSaveFile(serializeSaveFile(record));
assert(parsed.projectId === "lantern-below", "the exported record keeps its project");
assert(parsed.scenarioHash === "abc123", "the exported record keeps its scenario identity");
assert(fromSnapshot(parsed.snapshot)?.location === "stone_entry", "the exported snapshot is readable");

throws(() => parseSaveFile("not json at all"), "not valid JSON", "a non-JSON file is refused");
throws(() => parseSaveFile('{"format":"something-else"}'), "not an Inkforge save", "a foreign format is refused");
throws(
  () => parseSaveFile('{"format":"inkforge-save","saveVersion":99,"record":{}}'),
  "newer version",
  "a save from a newer Inkforge is refused rather than half-read",
);
throws(
  () => parseSaveFile('{"format":"inkforge-save","saveVersion":1,"record":{}}'),
  "missing its game state",
  "an envelope with no snapshot is refused",
);
throws(() => parseSaveFile(`{"pad":"${"x".repeat(3_000_000)}"}`), "too large", "an oversized file is refused");

// A truncated record keeps the fields it has and defaults the rest, so a
// hand-edited save costs one value rather than the whole file.
const partialRecord = parseSaveFile(
  '{"format":"inkforge-save","saveVersion":1,"record":{"projectId":"p","snapshot":{"location":"cellar"}}}',
);
assert(partialRecord.projectId === "p", "a partial record keeps its project id");
assert(partialRecord.slot === "manual", "a missing slot defaults to the manual slot");
assert(partialRecord.savedAt === 0, "a missing timestamp is zero rather than NaN");
assert(fromSnapshot(partialRecord.snapshot)?.location === "cellar", "a partial snapshot is still readable");

assert(
  saveFileStem("Lantern Below!", 1_757_000_000_000) === "lantern-below-2025-09-04",
  "the export filename is slugged and dated",
);
assert(saveFileStem("...", 1_757_000_000_000) === "save-2025-09-04", "an unusable title still yields a filename");

console.log(`save-check: transcript cap (${MAX_EVENTS}), snapshot round-trip, envelope, tolerances — ok`);
