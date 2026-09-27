/**
 * The authored Lua API, as data.
 *
 * Two readers depend on this file, which is why it is flat data with no
 * imports:
 *
 * - `src/editor/lua-assist.ts` turns it into completion and hover, so an author
 *   sees what exists with a description, rather than guessing.
 * - `tools/manifest-check.ts` resolves every entry against a live bridge, so a
 *   name the editor offers that the runtime does not actually have cannot ship.
 *
 * Sources, in order of authority: `src/lua/bindings.ts` (the `LuaClass`
 * namespaces), `src/lua/facades/canvas.ts` (`GameCanvas` and its handles),
 * `src/app/boot.ts` (lifecycle), and the bridge's own binding modules for
 * `timers`/`json`/`regex`/`js_*`. Summaries are one line each and deliberately
 * say the same thing as `docs/authoring/` — the popup and the manual should not
 * disagree.
 */

/** One callable in the authored API. */
export interface LuaApiEntry {
  /** The name as written in Lua. */
  name: string;
  /**
   * The argument list as the docs write it, without the name: `(text)`. Kept
   * separate from {@link signature} so a member can be qualified by whichever
   * namespace it is completed under.
   */
  args: string;
  /** One line, shown in the popup and on hover. */
  summary: string;
  /**
   * A snippet the editor inserts in place of the bare name, for the few entries
   * where `name(${})` is not useful. `${}` marks a tab stop.
   */
  template?: string;
}

/** A global namespace and the members reached through it. */
export interface LuaApiNamespace {
  name: string;
  /**
   * How members are reached. `.` for a host `LuaClass` (a plain table read);
   * `:` for the Lua-defined `Events`, whose methods take an implicit self.
   */
  call: "." | ":";
  /** One line, shown when the namespace itself is completed or hovered. */
  summary: string;
  members: readonly LuaApiEntry[];
}

/** A handle `GameCanvas` returns, and the methods it carries. */
export interface LuaHandleApi {
  /** Which handle a `GameCanvas` call hands back. */
  kind: "scene" | "node" | "animation";
  /** How an author gets one, for the hover text. */
  obtainedBy: string;
  summary: string;
  members: readonly LuaApiEntry[];
}

/** The host namespaces, in the order the docs list them. */
export const LUA_API_MANIFEST: readonly LuaApiNamespace[] = [
  {
    name: "GameOutput",
    call: ".",
    summary: "Writing to the transcript.",
    members: [
      {
        name: "add",
        args: "(text)",
        summary:
          "Print a line to the terminal, exactly as a `text:` directive does. The string is markdown: inline for a one-liner, a full block if it contains a newline. `print` goes to the console.",
      },
    ],
  },
  {
    name: "GameState",
    call: ".",
    summary: "Reading and writing state.",
    members: [
      {
        name: "get",
        args: "(path)",
        summary: "Read a state value. `nil` for a key that has never been set, so guard with `or 0`.",
      },
      {
        name: "set",
        args: "(path, value)",
        summary: "Write a state value. Setting repaints anything bound to it.",
      },
    ],
  },
  {
    name: "GameItems",
    call: ".",
    summary: "Reading item instances and their authored definition data.",
    members: [
      {
        name: "get",
        args: "(instanceId)",
        summary: "Resolve an item instance to its id, definition id, and a detached copy of its definition.",
      },
      {
        name: "definition",
        args: "(definitionId)",
        summary: "Read a detached copy of an item definition by definition id.",
      },
    ],
  },
  {
    name: "GameNPCs",
    call: ".",
    summary: "Reading NPC instances and their authored definition data.",
    members: [
      {
        name: "get",
        args: "(instanceId)",
        summary: "Resolve an NPC instance to its id, definition id, and a detached copy of its definition.",
      },
      {
        name: "definition",
        args: "(npcId)",
        summary: "Read a detached copy of an NPC by npc id.",
      },
    ],
  },
  {
    name: "GameConversations",
    call: ".",
    summary: "Starting and ending a conversation.",
    members: [
      {
        name: "start",
        args: "(conversationId)",
        summary: "Enter a conversation at its `start` node. The same call a `talk:` directive makes.",
      },
      {
        name: "finish",
        args: "()",
        summary:
          "End the conversation the player is in, if any. Safe to call when none is. Not named `end`, which is a Lua keyword.",
      },
    ],
  },
  {
    name: "GameUI",
    call: ".",
    summary: "Creating and changing UI elements.",
    members: [
      {
        name: "create",
        args: "(element)",
        summary: "Create a UI element from a table — the same shape as `ui.yml`.",
        template:
          '{\n  id = "${1:panel}",\n  type = "panel",\n  location = "hud",\n  fields = {\n    { id = "label", type = "text", value = "${2:Label}" }\n  }\n}',
      },
      {
        name: "set",
        args: "(id, properties)",
        summary: "Merge properties onto an element that already exists.",
        template: '("${1:panel}", { fields = { value = ${2:0} } })',
      },
      { name: "show", args: "(id)", summary: "Show a hidden element." },
      { name: "hide", args: "(id)", summary: "Hide an element without removing it." },
      { name: "remove", args: "(id)", summary: "Remove an element for good." },
    ],
  },
  {
    name: "GameTools",
    call: ".",
    summary: "The tool rail.",
    members: [
      {
        name: "register",
        args: "(definition)",
        summary: "Add a tool to the rail. `action` names the Lua function it calls.",
        template: '({ id = "${1:tool}", label = "${2:Tool}", icon = "⚙", action = "${3:open_tool}" })',
      },
      { name: "remove", args: "(id)", summary: "Remove a tool from the rail." },
      { name: "show", args: "(id)", summary: "Show a tool that was hidden." },
      { name: "hide", args: "(id)", summary: "Hide a tool without unregistering it." },
      { name: "enable", args: "(id)", summary: "Enable a tool that was disabled." },
      { name: "disable", args: "(id)", summary: "Disable a tool, greying it out." },
    ],
  },
  {
    name: "GameAudio",
    call: ".",
    summary: "Sound.",
    members: [
      {
        name: "play",
        args: "(path, options)",
        summary: "Play an asset path. `options` takes `id`, `loop` and `volume`; returns the playback id.",
        template: '("${1:assets/theme.mp3}", { loop = ${2:true}, volume = ${3:0.5} })',
      },
      { name: "stop", args: "(id)", summary: "Stop a playback and release it." },
      { name: "pause", args: "(id)", summary: "Pause a playback where it is." },
      { name: "resume", args: "(id)", summary: "Resume a paused playback." },
      { name: "setVolume", args: "(id, value)", summary: "Set a playback's volume, `0` to `1`." },
      { name: "setLoop", args: "(id, value)", summary: "Turn looping on or off for a playback." },
      { name: "stopAll", args: "()", summary: "Stop every playback." },
    ],
  },
  {
    name: "GameCanvas",
    call: ".",
    summary: "Scenes, nodes, animations.",
    members: [
      {
        name: "create",
        args: "(spec)",
        summary: "Create a scene and return its handle. Its canvas appears in the canvas region automatically.",
        template:
          '{\n  id = "${1:scene}",\n  viewport = { width = 960, height = 720, fit = "contain" },\n  nodes = {\n    { id = "${2:node}", type = "rect", x = 400, y = 300, width = 80, height = 80, fill = "${3:#b87336}" }\n  }\n}',
      },
      {
        name: "node",
        args: "(scene_id, node_id)",
        summary: "A handle to a node that already exists in a scene.",
      },
    ],
  },
  {
    name: "timers",
    call: ".",
    summary: "Timers, in milliseconds rather than seconds.",
    members: [
      {
        name: "setTimeout",
        args: "(callback, delay)",
        summary: "Run a function once, after `delay` milliseconds. Returns the timer id.",
        template: "(function()\n  ${}\nend, ${1:900})",
      },
      {
        name: "setInterval",
        args: "(callback, interval)",
        summary:
          "Run a function every `interval` milliseconds. An interval whose callback throws is stopped rather than flooding.",
        template: "(function()\n  ${}\nend, ${1:120})",
      },
      { name: "clearTimeout", args: "(id)", summary: "Cancel a timer. Either clear function works on either kind." },
      {
        name: "clearInterval",
        args: "(id)",
        summary: "Cancel an interval. Either clear function works on either kind.",
      },
      { name: "clearAll", args: "()", summary: "Cancel every pending timer." },
      { name: "activeCount", args: "()", summary: "How many timers are pending." },
    ],
  },
  {
    name: "json",
    call: ".",
    summary: "JSON encode and decode.",
    members: [
      { name: "stringify", args: "(value)", summary: "Encode a value to JSON text." },
      { name: "parse", args: "(text)", summary: "Decode JSON text. Throws on malformed input." },
      { name: "encode", args: "(value)", summary: "Alias of `stringify`." },
      { name: "decode", args: "(text)", summary: "Alias of `parse`." },
    ],
  },
  {
    name: "regex",
    call: ".",
    summary: "JavaScript regular expressions, not Lua patterns.",
    members: [
      {
        name: "match",
        args: "(string, pattern)",
        summary: "The whole match then its captures, or `nil`. Note the string comes first.",
      },
      { name: "test", args: "(string, pattern)", summary: "Whether the pattern matches. Note the string comes first." },
      {
        name: "replace",
        args: "(string, pattern, replacement)",
        summary: "Replace the first match. Note the string comes first.",
      },
      {
        name: "replaceAll",
        args: "(string, pattern, replacement)",
        summary: "Replace every match. Note the string comes first.",
      },
      { name: "split", args: "(string, pattern)", summary: "Split on a pattern. Note the string comes first." },
    ],
  },
  {
    name: "Events",
    call: ":",
    summary: "Named events between YAML and Lua.",
    members: [
      {
        name: "On",
        args: "(event, handler)",
        summary: "Listen for an `emit:` from YAML, or for `canvas:event`.",
        template: '("${1:door:opened}", function(payload)\n  ${}\nend)',
      },
      { name: "Off", args: "(event, handler)", summary: "Stop listening. The handler must be the same function." },
      {
        name: "Emit",
        args: "(event, payload)",
        summary: "Raise your own event for other listeners. An `emit:` that reaches nobody is reported.",
        template: '("${1:custom:event}", { key = "value" })',
      },
    ],
  },
];

/** The bridge's bare globals — `_G` functions, no namespace. */
export const LUA_GLOBAL_FUNCTIONS: readonly LuaApiEntry[] = [
  {
    name: "js_type",
    args: "(value)",
    summary:
      'The value\'s JavaScript type: `"array"`, `"map"`, `"set"`, or a `typeof`. A Lua table has none of those, and a missing value reads as `"object"`.',
  },
  { name: "js_len", args: "(value)", summary: "Length of a string or array, or key count of an object." },
  { name: "js_true", args: "()", summary: "Returns `true`. Useful where a Lua truthiness check needs a JS value." },
  {
    name: "js_null",
    args: "(value)",
    summary:
      "Whether a value is JavaScript `null`. A Lua `nil` answers `true` as well, so pair it with `value ~= nil`.",
  },
];

/**
 * The lifecycle functions, which are the author's to define — nothing installs
 * them, so they are the one group no drift guard can resolve.
 */
export const LUA_LIFECYCLE: readonly LuaApiEntry[] = [
  {
    name: "OnInit",
    args: "()",
    summary: "Runs once when the run starts. A restart calls it again, with state rebuilt from `player.state`.",
    template: "function OnInit()\n  ${}\nend",
  },
  {
    name: "Update",
    args: "(dt)",
    summary: "Runs every frame; `dt` is elapsed seconds, so 120 units per second is `x = x + 120 * dt`.",
    template: "function Update(dt)\n  ${}\nend",
  },
  {
    name: "OnShutdown",
    args: "()",
    summary: "Runs when the runtime is torn down — a restart, or a reload of the scenario.",
    template: "function OnShutdown()\n  ${}\nend",
  },
];

/**
 * Event names that exist without the author inventing them.
 *
 * Only the canvas bus so far: an `emit:` otherwise names something the author
 * defined themselves, which no list can know.
 */
export const LUA_EVENT_NAMES: readonly LuaApiEntry[] = [
  {
    name: "canvas:event",
    args: "",
    summary: "One per pointer interaction on a node; carries `sceneId`, `nodeId`, `type` and the pointer coordinates.",
  },
];

/** Handle surfaces, reached from a value `GameCanvas` returned. */
export const LUA_CANVAS_HANDLES: readonly LuaHandleApi[] = [
  {
    kind: "scene",
    obtainedBy: "GameCanvas.create(spec)",
    summary: "A live scene on the host, not a local copy.",
    members: [
      { name: "add", args: "(node)", summary: "Add a node to the scene and return its handle." },
      { name: "node", args: "(id)", summary: "A handle to a node already in the scene." },
      { name: "clear", args: "()", summary: "Remove every node. The scene itself stays." },
      { name: "remove", args: "()", summary: "Remove the scene, and its canvas from the screen." },
    ],
  },
  {
    kind: "node",
    obtainedBy: "scene:add(node) or scene:node(id)",
    summary: "A live node on the host. Every method but the readers chains.",
    members: [
      { name: "set", args: "(values)", summary: "Merge a table of fields onto the node. The host is authoritative." },
      { name: "translate", args: "(dx, dy)", summary: "Move by an offset." },
      { name: "move_to", args: "(x, y)", summary: "Move to an absolute position." },
      {
        name: "rotate_by",
        args: "(degrees)",
        summary: "Rotate relative to the handle's mirror, not the node's live rotation.",
      },
      { name: "rotate_to", args: "(degrees)", summary: "Rotate to an absolute angle." },
      { name: "scale_to", args: "(scale)", summary: "Scale to an absolute factor." },
      { name: "set_opacity", args: "(opacity)", summary: "Set opacity, `0` to `1`." },
      { name: "show", args: "()", summary: "Set `visible = true`." },
      { name: "hide", args: "()", summary: "Set `visible = false`." },
      { name: "x", args: "()", summary: "The mirror's x, `0` until the handle has set something." },
      { name: "y", args: "()", summary: "The mirror's y, `0` until the handle has set something." },
      { name: "is_visible", args: "()", summary: "The mirror's visibility, true unless it was set false." },
      { name: "set_interactive", args: "(enabled)", summary: "Whether the node takes pointer input." },
      {
        name: "on",
        args: "(event, callback)",
        summary: "Bind an event (`activate`, `pointer_enter`, `drag`, …) to a callback or a function name.",
        template: '("${1:activate}", "${2:inspect_node}")',
      },
      { name: "off", args: "(event)", summary: "Unbind an event." },
      {
        name: "tween",
        args: "(values, options)",
        summary: "Animate to values over time. Returns an animation handle. Only numbers interpolate.",
        template: "({ ${1:opacity} = ${2:0.4} }, { duration = ${3:0.3} })",
      },
      {
        name: "animate",
        args: "(keyframes, options)",
        summary: "Animate through keyframes, each `{ at = 0..1, ... }`. Returns an animation handle.",
        template: "({ { at = 0, x = ${1:100} }, { at = 1, x = ${2:400} } }, { duration = ${3:2.4} })",
      },
      { name: "remove", args: "()", summary: "Remove the node from its scene." },
    ],
  },
  {
    kind: "animation",
    obtainedBy: "node:tween(values, options) or node:animate(keyframes, options)",
    summary: "A running animation. Nothing else needs to drive it.",
    members: [
      { name: "pause", args: "()", summary: "Hold the animation where it is." },
      { name: "resume", args: "()", summary: "Continue a paused animation." },
      { name: "cancel", args: "()", summary: "Stop without reaching the end value." },
      { name: "finish", args: "()", summary: "Jump to the end value, then stop." },
    ],
  },
];
