# Scenario

`scenario.yaml` is the entry point of a project. It holds the front matter and pulls in everything else.

```yaml
meta:
  title: Lantern Below
  author: Inkforge
  version: 0.1.0

startLocation: entry

state: !import state.yml
player: !import player.yml
ui: !import ui.yml
definitions: !import definitions.yml
instances: !import instances.yml
locations: !import locations.yml

scripts:
  main: scripts/main.lua
```

| Key | Required | Purpose |
|---|---|---|
| `meta` | no | Front matter: `title`, `author`, `version`, `description` |
| `startLocation` | **yes** | The location the run begins in |
| `state` | no | Initial state, as a mapping of path to value |
| `player` | no | Player seed: `state` and `inventory` |
| `ui` | no | `{ elements: [...] }` — see [UI](ui.md) |
| `modals` | no | List of modal windows — see [Modals](ui.md#modals) |
| `tools` | no | Tool rail entries — see [Tools](tools.md) |
| `definitions` | no | Item definitions |
| `instances` | no | Placed item instances |
| `locations` | no | The locations themselves |
| `scripts` | no | `{ main: <path> }`, defaulting to `scripts/main.lua` |

A scenario with no valid `startLocation` is refused at load: `Scenario needs a valid startLocation.`

## Front matter

```yaml
meta:
  title: Lantern Below
  author: Inkforge
  version: 0.1.0
  description: "A short two-room story: take the lantern, light it, and read the passage."
```

`meta.title` is the fallback title: the header shows the current location's `title` when it has one, and `meta.title`
otherwise.

`meta.description` is a one-line summary of the work. The scenario library shows it on each card, ahead of the version and
when that scenario was last written — `A short two-room story: … · v0.1.0 · Updated 9/26/2026, 8:36:15 AM`. Both come
from here rather than from `manifest.json`, so the card shows the work's own version. A `description` or `version` you
leave out drops that part of the line rather than leaving a gap; a description containing a colon must be quoted, or YAML
reads the part after it as another key.

`meta.version` is your own version for the work — the "Lantern Below v1.0" you would put on it. It is front matter:
nothing else in the app reads it, so it is yours to decide when the work itself has earned a new one.

It is not the version that decides whether a pack installs. That is `project.version` in `manifest.json`, which records
the state of the files, and the two move independently — a template can ship a dozen package bumps with the scenario
still at `1.0`. See [Project format](project-format.md#the-package-version-is-not-the-scenario-version).

## State

Two places seed the same store, and they merge:

```yaml
# scenario.yaml
state: !import state.yml      # { lampLit: false }
player: !import player.yml    # { state: { health: 10 }, inventory: [...] }
```

`player.state` is applied **over** `state`, so a key present in both takes the player's value. `player.inventory` is the
starting inventory.

State is a flat mapping. There are no nested paths — `set: { door.open: true }` sets a key literally called
`door.open`, it does not build a table. Read and write it from Lua with `GameState.get` / `GameState.set` using the same
key.

Values may be any YAML scalar, list or mapping, and they survive round-trips through Lua because both sides see the same
store.

## Locations

```yaml
entry:
  title: Stone Entry
  text:
    - "Cold air rises from the passage ahead."
    - if: { hasItem: entry_lantern }
      then: "A pale ring in the dust is all that marks where the lantern stood."
      else: "A brass lantern rests beside the threshold."
  items: [entry_lantern]
  exits:
    north: passage
  actions:
    - id: light_lantern
      label: Light the lantern
      if:
        and:
          - { hasItem: entry_lantern }
          - { var: lampLit, neq: true }
      then:
        - "The lantern catches. Warm light fills the passage."
        - { set: { lampLit: true } }
```

| Field | Purpose |
|---|---|
| `title` | Shown in the header and the play view |
| `text` | Directives run on entry and on `look` |
| `items` | Items lying here, by instance id |
| `exits` | Movement, keyed by the direction the player types |
| `actions` | Non-movement things reachable with `@id` |

`text` is a directive list, so it can print lines, set state, call Lua — anything in
[Directives](directives.md).

Because `text` runs again on every `look`, a line describing something the player can change needs a condition, or the
second reading contradicts the first — the entry above reports a lantern that is by then in the player's pack. See
[Conditional location text](conditions.md#conditional-location-text).

Printed lines are markdown. A one-line string takes inline formatting; a `|` block is rendered in full, so a list or a
heading is available where the prose wants one. See [Markdown](markdown.md).

## Exits

The key is the direction. The value is either a bare destination id, or a descriptor that can guard and alias it:

```yaml
exits:
  north: passage                    # always available
  cellar:
    to: cellar
    if: { hasItem: brassLantern }
    aliases: [down, stairs]
```

| Field | Purpose |
|---|---|
| `to` | Destination location id |
| `if` | [Condition](conditions.md) gating the exit |
| `aliases` | Extra words that also match, besides the key |

An exit becomes a choice labelled with its key, capitalised — `north` shows as **North**. Typing the key or any alias
moves you. Typing a gated direction whose condition fails prints `That way is not available.`, and a gated exit whose
condition fails is not offered as a choice.

An exit to a location that does not exist prints `Unknown location: <id>` as an error and moves nowhere.

## Actions

An action is a location-scoped verb. It is offered as a choice labelled `label` (or the `id` when there is no label) and
run by typing `@id`.

```yaml
actions:
  - id: read_plaque
    label: Read the plaque
    then:
      - "The inscription is worn smooth."
```

`if` gates it, and a gated action whose condition fails is hidden from the choice list. `then` is a [directive
list](directives.md).

Actions are the idiomatic place for anything that is not movement and not an item: examining, listening, pulling a lever,
talking.

## Items

Items are in two parts, and the split is what lets many placements share one description.

**Definitions** name the thing:

```yaml
# definitions.yml
item:
  lantern:
    name: Brass Lantern
    description: A hand lantern with a hooded flame.
    aliases: [lantern]
```

**Instances** place it:

```yaml
# instances.yml
item:
  entry_lantern:
    def: lantern
```

A location's `items:` list holds **instance** ids. The engine resolves instance → `def` → definition to find the
display name, which is why `take entry_lantern` prints `Taken: Brass Lantern.`

`name` and `description` are what the inventory inspector shows when a slot is clicked. `aliases` is currently
documentation rather than a lookup — `take` matches the instance id or the definition name, not aliases.

Taking an item removes it from the location, so it disappears from the choices and reappears in the inventory. `take`
matches case-insensitively on either the instance id or the lowercased definition name:

```yaml
# both work for the instance above
take entry_lantern
take brass lantern
```

Giving an item that is already held does nothing; removing one that is not held is harmless.

## The turn model

Worth knowing before you write prose: **the terminal shows the output of the current turn only.** Each command clears the
event list, runs, and repaints — so the previous turn's text is replaced rather than appended to.

That means each location's `text` is a self-contained description, and `look` re-runs it. If you want the feel of a
scrolling transcript, print the accumulated state yourself rather than relying on history. The separate **event stream**
in the Author view does keep every event of the current turn for debugging.

## What you can type

| Input | Result |
|---|---|
| `look` or `l` | Run the current location's `text` |
| a direction, or an exit alias | Move |
| `take <id or name>` | Take a location item |
| `@<action id>` | Run a location action |
| anything else | `Unknown command: <cmd>` |

Empty input does nothing. Once the run has ended, every command is ignored until a restart.
