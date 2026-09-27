# Directives

A **directive** is one instruction. It is either a plain string or a mapping. Directives appear wherever the engine runs
a list of things: location text, an action's `then:`, a UI element's activation `then:`, and the `then`/`else` arms of a
conditional.

```yaml
text:
  - "The door is ajar."        # a string directive: prints a line
  - set: { sawDoor: true }     # a mapping directive: does something
```

A list may also be written as a single directive, so these are equivalent:

```yaml
text: "You are in a cellar."
text:
  - "You are in a cellar."
```

## The recognised keys

| Key | Effect |
|---|---|
| `text` | Print a line to the transcript |
| `set` | Assign one or more state paths |
| `itemSet` | Assign state belonging to the current inventory item instance |
| `npcSet` | Assign state belonging to NPC instances, keyed `<instance-id>.<path>` |
| `inc` | Add to a numeric state path |
| `dec` | Subtract from a numeric state path |
| `give` | Put an item into the inventory |
| `remove` | Take an item out of the inventory |
| `goto` | Move to a location and run its text |
| `ui` | Apply a UI command (create/set/show/hide/remove) |
| `if` | Run `then` or `else` depending on a condition |
| `call` | Call a named Lua function |
| `emit` | Emit a named event to Lua listeners |
| `end` | End the game |

Anything else is rejected at load time with `unrecognised directive [...] — nothing will happen`. The check exists
because the alternative — a typo'd key that is quietly ignored — is the hardest kind of mistake to find.

## Evaluation order — read this before combining keys

A mapping directive is tested **key by key, in a fixed order**, and the first match wins:

```
text → set → itemSet → npcSet → inc/dec → give → remove → goto → ui → call → emit → if → end
```

The consequence that catches people out: **`if` is only consulted if none of the earlier keys are present.** So this
does *not* guard the assignment —

```yaml
- if: { var: doorOpen, eq: true }   # ✗ the `set` is tested first and runs unconditionally
  set: { sawDoor: true }
```

Wrap it instead, using `then` as the body:

```yaml
- if: { var: doorOpen, eq: true }   # ✓
  then:
    - set: { sawDoor: true }
```

One directive, one job. That rule also makes the order above predictable rather than something you have to memorise.

## `text`

Prints a line to the transcript. Authored prose is markdown, so `**bold**` and `` `code` `` render — but raw HTML stays
literal, and angle brackets and quotes are safe.

A one-line string renders inline; a string containing a newline renders as full markdown, which is what a `|` block
scalar gives you:

```yaml
- text: "The lantern **gutters**."
- text: |
    The note lists what to carry:
    - a stub of candle
    - a bent nail
```

The second prints a real list. The first cannot: a prose line beginning with `-` is still prose, because a one-line
string is never parsed as a block. See [Markdown](markdown.md).

## `set`

Assigns state. The value can be any YAML scalar, list or mapping.

```yaml
- set:
    seenLantern: true
    courage: 3
```

State paths are flat keys. `set` is the same store Lua's `GameState.set` writes to, so a value set in YAML is visible
to a script and vice versa.

## `itemSet`

Assigns state to the concrete inventory item whose definition action is running:

```yaml
- itemSet:
    lit: true
    oil: 100
```

For an instance called `cellar_lantern`, those become the flat keys `item.cellar_lantern.lit` and
`item.cellar_lantern.oil`. The writes use the normal state mutation path, so they repaint immediately and are included in
saves. `itemSet` is valid only inside `definitions.item.<id>.actions[]` and nested directive lists belonging to those
actions. Its value must be a YAML mapping; scalar and list payloads fail validation. Other sites fail validation because
they have no current item.

`itemSet` assigns fixed values. There are no `itemInc` or `itemDec` directives yet; use Lua when an item-local number
must be changed relative to its current value.

## `npcSet`

Assigns state to one or more NPC instances, with each key written `<instance-id>.<value>`:

```yaml
- npcSet:
    passage_keeper.trust: 3
    passage_keeper.lampsLit: 0
```

Those become the flat keys `npc.passage_keeper.trust` and `npc.passage_keeper.lampsLit` — the same store `set:` writes
to, and the same one `npcVar` reads. Values seeded from an NPC definition's `state:` block are already there unless
something overwrote them; see [NPCs](npcs.md).

Unlike `itemSet`, this needs no current item, because every key names its own instance. It is therefore valid anywhere a
directive list runs, and one directive can write several NPCs at once.

The value must be a YAML mapping, and **every key is qualified** — a bare `lampsLit: 0` is an error, not a shorthand,
because there is no NPC for it to belong to. A key with no dot in it, or one naming an instance that does not exist, is
rejected at load; a key that somehow reaches the engine anyway reports
`npcSet key must be <npc-instance>.<value>, got: <key>` rather than writing nothing.

There is no `npcInc`/`npcDec`. `inc` already takes a full path, so a value that moves by an amount needs no new
directive:

```yaml
- inc: { var: npc.passage_keeper.lampsLit, by: 1 }
```

## `inc` / `dec`

Adds to or subtracts from a numeric state path. An absent path counts as `0`, so `inc` on a fresh variable starts it at
`1`.

```yaml
- inc: { var: courage, by: 2 }
- dec: { var: oil }
```

Two shorthands are accepted:

```yaml
- inc: courage          # by 1
- inc: { courage: 2 }   # by 2
```

Values are coerced with `Number(...)`, so a non-numeric state value becomes `NaN`. Keep numeric state numeric.

## `give` / `remove`

Moves an item into or out of the inventory. `give` is idempotent — giving an item already held does nothing and emits
no event. `remove` on an item not held is harmless.

```yaml
- give: brassLantern
- remove: { id: brassLantern }
```

The inventory holds 12 slots in the play UI. That is a display limit, not an engine limit.

## `goto`

Moves to a location **and runs that location's `text`**. This is the directive behind every exit, and it is why
entering a location by any route produces the same prose.

```yaml
- goto: cellar
```

An unknown location prints `Unknown location: <id>` as an error and moves nowhere.

## `ui`

Applies a UI command. This is the same surface Lua's `GameUI` uses.

```yaml
- ui:
    show: secretPanel
- ui:
    hide: secretPanel
- ui:
    set:
      lanternMeter: { fields: { value: 2 } }
- ui:
    remove: secretPanel
- ui:
    create:
      id: rewardBanner
      type: text
      location: output
      fields:
        - { id: text, type: text, value: "You won." }
```

See [UI elements](ui.md) for the element shape and the regions each type is allowed in.

## `call`

Calls a named Lua function, optionally with `params`.

```yaml
- call: cellar.arrive
  params: { from: "stairs", quiet: true }
```

The name is a dot-delimited path into Lua globals, so `cellar.arrive` means `cellar.arrive` in Lua — a function on a
table called `cellar`. Every `call:` in the project is checked against the loaded script at boot; a name that does not
resolve to a function is reported as `Missing Lua functions: ... (path)` in the diagnostics line rather than failing
silently at the moment it is reached.

Params arrive as the function's first argument:

```lua
function cellar.arrive(params)
  if params.quiet then return end
  GameOutput.add("The cellar smells of wet stone.")
end
```

When the call runs inside an inventory item action, the concrete item is available as an optional second argument:

```lua
function lantern.light(params, context)
  GameOutput.add("Lighting " .. context.item.id)
end
```

`context.item` contains `id`, `definitionId` and `actionId`. Calls from sites without an explicit subject omit the
second argument, so existing one-argument handlers continue to work.

The call is awaited, so directives after it run after it has finished.

## `emit`

Emits a named event that any number of Lua listeners can subscribe to with `Events:On`.

```yaml
- emit: door:opened
  data: { location: cellar }
```

**`call` or `emit`?** Use `call` when exactly one known handler should run — a scripted reaction to a specific moment.
Use `emit` when the content should not know or care who is listening, so several systems (audio, HUD, achievements) can
react to the same moment without the YAML naming any of them.

`emit` cannot be checked at boot, because `Events:On` offers no way to enumerate listeners. Instead, an emit that
reaches nobody is reported the first time it fires: `Event 'door:opened' was emitted but nothing is listening for it.`
That is a warning, not an error — an unhandled event is legal.

An event emitted by an inventory item action passes the same optional execution context after its data:

```lua
Events:On("item:inspected", function(data, context)
  GameOutput.add("Inspected " .. context.item.id)
end)
```

## `if` / `then` / `else`

Runs one arm or the other. `then` and `else` are themselves directive lists, so conditionals nest.

```yaml
- if: { hasItem: brassLantern }
  then:
    - text: "The lantern light reveals a hatch."
  else:
    - text: "It is too dark to search."
```

`else` is optional; with no `else`, a false condition does nothing.

## `end`

Ends the game. Sets the run to over and emits `game:over`; the remaining choices are dropped from the play view.

```yaml
- text: "You step through, and the door closes behind you."
- end: true
```

Once `end` has run, further commands and inventory actions are ignored until the run is restarted. An open inventory
inspector removes its action buttons when the run ends.
