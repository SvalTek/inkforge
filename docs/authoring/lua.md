# Lua

Lua files can live in project folders. The entry file is `scenario.scripts.main`, defaulting to `scripts/main.lua`.
Every other `.lua` file in the project is available to `require`.

## Lifecycle

Three global functions are recognised, and all three are optional:

```lua
function OnInit()
  -- runs once, when the run starts
end

function Update(dt)
  -- runs every frame; dt is the elapsed time in SECONDS
end

function OnShutdown()
  -- runs when the runtime is torn down (restart, or a reload of the project)
end
```

`Update` runs on a fixed interval owned by the Lua runtime, not on the browser's animation frame. `dt` is in seconds, so
a speed of `120` units per second is `x = x + 120 * dt`.

Timers do **not** need `Update`: `timers.setInterval` runs on its own schedule. Use `Update` for something that must
advance every frame — a smooth oscillation, a countdown, a position that accumulates.

A fresh scenario start calls `OnInit` again. State is rebuilt from `player.state` at the same time, so a restart is a
genuine reset rather than a continuation.

## Saving and resuming

A save is a snapshot of run state, not of the runtime. It records where the player is, their inventory, state variables,
the transcript, and which tools and UI panels were open or hidden. It does **not** record the Lua VM, timers, animations
or canvas scenes — none of those survive a reload anyway.

The consequence for a script is the one that catches people out: **resuming runs `OnInit` again**, and the state it
builds is then covered by the save. So a top-level write on every boot is undone by the resume, and one guarded by a
check is not:

```lua
-- Wrong. A resume would set this back to false, discarding the saved value.
function OnInit()
  GameState.set('gate_open', false)
end

-- Right. A resume leaves the saved value alone.
function OnInit()
  if GameState.get('gate_open') == nil then
    GameState.set('gate_open', false)
  end
end
```

The same applies to `GameUI.create` and tool registration: anything the boot rebuilds is replaced by what the save
restored, so create it unconditionally and let the save win.

It applies to the entry directives of the location the save was made in, too. Resuming re-enters that location, so a
`give` in its `text:` runs again — but the save's own inventory is applied over the top of it. An item granted on
arrival and spent later in the run therefore stays spent: nothing a run consumed can come back on resume.

If you need something that genuinely must not be rebuilt, keep it in state — it is what a save is for.

## Requiring other files

```lua
local threshold = require("scripts/threshold")
```

Paths are relative to the project root, so they start with `scripts/`. A required file returns its table:

```lua
-- scripts/threshold.lua
local threshold = {}

function threshold.listen()
  GameOutput.add("Water moves somewhere beyond the stone.")
end

return threshold
```

## Scripts run before anything else

The body of the entry file executes once, at load. Top-level code is where scenes are composed and UI elements are
created — the starter template does exactly that, and defines `OnInit` only if it needs a later hook.

Because the top-level body runs first and functions are defined by assignment, a callback named as a string is resolved
**when it fires**, not when it is bound. That is what lets a node reference `"inspect_lantern"` before that function
appears further down the file.

## Namespaces

| Namespace | For |
|---|---|
| `GameOutput` | Writing to the transcript |
| `GameState` | Reading and writing state |
| `GameItems` | Reading item instances and authored definition data |
| `GameNPCs` | Reading NPC instances and authored NPC data |
| `GameUI` | Creating and changing UI elements |
| `GameTools` | The tool rail |
| `GameAudio` | Sound |
| `GameCanvas` | Scenes, nodes, animations |
| `timers` | `setTimeout`, `setInterval`, `clearAll`, `activeCount` |
| `json` | JSON encode/decode |
| `regex` | JavaScript regular expressions |
| `Events` | Named events between YAML and Lua |
| `js_*` | Value interop helpers |

All of them are read-only: assigning to `GameState.get` fails rather than silently replacing the host's API.

### `GameOutput`

```lua
GameOutput.add("The lantern gutters.")
```

One method. It prints a line to the terminal, exactly as a `text:` directive does. This is the way to show text —
`print` writes to the browser console, not to the game.

The string is markdown, under the same rule as `text:`: a one-line string renders inline, and a string containing a
newline renders as a full block, lists and all. See [Markdown](markdown.md).

### `GameState`

```lua
local oil = GameState.get("oil") or 0
GameState.set("oil", oil - 1)
```

A flat store shared with YAML. `get` returns `nil` for a key that has never been set, so `or 0` is the usual guard.
Setting a value repaints anything bound to it, which is why a meter can follow a timer with nothing else asking.

### `GameItems`

```lua
local item = GameItems.get("entry_lantern")
GameOutput.add(item.definition.inspect)

local lantern = GameItems.definition("lantern")
GameOutput.add(lantern.material)
```

`get(instanceId)` resolves an item instance and returns its `id`, its definition id as `def`, and its complete authored
`definition`. `definition(definitionId)` reads a definition directly. Either method returns `nil` when its id cannot be
resolved.

### `GameNPCs`

```lua
local npc = GameNPCs.get("passage_keeper")
GameOutput.add(npc.definition.name .. " tends " .. npc.definition.lamps .. " lamps.")

local trust = GameState.get("npc.passage_keeper.trust") or 0
```

The same shape as `GameItems`, for NPCs: `get(instanceId)` resolves an NPC **instance** and returns its `id`, the NPC id
it points at as `def`, and its authored `definition`; `definition(npcId)` reads an NPC directly. Both return `nil` when
the id cannot be resolved, and both hand you a detached copy, so changing what you get back cannot alter the scenario.

Only the authored half lives here. An NPC's **current values are state**, not data, so read them with `GameState` using
the same `npc.<instance-id>.<path>` key that `npcVar` and `npcSet` use. See [NPCs](npcs.md).

Definitions include the standard `name`, `description`, `aliases`, and `actions` fields plus any custom YAML fields the
author added. Returned definitions are detached copies: Lua can reshape a local result, but doing so does not modify the
composed scenario or a later lookup. Use `GameState` or `itemSet` for data that should change during play.

### `GameUI`

```lua
GameUI.create({
  id = "focus",
  type = "meter",
  location = "hud",
  fields = {
    { id = "label", type = "text", value = "Focus" },
    { id = "value", type = "state", path = "focus" },
    { id = "max", type = "state", path = "focusMax" }
  }
})

GameUI.show("focus")
GameUI.hide("focus")
GameUI.set("focus", { fields = { value = 2 } })
GameUI.remove("focus")
```

The same element shape as `ui.yml`, written as a Lua table. See [UI](ui.md).

### `GameTools`

```lua
GameTools.register({ id = "lua_tool", label = "Lua tool", icon = "⚙", action = "open_lua_panel" })
GameTools.hide("lua_tool")
GameTools.show("lua_tool")
GameTools.disable("map_tool")
GameTools.enable("map_tool")
GameTools.remove("lua_tool")
```

See [Tools](tools.md).

### `GameAudio`

```lua
local theme = GameAudio.play("assets/theme.mp3", { loop = true, volume = 0.5 })
GameAudio.stop(theme)
```

See [Audio](audio.md).

### `timers`

Milliseconds, not seconds:

```lua
local id = timers.setInterval(function()
  GameState.set("charge", (GameState.get("charge") or 0) - 1)
end, 120)

timers.clearInterval(id)
timers.setTimeout(function() GameOutput.add("...") end, 900)
timers.clearAll()
local n = timers.activeCount()
```

Timers are owned by the runtime. They are cleaned up when it shuts down, so a restart does not leave the previous run's
intervals ticking. **An interval whose callback throws is stopped automatically**, rather than erroring on every tick —
which makes a faulty timer fail visibly once instead of flooding.

`clearTimeout` and `clearInterval` are both available, and each cancels only its own kind of id: `clearInterval` on a
timeout's id, or `clearTimeout` on an interval's, is silently a no-op. Keep the id and the call matched — a mistyped
pair leaves a timer running with nothing left holding its id.

### `json`

```lua
local text = json.stringify({ a = 1 })   -- '{"a":1}'
local value = json.parse(text)

json.encode(value)   -- alias of stringify
json.decode(text)    -- alias of parse
```

Useful for inspecting a structure you are unsure of — `GameOutput.add(json.stringify(GameState.get("inventory")))`.

### `regex`

JavaScript regular expressions, not Lua patterns. Note the reversed argument order relative to Lua's `string` library:
the **string comes first**.

```lua
regex.test("hello world", "^hello")                   -- true
regex.match("a@b", "(\\w+)@(\\w+)")                   -- {"a@b", "a", "b"}
regex.replace("hello world", "world", "JS")           -- "hello JS"
regex.replaceAll("hello world", "o", "x")             -- "hellx wxrld"
regex.split("a, b, c", ", ")                          -- {"a", "b", "c"}
```

`match` returns the whole match first, then its captures, or `nil` when there is no match.

### `Events`

```lua
Events:On("door:opened", function(data)
  GameOutput.add("The door swings open.")
end)

Events:Off("door:opened", handler)
Events:Emit("custom:event", { key = "value" })
```

`Events:On` is how a script listens for an `emit:` from YAML, and for the canvas bus event `canvas:event` (which the
canvas router already subscribes to — you rarely handle it directly). `Events:Emit` lets a script raise its own event for
other listeners.

Because a listener list cannot be enumerated, an `emit:` that reaches nobody is reported the first time it fires rather
than being caught at boot.

### Item action context

Definition-level inventory actions are shared, but each invocation carries the selected instance. A `call:` handler
receives it after params, and an `emit:` listener receives it after data:

```lua
function lantern.light(params, context)
  GameOutput.add("Lighting " .. context.item.id)
end

Events:On("lantern:lit", function(data, context)
  GameOutput.add(context.item.definitionId .. ":" .. context.item.actionId)
end)
```

The item context has three fields: `id` is the concrete instance, `definitionId` is its shared definition, and
`actionId` is the invoked definition action. It is transient invocation information, not saved state. Calls and events
from locations, UI elements and tools omit this second argument. Each handler receives a detached context, so changing
it inside Lua does not alter the item subject retained by the engine or the context given to the next handler.

### Value interop

Lua has one table type; JavaScript does not. These helpers tell you which side a value came from:

| Function | Returns |
|---|---|
| `js_type(value)` | `"array"`, `"map"`, `"set"`, or the JavaScript `typeof` |
| `js_len(value)` | Length of a string or array, or key count of an object |
| `js_true()` | `true` |
| `js_null(value)` | Whether the value is a JavaScript `null` — see below |

`js_type` matters because a JS array and a Lua table are used differently:

```lua
local items = GameState.get("someList")
if js_type(items) == "array" then
  -- JavaScript array methods are available and are often clearer
  -- than iterating, e.g. items:includes(...) rather than a manual loop
end
```

`js_type` reports the JavaScript `typeof`, so a JavaScript object reads as `"object"` where Lua's own `type()` reads
`"userdata"`. Either way the value carries JavaScript methods; a plain Lua table has only what Lua gives you. A missing
value reads as `"object"` as well, because `typeof null` is `"object"` — use `== nil`, not `js_type`, to detect one.

### Testing for null

`js_null` is a predicate, and the `=== null` it performs happens on the JavaScript side of the boundary: Lua has no
literal that stands for a JavaScript `null`, so there is nothing on this side to compare against. The crossing itself is
not lossy — a JavaScript `null` arrives in Lua as a **userdata**, not as `nil` — so the test is meaningful:

```lua
local value = GameState.get("note")
if value ~= nil and js_null(value) then
  -- strictly a JavaScript null, not a key that was never set
end
```

The `~= nil` guard is what makes it strict. A Lua `nil` is marshalled to JavaScript as `null` when it is passed back, so
`js_null(nil)` answers `true` as well: on its own, `js_null` means "null or missing", not "null".

And because a JavaScript `null` arrives as userdata, it is **truthy**. `GameState.get("note") or 0` does not fall
through to the `0` for a stored `null`, where a key that was never set does — `js_null` is the check that catches it.

## Errors

A Lua error is reported, not swallowed:

- An error while loading a script fails the boot, and the message appears in the diagnostics line.
- An error inside `Update` or a timer callback is caught by the runtime and reported as it happens.

An error in a `call:` from YAML is reported with the failed function's name. A `call:` naming a function that does not
exist is caught at boot, before the scenario plays at all:

```
Missing Lua functions: cellar.arive (locations.cellar.text.0.call)
```

The path in brackets points at the directive that referenced it.
