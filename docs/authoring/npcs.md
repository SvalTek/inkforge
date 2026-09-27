# NPCs

An NPC is a person in your world: Elder Rowan, the innkeeper, the woman who will not sell you anything. Inkforge
gives an NPC a top-level key, a place in the world, and a set of values that change as the story goes on.

```yaml
# npcs.yml
keeper:
  name: The Keeper
  description: A stooped figure who tends the lamps along the passage.
  portrait: assets/portraits/keeper.svg
  role: lampkeeper
  lamps: 7
  state:
    trust: 2
    lampsLit: 0
```

```yaml
# scenario.yaml
npcs: !import npcs.yml
```

## Authored data and current values

An NPC splits the same way an item does, and the split is the whole point.

**Authored data** is what the NPC *is*, and never changes:

```yaml
keeper:
  name: The Keeper
  role: lampkeeper     # whatever else you want to record
  lamps: 7
```

**Current values** are what the story has *done* to them, and live in ordinary state under
`npc.<instance-id>.<path>`:

```yaml
npc.passage_keeper.trust
npc.passage_keeper.lampsLit
```

`state:` on the definition holds the **defaults** for those values. Every instance of that NPC starts from them:

```yaml
state:
  trust: 2
  lampsLit: 0
```

Defaults sit at the bottom of the boot merge, so anything can override one: top-level `state`, a `set:` directive, or a
save you resume. A default is a starting point, not a lock.

| Field | Purpose |
|---|---|
| `name` | Display name |
| `description` | A longer description, free prose |
| `portrait` | Project-relative path to a portrait asset — see [below](#portraits) |
| `state` | Default values for every instance, as a mapping |
| anything else | Author-defined metadata, read from Lua and never mutated |

`name` and `description` must be strings and `state` must be a mapping; all three are checked at load.

## An NPC is not present until an instance places it

Nothing in `npcs:` puts anyone anywhere. An NPC becomes part of the world through an **instance**, exactly as an item
definition needs one to be lying in a room:

```yaml
# instances.yml
npc:
  passage_keeper:
    def: keeper
```

The instance is the Keeper *in the narrow passage*. A location lists **instance ids**, in its `npcs:` field, the same way
`items` lists item instance ids:

```yaml
# locations.yml
passage:
  title: Narrow Passage
  text:
    - "A stooped figure works a lamp along the far wall."
  npcs: [passage_keeper]
```

Four rules are checked when the project loads, and each is an error rather than a shrug:

- an `instances.npc` entry must name a `def` that exists in `npcs:`
- a location's `npcs:` entry must be an NPC instance that exists in `instances.npc`
- `portrait`, if present, must be a project asset path
- **an instance id must not contain a `.`** — see below

The id is the left side of `<instance-id>.<value>`, and that dot is the only thing separating the two halves, so an id
carrying one could be listed, seeded and read through `GameNPCs` while never being reachable from `npcVar` or `npcSet`.
`court.keeper` would be read as the instance `court` with a value named `keeper.trust`. Use `court_keeper`.

NPC **definition** ids have no such restriction: they are only ever exact lookups, never parsed.

Nothing checks that a conversation or a script is talking to an NPC who is *actually standing there* — that is yours to
arrange, and it is what makes a scripted scene possible.

## Reading and writing an NPC's values

`npcVar` and `npcSet` work on a named instance, written `<instance-id>.<value>`:

```yaml
actions:
  - id: ask_keeper
    label: Ask the keeper about the lamps
    then:
      - npcSet: { passage_keeper.trust: 3, passage_keeper.lampsLit: 0 }

  - id: ask_which_lamp
    label: Ask which lamp is broken
    if:
      npcVar: passage_keeper.trust
      gte: 3
    then:
      - "The third one. Don't lean on it."
```

`npcSet` assigns and `npcVar` reads, both against the same store `set:` and `var:` use. Because each names its own
instance, neither needs a current subject: they are valid **anywhere** — a location action, a UI element, a tool, an item
action — with no requirement that an NPC be "the one you are talking to". One `npcSet` can write several NPCs at once.

`inc` and `dec` already reach the same keys, so a value that moves by an amount needs no new directive:

```yaml
- inc: { var: npc.passage_keeper.lampsLit, by: 1 }
```

See [Conditions](conditions.md#npcvar) and [Directives](directives.md#npcset).

## Portraits

`portrait` records which asset belongs to an NPC. **Inkforge never draws it.** There is no portrait panel, and no
requirement that your scenario render one — a game of pure text can carry the key and ignore it.

The value is in the authoring: one name in one place, so a canvas scene or a UI element can refer to
`keeper.portrait` instead of a path repeated in three files, and so renaming the asset is a one-line change. A scenario
that draws a portrait in a canvas scene reads the authored data from Lua:

```lua
local npc = GameNPCs.get("passage_keeper")
-- npc.definition.portrait == "assets/portraits/keeper.svg"
```

## Lua

`GameNPCs` reads the authored half. The current values are state, so `GameState` reads those:

```lua
local npc = GameNPCs.get("passage_keeper")
GameOutput.add(npc.definition.name .. " tends " .. npc.definition.lamps .. " lamps.")

local trust = GameState.get("npc.passage_keeper.trust") or 0
```

See [`GameNPCs`](lua.md#gamenpcs).

## Saving

An NPC's current values are ordinary state, so they are included in a save and restored on resume, with no extra
handling. The defaults are re-applied underneath a resumed run, so an NPC introduced since the save still starts from
its definition.

## Talking to them

An NPC on its own does not speak. To give one something to say, write a
[conversation](conversations.md): its `speaker` and `participants` name NPC
*instances*, and a `talk:` directive starts it.

```yaml
conversations:
  keeper_greeting:
    participants: [player, passage_keeper]
    start: greeting
    nodes:
      greeting:
        dialogue:
          - { speaker: passage_keeper, text: "You carry a lantern." }
```

Nothing stops a conversation naming an NPC who is not in the room. That is on purpose:
presence is authored and never enforced, so a script can talk to anybody, and a
conversation can be reached from a timer or a `call:` handler as easily as from the
player.

## What is not here yet

- **Rendering.** Inkforge draws no portraits, no name plates, and no dialogue UI. That is the author's, through
  [Canvas](canvas.md) or [UI](ui.md).
- **Moving.** `locations.<id>.npcs` is authored and static; nothing moves an NPC between locations at runtime yet.
- **Counters.** There is no `npcInc`/`npcDec`; use `inc` with a full `npc.<instance>.<path>` key.
