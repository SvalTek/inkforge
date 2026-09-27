# Tools

The tool rail is the vertical strip of launcher buttons down the left of the play view. A tool opens a modal or calls a
Lua function.

```yaml
- id: journal_tool
  label: Journal
  icon: "📖"
  modal: journal

- id: map_tool
  label: Map
  icon:
    image: assets/map.svg
  action: open_map
```

| Key | Required | Purpose |
|---|---|---|
| `id` | **yes** | Identity. Registering the same id again replaces the entry |
| `label` | **yes** | Tooltip, accessible name, and the fallback icon |
| `icon` | no | A glyph string, or `{ image: assets/… }` |
| `modal` | no | Open this modal id when clicked |
| `action` | no | Call this Lua function when clicked |

`modal` wins if both are given. A tool with neither is a button that does nothing — valid, but rarely what you want.

## Icons

```yaml
icon: "📖"                          # any string: emoji, Unicode glyph, letter
icon: { image: assets/map.svg }     # a project asset
```

With no `icon`, the first letter of the label is used, uppercased. So the minimum viable tool is an id, a label and an
`action`.

A string icon is drawn as text, so an emoji or a symbol like `⚙` works without an asset. Use an image when you want a
real graphic — it is resolved through the same asset path rules as everything else, and a missing file is reported as
`Asset not found: <path>`.

## Actions

`action` names a global Lua function:

```lua
function open_map()
  GameOutput.add("Map tool action dispatched to Lua.")
end
```

The name is resolved when the tool is clicked. A name that does not resolve reports the runtime's own message rather than
a generic one, so a typo shows up as what it is:

```
[CALL_ERROR] Failed to call 'open_mpa'
```

## Registering from Lua

```lua
GameTools.register({
  id = "lua_tool",
  label = "Lua tool",
  icon = "⚙",
  action = "open_lua_panel"
})
```

The same shape, in Lua. A Lua registration is upserted into the same registry the YAML tools populate, so a script can
replace an authored tool by using its id.

A definition that does not validate — no id, no label, a bad icon — throws rather than registering something broken.

## Runtime control

```lua
GameTools.hide("map_tool")      -- remove from the rail, keeping it registered
GameTools.show("map_tool")
GameTools.disable("map_tool")   -- stays visible, cannot be clicked
GameTools.enable("map_tool")
GameTools.remove("lua_tool")    -- unregister entirely
```

`hide` and `disable` are deliberately different: hiding is for a tool that is not relevant right now, disabling is for
one that is visible but unavailable — a menu entry that is greyed out rather than missing.

Hidden and disabled state is runtime state. A restart rebuilds the registry from `tools:` and from a fresh script load,
so a tool hidden during play comes back.

## `allowInConversation`

Whether this tool stays in the rail while a [conversation](conversations.md) is running. Defaults to `true`; set it to
`false` to withdraw the tool for the duration:

```yaml
tools:
  - id: notebook
    label: Notebook
    allowInConversation: false
    action: open_notebook
```

A conversation hides it through the ordinary hidden state rather than through anything of its own, so `GameTools.show`
brings it straight back — which is how a script offers it for one exchange that needs it:

```lua
GameTools.show("notebook")   -- and it stays gone once the conversation ends
```

`disable` is the other half: it leaves the tool visible and unclickable, where `allowInConversation` takes it out of the
rail entirely. See [ui.md](ui.md#allowinconversation) for the full rule — it is the same key on all three player-facing
surfaces, and the engine does not guess which ones ought to be withdrawn.

## Ordering

Tools appear in the order they are registered — `tools:` entries in authored order, then anything a script registers as
its top-level body runs. There is no `order` key; move the entry in `tools.yml` to move the button.
