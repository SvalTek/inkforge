# Diagnostics

Nothing here is silent. This page is the map of where the studio tells you something went wrong, and which mistakes it
cannot tell you about.

## The two views

The studio has two views, switched from the navigation at the top.

| View | For |
|---|---|
| **Play** | Playing the scenario. Terminal, choices, tool rail, canvas, inventory, modals |
| **Author** | Editing. File tree, tabs, editor, the run panel, and the event stream |

Both views show the game at the same time — the Play view has its own terminal and canvas, and the Author view's run
panel is a second copy of the same run. Editing a file does not change what is running until you press **Restart** (or
**Run**, which restarts and switches to Play).

## The diagnostics line

One line, at the bottom of the Author view, is the status slot. It carries exactly one message at a time, so it always
describes the most recent thing that happened — including a message that has already been superseded in the transcript.

| State | Colour | Meaning |
|---|---|---|
| `● Loading project` | amber | A boot is running |
| `● Ready` | green | The boot finished with no problems |
| `● N problems at boot — see transcript` | amber | The boot finished, but something reported a problem |
| `● <message>` | red | The boot failed, or a media/asset error was reported |

Because it is a single slot, a boot that reports several problems shows the **count** there and the messages in the
transcript. That is deliberate: the transcript is the durable record, the line is the at-a-glance state.

Some messages come from places other than a boot, and use the same slot:

```
● Unsupported asset type: notes.xyz
● Asset already exists: assets/map.svg
● Asset not found: assets/portrait.png
● Audio asset not found or unsupported: assets/theme.mp3
● Audio could not be loaded: assets/theme.mp3
● Audio playback was blocked: assets/theme.mp3
```

The last one is the browser's autoplay policy rather than a mistake in the project — see [Audio](audio.md).

## The event stream

The Author view has an **event stream** panel listing every event of the current turn, each with its type and, for item
events, the item's display name. It has a **Clear** button.

This is the debugging view the terminal cannot be: because the terminal shows the current turn's output only, the event
stream is where you look to see *everything* a command produced, including events that printed no text — a `set`, a
`goto`, an `emit`.

Clearing it only clears the panel; the next command repopulates it.

## Where an error appears

Three different places, depending on when it happens.

**At load — before anything runs.** A malformed YAML file, an `!import` that cannot be resolved, an unknown condition or
directive key, or a missing `startLocation` stops the boot. The message goes to the diagnostics line, and the Play
terminal is replaced with a single system entry carrying the same text. Nothing is running at this point, so there is no
half-live state to reason about.

**At boot — a script that will not load, or a name that does not resolve.** The message is written to the transcript as
an error, the diagnostics line shows it, and the boot continues with what it has. A missing Lua function is reported as:

```
Missing Lua functions: cellar.arive (locations.cellar.text.0.call)
```

The path in brackets is a location in the composed scenario — see [Composition](composition.md) for how those paths are
reported.

**At play — a `call:` that throws, an `emit:` nobody hears, an unknown command.** These go to the transcript and do not
stop the run.

```
Cannot call 'open_map': no Lua runtime is loaded.
Event 'door:opened' was emitted but nothing is listening for it.
Unknown location: cellar_stairs
Unknown command: pul
That way is not available.
<the Lua error, verbatim, prefixed with the failed call>
```

An error inside `Update` or a timer callback is caught by the runtime and reported as it happens, without stopping the
run:

- An interval whose callback throws once is stopped, rather than re-throwing every tick.
- A Lua error while a script is loading fails the boot instead.

One caveat on scope: the command dispatch path has no catch of its own — only a `finally` that repaints. A command that
throws something unexpected therefore escapes as an unhandled rejection and appears in the browser console rather than in
the transcript. Everything the engine itself can fail at is reported; this is only about the unforeseen.

## What is checked, and what is not

The studio is deliberately loud about the mistakes that would otherwise fail quietly, because the quiet ones are far
worse than an error.

**Caught:**

| Mistake | Caught |
|---|---|
| Unknown condition key (`{ vara: x }`) | At load — `unknown condition key 'vara'` |
| Empty condition | At load — `condition is empty` |
| `and:` or `or:` that is not a list | At load — `'and' must be a list of conditions` |
| A condition that is not an object at all | At load — `condition must be an object` |
| Comparison without a `var` | At load — `comparison needs a 'var' to compare against` |
| Unknown directive key | At load — `unrecognised directive [...] — nothing will happen` |
| A directive that is neither a string nor an object | At load |
| Invalid `startLocation` | At load — `Scenario needs a valid startLocation.` |
| `!import` target missing, or circular | At load |
| `!mixin` that is not a mapping | At load — `Mixin must resolve to a mapping: <path>` |
| Unknown canvas projection type | At load — `Unknown canvas projection: <type>` |
| A `call:` naming a function that does not exist | At boot — `Missing Lua functions: ...` |
| A tool `action:` or UI `callback:` naming a function that does not exist | At boot, the same way |
| A tool definition that is malformed | When registered — `Tool needs a non-empty id.` and friends |
| A `modal.page` naming a page that is not in the open modal | When activated |
| Missing configured Lua entry file | At boot — `Script not found: <path>` |
| An `npcSet` key with no dot, or naming no instance | At load — `key must be '<npc-instance>.<value>'` |
| An `npcVar` with no dot, or naming no instance | At load — `npcVar must be '<npc-instance>.<value>'` |
| An `instances.npc` entry with no `def`, or one that resolves to nothing | At load — `unknown npc definition '<id>'` |
| A location's `npcs:` listing an instance that does not exist | At load — `unknown npc instance '<id>'` |
| An NPC `portrait` that is not a project asset path | At load — `npc portrait must be a project asset path such as assets/portrait.webp, got '<path>'` |
| An NPC `state` that is not a mapping | At load — `npc state must be a mapping of value names to values` |
| An NPC instance id containing a `.` | At load — `npc instance id must not contain '.', which separates it from a value name, got '<id>'` |
| A UI element's `if:` with a bad key, or one naming an unknown NPC | At load — including nested elements and `actions:` as well as `events:` |
| A `portrait` path that is well-formed but not uploaded | When something resolves it — `Asset not found: <path>` |
| A conversation's `start` naming no node | At load — `unknown node '<id>'` |
| An option's `next` naming no node in the same conversation | At load — `unknown node '<id>' in conversation '<id>'` |
| An option's `talk` naming no conversation | At load — `unknown conversation '<id>'` |
| A dialogue line or participant naming neither `player` nor an NPC instance | At load — `unknown speaker '<id>'` / `unknown participant '<id>'` |
| An unknown key on a dialogue line or a conversation option | At load — `unknown dialogue line key '<k>'` / `unknown conversation option key '<k>'` |
| Two options in one node sharing an `id` | At load — `duplicate conversation option id '<id>' in this node` |
| `dialogue`, `options` or `participants` written as a mapping instead of a list | At load — `<path>: ... must be a list`, rather than a `forEach is not a function` crash |
| A location's `npcs` written as a mapping instead of a list | At load — `locations.<id>.npcs: location npcs must be a list` |
| A `call:` in a conversation option naming a function that does not exist | At boot — `Missing Lua functions: ...` |
| `discoverable` written as anything but `true`/`false` | At load — `discoverable must be true or false` |
| A `discoverable` conversation with no NPC instance in `participants` | At load — `a discoverable conversation needs an npc instance in participants to be offered from` |
| Two ungated `discoverable` conversations for the same NPC instance | At load — `'Talk to <npc>' cannot mean two things`. Gated ones are allowed; that is how one person gets two conversations |
| Two *gated* `discoverable` conversations for the same NPC instance, both live at once | At runtime, once — `Two conversations are offered to <npc> at once: ...`. A gate is not proof of exclusivity, so the first is offered and the collision is reported rather than swallowed |
| An `npcs:` entry with nothing under it | At load — `npc definition must be a mapping`. A half-written definition must not take the rest of the validation down with it |
| A condition or directive inside a **modal's** elements | Checked at load, same as a screen element. Modal elements are authored content and were silently skipped once |

**Not caught — the ones to watch for:**

| Mistake | What happens |
|---|---|
| An `emit:` with no listener | Reported the first time it fires, not at boot. `Events:On` cannot be enumerated, so this is the earliest it can be known |
| A typo in a state key | A `get` returns `nil` and the write creates a new key. Nothing is wrong as far as the engine can tell |
| An exit whose condition can never pass | The exit is simply never offered |
| An authored UI element whose type its region does not render | It is absent, with no message — see [UI](ui.md#regions) |
| A UI element nested inside another that the outer one never renders | Absent, with no message |
| A canvas node type that is not drawn | It draws nothing, silently. Its children still render |
| A `text` node with no `fill` | Draws nothing, since `fill` is the text colour |
| An `emit:` in a directive list that the run never reaches | Nothing at all |
| Talking to an NPC who is not in `locations.<id>.npcs` | Nothing — presence is authored and never enforced, so a script may talk to anyone |
| An `npcVar` naming a real instance but a `<value>` that was never seeded or set | `undefined`, so the comparison behaves as it would for any absent value |
| A conversation node whose options are **all** gated shut, with no options left to answer | The conversation **ends** and the player is returned to the room. Deliberate, and the one place the engine does not fail closed — see [a node with no options ends the conversation](conversations.md#a-node-with-no-options-ends-the-conversation) |
| Talking to an NPC who is not in the room's `npcs:` list | Nothing — presence is authored and never enforced, so a script may talk to anyone |
| An NPC standing in the room with no `discoverable` conversation | No `Talk to` button, and no message. There is no conversation to have, so there is nothing to talk *about* |

Every one of the unchecked cases is a thing the shape of the data cannot prove. Where a check is possible it exists; the
rest are worth knowing about rather than being papered over with a guess.

## The author loop

1. Edit in the Author view. Saves are debounced and coalesced, and the `saved locally` note next to the title confirms
   the write. There is nothing to press to save the *project*.
2. Press **Restart** for the run panel alone, or **Run** to restart and switch to Play. Both do a full teardown and boot:
   scenes are destroyed, the Lua runtime is closed and recreated, and state is rebuilt from `player.state`.
3. Read the diagnostics line, then the transcript, then the event stream.

A restart is a genuine reset, not a continuation. Anything you set during the previous run is gone, which is what makes
the loop reliable — the scenario you are running is always exactly what is on disk. That is also why **Restart** is the
right button while authoring: it deliberately discards run state, where **Save** in the Play view deliberately keeps it.
See [Saving a run](README.md#saving-a-run).

## Import errors

A project pack that cannot be imported reports through `alert`, not the diagnostics line, because the import is a file
drop rather than part of the running app. The messages are specific:

```
Invalid .inkforge ZIP package
Package is missing manifest.json
Unsupported Inkforge package; expected pack version 2
Package must include scenario.yaml
Package must include configured Lua entry script: <path>
Package is missing <path>
Duplicate project path: <path>
Invalid project path: <path>
Invalid project version: <version>
Scenario source is not valid UTF-8: <path>
```

An import that is declined because the loaded project is the same version or newer says so rather than importing — see
[Project format](project-format.md).

`Package must include configured Lua entry script` only appears when the pack's scenario composes far enough to name its
entry script. A pack with broken or unfinished YAML imports anyway and reports through the diagnostics line at boot, so
the two failure paths never overlap.

## The console

`print` from Lua writes to the browser console, not to the transcript. Use `GameOutput.add` for anything the player
should see, and keep `print` for development.

The console is also where the studio's own unexpected failures land. If something is wrong and neither the diagnostics
line nor the transcript says anything, that is the place to look next.
