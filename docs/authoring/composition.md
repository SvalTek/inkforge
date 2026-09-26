# Splitting files with `!import` and `!mixin`

A project is not one YAML file. `scenario.yaml` is the entry point, and it pulls the rest in with two YAML tags, so
locations, UI and state can live in files sized to a human.

The starter project is laid out this way:

```
scenario.yaml      meta, startLocation, and the !imports
locations.yml      every location
definitions.yml    item definitions
instances.yml      item instances
state.yml          initial state
player.yml         player seed
ui.yml             UI elements
modals.yml         modal windows
tools.yml          tool rail entries
scripts/main.lua   the Lua entry file
```

The template names are conventions. `scenario.yaml` is the only fixed name; `scripts.main` in the composed scenario
selects the Lua entry file, defaulting to `scripts/main.lua`.

## `!import`

Replaces the tagged node with the contents of another file.

```yaml
locations: !import locations.yml

ui:
  elements: !import ui.yml
```

Because `!import` *replaces* the node, it can be used at the document root to make `scenario.yaml` a thin index:

```yaml
# scenario.yaml
!import scenario/index.yml
```

Paths resolve **relative to the file containing the tag**, so `locations.yml` inside `scenario.yaml` means the sibling
file. A leading `/` means the project root:

```yaml
definitions: !import /shared/items.yml
```

`..` steps up a directory but cannot escape the project root — an import that tries raises
`Import escapes project root: <path>`. A missing file raises `Imported file not found: <path>`.

Imports are followed recursively, and a cycle is detected and reported as a chain rather than hanging:

```
Circular import: scenario.yaml → a.yml → b.yml → a.yml
```

## `!mixin`

`!import` replaces. `!mixin` **merges**: the referenced mapping is applied first, and the keys written locally override
it. Use it for variants that share a base.

A mixin references a **file**, and merges that file's top-level keys. So a shared base lives in its own file:

```yaml
# base-cellar.yml
title: Cellar
text:
  - "Wet stone, and the sound of dripping."
exits:
  up: { to: kitchen }
```

```yaml
# locations.yml
cellar:
  !mixin base-cellar.yml
```

Used on its own like that, the mixin's value *is* the node, so there is nowhere to put local keys. To merge **and**
override, write the mixin under the `<<` key:

```yaml
cellarFlooded:
  <<: !mixin base-cellar.yml
  title: Cellar, Flooded          # overrides the base's title
  text:
    - "The water has risen past the bottom step."
```

`<<` is read as a plain key by the composer (YAML merge keys are off), so this spelling is safe and unambiguous. A bare
string also works — `<<: base-cellar.yml` — but the `!mixin` tag is clearer about what is happening.

Mixins compose in order: when several are given, each is applied over the previous, and local keys are applied last.

## What the tags cannot do

- A mapping containing `!import` is replaced entirely — sibling keys alongside an `!import` are not merged into the
  result. If you need merge semantics, use `!mixin`.
- A mixin must resolve to a mapping. Pointing one at a list or a scalar raises `Mixin must resolve to a mapping`.
- The YAML parser is the standard one, so anchors, aliases, block scalars and multi-document syntax all behave as
  documented for YAML — nothing here changes them.

## The composed result

Whatever the file structure, the engine works with one composed scenario. Every location, UI element and tool in the
project ends up in a single document, which is what makes `!import` purely a source-organisation tool: moving a
location into another file changes nothing about how it behaves.

## Validation paths

Diagnostics name the composed path, not the file, so a problem in `locations.yml` is reported as
`locations.cellar.text.0`. The path is the fastest way to find the directive; the file tree is where you then edit it.
