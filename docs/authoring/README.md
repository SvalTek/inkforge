# Authoring

Inkforge is a studio for writing text adventures: you describe the world in YAML, script the parts that need
computation in Lua, and play the result in the same tab. There is no build step between editing and playing, and no
server — a project is a folder of text files plus its assets, and the whole thing runs in the browser.

This tree documents the authoring surface as it exists today.

## Getting a project

The studio opens on the bundled starter, **Lantern Below**. From there:

| | |
|---|---|
| **New** | A copy of the starter under a fresh id, unpinned and yours to edit |
| **Load** | The scenario library: every scenario saved in this browser |
| **Import** | A `.inkforge` pack from disk |

The starter is pinned: it cannot be deleted, so there is always something to fall back to. Your work is saved to browser
storage as you type, per file, and nothing leaves the machine.

A `.inkforge` file is a ZIP of a project — the same source tree you would copy by hand, plus a generated manifest. See
[Project format](project-format.md).

## The two views

**Play** is the game: the terminal, the choices, the tool rail, the canvas, the inventory and modals.

**Author** is the editor: a file tree, tabs, a plain-text editor with line numbers, a live run panel, and an event
stream. The run panel is the same run the Play view shows, so you can edit and play without switching back and forth.

Edits save automatically. **Run** restarts and switches to Play; **Restart** restarts without switching.

## Creating files and folders

The Author view's file tree is a real nested hierarchy. You can create folders and files at any level:

- **+ New** in the explorer header opens a dialog for creating a folder, YAML file, or Lua file at the project root.
- **+** on any folder row opens the same dialog, scoped to that folder.

The dialog validates names: no path separators, no leading dots, no duplicates, and files must use a supported extension
(`.yaml`, `.yml`, or `.lua`). A name typed without an extension gets the default for the chosen type.

Empty folders are allowed. The explorer records them with a hidden marker that survives saves but is filtered from
exports, so an empty folder does not travel with a `.inkforge` pack. Adding a file to an empty folder removes the marker
automatically.

Assets are uploaded separately via the **↑ Asset** button, which accepts the supported image and audio types. See
[Project format](project-format.md) for the full list.

## A project's shape

Lantern Below, the starter, is a reasonable template to copy:

```
scenario.yaml          the entry point: front matter, and !imports of the rest
state.yml              initial state
player.yml             the player's starting state and inventory
ui.yml                 authored UI elements
definitions.yml        what items are
instances.yml          where items are placed
locations.yml          the world
scripts/main.lua       the entry script
scripts/threshold.lua  a required module
manifest.json          generated; describes the pack
```

Nothing beyond `scenario.yaml` and `scripts/main.lua` is required, and every other file is reached by an `!import` from
`scenario.yaml`. Splitting the world across files is a convenience, not a rule — see [Composition](composition.md).

## The two templates

**Lantern Below** is the text-forward one, and it is what a new project copies. It shows the shape of a small adventure:
a handful of locations joined by gated exits, an item that must be found before something can be lit, a location action
gated on state, a HUD meter bound to a state key, an inventory, a modal window, and a Lua module broken out into its own
file. Most of the guide pages quote it.

**Renderer Showcase** is the canvas-forward one. It is not loaded by default; import `templates/renderer-showcase.inkforge`
from the scenario library to see it. It is the reference for the drawing surface: flat, isometric and oblique scenes in one
project, layers with depth sorting, world and screen spaces in the same scene, screen-space overlays over a projected
world, pointer hit-testing with world coordinates, tweens, keyframes, sprite sheets, and an authored tool rail.

Where the guides need an example of something Lantern Below does not do, they quote the showcase.

## Reading order

New to the project format:

1. [Scenario](scenario.md) — `scenario.yaml`, locations, exits, items, and the turn model
2. [Directives](directives.md) — the one list of things that print text and change state
3. [Conditions](conditions.md) — what gates an exit, an action or an element
4. [Composition](composition.md) — `!import`, `!mixin`, and how errors point back at a file

Then, as you need it:

5. [Markdown](markdown.md) — how authored prose renders, and where it stays literal
6. [Lua](lua.md) — the lifecycle, `require`, and every namespace
7. [UI](ui.md) — authored elements, regions, activations, modals
8. [Tools](tools.md) — the tool rail
9. [Canvas](canvas.md) — scenes, nodes, layers, projections, input, animation
10. [Audio](audio.md) — sound
11. [Project format](project-format.md) — what a project is on disk, and what a pack contains
12. [Diagnostics](diagnostics.md) — where errors appear, and what is not checked

## Two things worth knowing before you start

**The terminal shows the current turn only.** Each command clears the output and repaints, so a location's `text` should
be a self-contained description rather than a continuation. This is deliberate, and it is the single most common surprise
— see [The turn model](scenario.md#the-turn-model).

**A directive object runs its keys in a fixed order, and the first one that applies wins.** `{ if: ..., set: ... }` sets
unconditionally, because `set` is tested before `if`. The correct spelling is `{ if: ..., then: { set: ... } }`. See
[Directives](directives.md).
