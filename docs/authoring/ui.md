# UI

Authored UI lives in `ui.yml` under `ui: { elements: [...] }`, and can also be created at runtime from Lua with
`GameUI.create`.

```yaml
elements:
  - id: pack
    type: button
    location: sidebar
    fields:
      - { id: label, type: text, value: Inventory }
    events:
      activate: { type: inventory.open, title: Inventory }

  - id: health
    type: meter
    location: hud
    fields:
      - { id: label, type: text, value: Health }
      - { id: value, type: state, path: health }
      - { id: max, type: state, path: healthMax }
```

## Fields

An element's contents are declared as `fields`, not as loose properties. Each field has an `id` (what the renderer looks
up), a `type`, and either a literal `value` or a `path` into state.

| Field | Kind | |
|---|---|---|
| `{ id: label, type: text, value: Inventory }` | literal | A fixed string |
| `{ id: value, type: state, path: health }` | state | Read from `state.health` |

A `state` field is re-read on every repaint, which is what makes a bound meter follow a state change with no script
involved. Changing state is enough:

```lua
GameState.set("health", 7)   -- the bound meter now reads 7 / 10
```

A `text` field is authored prose, so it renders as markdown — emphasis, lists, links, all of it. A `label` field does
not: labels are literal, because they are chrome rather than writing. See [Markdown](markdown.md).

## Regions

`location` decides which region of the play view an element appears in. **Each region renders only certain types** —
this is the single most common surprise in authored UI:

| `location` | Rendered types | Where it goes |
|---|---|---|
| `sidebar` | `button` | The strip across the top of the canvas panel |
| `hud` | `meter` | The player strip under the canvas |
| `canvas` | `text`, `canvas` | Inside the canvas stage |
| `output` | `button`, `text` | Under the transcript, above the choices |

An element with a type its region does not render is silently absent. A `button` with `location: hud` will not appear
anywhere.

A `canvas`-region `canvas` element is normally not authored by hand: creating a scene adds one automatically, which is
what puts the scene's `<canvas>` on screen. A `text` element in the `canvas` region is a caption over the stage.

## Conditions and visibility

```yaml
- id: secret
  type: button
  location: sidebar
  if: { var: hatchOpen }
  fields:
    - { id: label, type: text, value: "Enter the hatch" }
```

`if` is a [condition](conditions.md). A failing condition removes the element from the view entirely.

Runtime visibility is separate and survives repaints:

```lua
GameUI.hide("secret")
GameUI.show("secret")
```

Hiding keeps the element defined; a condition re-evaluates every repaint. Use `hide`/`show` for something a script
toggles, and `if` for something state decides.

## Activations

What an element does when activated is its `events.activate` (or `actions.activate` — both are read). The `type`
selects the behaviour:

| `type` | Keys | Does |
|---|---|---|
| `inventory.open` | `kicker`, `title` | Opens the inventory overlay |
| `modal.close` | — | Closes the active modal |
| `modal.page` | `page` | Switches the page stack containing `page` |
| `audio.play` | `asset`, `id`, `loop`, `volume` | Plays a sound |
| `command` | `command` | Dispatches a command as if typed |
| `instructions` | `then` | Runs a directive list |
| *(none)* | `callback` | Calls a named Lua function |

```yaml
events:
  activate: { type: command, command: look }
events:
  activate: { type: instructions, then: [ { set: { read: true } }, "You read it." ] }
events:
  activate: { callback: open_map }
```

`callback` is the fallback: it runs when no `type` matched, so an element with only a `callback` works, and an element
with an unrecognised `type` and a `callback` runs the callback. An unrecognised `type` with no callback does nothing.

`command` is the useful one for simple cases — `look`, a direction, or `@action` all work, because it goes through the
same dispatcher the command line uses.

## `allowInConversation`

Whether this element stays on screen while a [conversation](conversations.md) is running. It defaults to `false`: a
conversation owns the player's attention, so set it to `true` only when the exchange deliberately needs the element:

```yaml
elements:
  - id: examine_entry
    type: button
    location: output
    allowInConversation: true
    fields:
      - { id: label, type: text, value: Examine the threshold }
    events:
      activate: { type: command, command: look }
```

The same key works on [tools](tools.md#allowinconversation) and on
[item actions](scenario.md#item-actions).

**The engine does not guess.** There is no rule that grants permission from the region or activation type. A `callback`
button is perfectly live mid-conversation and can be exactly what should be there; so can a meter. Only you know which
is which, so an element without this key steps aside.

**It is the ordinary hide state.** A conversation sets it the same way `GameUI.hide` would, which is the whole point:
`GameUI.show`, `GameTools.show` and `GameItemActions.show` address the same state, so a script can bring a surface back
for one exchange if it needs to, and a save records it. Nothing here is a second, parallel notion of "shown".

**Withdrawing is not disabling.** A hidden element is still there, still has its directives, and can still be driven by
a `call:` or a directive. What changes is what the player is offered. A timer that needs to hand the player a lamp
should not have to care whether somebody is mid-sentence.

If the player needs something outside the conversation's own options to finish it, mark that control
`allowInConversation: true`; otherwise the scenario is soft-locked.

## Modals

A modal is a titled window with its own recursive element tree. Modals are declared under `modals:` in `scenario.yaml`
and opened by a tool, or from Lua.

```yaml
- id: journal
  kicker: AUTHORABLE WINDOW
  title: Stage Journal
  dismissible: true
  elements:
    - id: journal_panel
      type: panel
      elements:
        - id: journal_intro
          type: text
          fields:
            - { id: text, type: text, value: "This window is one modal model." }
        - id: journal_actions
          type: row
          elements:
            - id: close_journal
              type: button
              fields:
                - { id: label, type: text, value: Close }
              events:
                activate: { type: modal.close }
```

| Key | Purpose |
|---|---|
| `id` | Identity, used by a tool's `modal:` and by `modal.page` paths |
| `title` | The window heading |
| `kicker` | A small label above the title |
| `dismissible` | Default `true`. When false, neither the Close button nor click-outside-to-close works |
| `elements` | The body: a recursive element tree |

Unlike the play view's regions, a modal renders its elements by **nesting**, not by region. Types are interpreted as:

| `type` | Renders as |
|---|---|
| `text` | Authored prose: markdown, in a block container |
| `button` | A button (label from `fields.label`, falling back to the id) |
| `image` | An image (`fields.src` or `fields.image`, plus `alt`) |
| `meter` | A labelled meter (`label`, `value`, `max`) |
| `page_stack` | One of its `page` children, chosen by the active page |
| `page` | Only meaningful inside a `page_stack` |
| anything else (`panel`, `row`, …) | A container; its `elements` are rendered inside it |

So `panel` and `row` are not special — they are just containers, and you can invent your own names for readability.
Element `if` conditions are honoured inside modals too.

### Page stacks

A `page_stack` is a tab group inside a modal. It shows one `page` child at a time:

```yaml
- id: journal_pages
  type: page_stack
  elements:
    - id: page_one
      type: page
      elements: [...]
    - id: page_two
      type: page
      elements: [...]
```

Switching is done by an activation anywhere in the modal:

```yaml
activate: { type: modal.page, page: page_two }
```

The first page is shown when the modal opens. A stack is identified by its **path within the modal** (for example
`journal.journal_pages`), so two modals may each contain a `page_stack` with pages of the same name. `modal.page` finds
the first stack in the active modal that contains the named page; a page id that is not in the open modal is reported as
`Unknown modal page: <id>`.

## Runtime changes

```lua
GameUI.create({ id = "listen", type = "button", location = "output",
  fields = { { id = "label", type = "text", value = "Listen at the threshold" } },
  events = { activate = { callback = "listen_at_threshold" } } })

GameUI.set("health", { fields = { value = 3 } })
GameUI.remove("listen")
```

`GameUI.create` appends to the same element list `ui.yml` populates, so an element created from Lua is indistinguishable
from an authored one and can be addressed by every other call.

`GameUI.set` applies an override rather than editing the declaration: the override is merged over the element, and
`fields` can be given either as a full field list or as an `{ id: value }` map.

```lua
GameUI.set("health", { fields = { value = 3 } })
GameUI.set("health", { fields = { { id = "value", type = "text", value = 3 } } })
```

Overrides persist across repaints, which is what makes them the right tool for a value a script drives.

The same `ui:` directive is available from YAML — see [`ui`](directives.md#ui) for the shape.
