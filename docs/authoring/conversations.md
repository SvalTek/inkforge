# Conversations

A conversation is somebody talking to the player, with the player answering. Inkforge
gives it a top-level key, a set of nodes, and a small set of rules about what ends it.

```yaml
# conversations.yml
keeper_greeting:
  participants: [player, passage_keeper]
  start: greeting
  nodes:
    greeting:
      dialogue:
        - speaker: passage_keeper
          text: "You carry a lantern."
      options:
        - id: ask_about_lamps
          text: I was told the lamps need tending.
          next: lamps
        - id: say_nothing
          text: Say nothing.
```

```yaml
# scenario.yaml
conversations: !import conversations.yml
```

Nothing about a conversation is rendered by Inkforge. `dialogue` is printed to the
transcript with the speaker's name in front, and the node's `options` become the
choice list. Drawing a portrait beside a name, or laying the exchange out as panels,
is yours to do through [Canvas](canvas.md) or [UI](ui.md) — see
[Not rendered here](#not-rendered-here).

## The shape

| Field | Purpose |
|---|---|
| `participants` | NPC instance ids, plus `player`. Carried as execution context, not enforced |
| `start` | The node entered when the conversation begins |
| `nodes` | The beats, keyed by name |

A node has a `dialogue` list and an `options` list. Nodes rather than one flat
conversation per branch, because a dialogue tree that flattens every branch into its
own conversation stops being writable past a few exchanges.

| Dialogue line field | Purpose |
|---|---|
| `speaker` | An NPC instance id, or the literal `player` |
| `text` | What is said |
| `if` | [Condition](conditions.md) gating the whole line |

| Option field | Purpose |
|---|---|
| `id` | Identifies the choice within its node |
| `text` | The button label |
| `if` | [Condition](conditions.md) gating whether the choice is offered |
| `then` | A [directive list](directives.md) run when it is taken |
| `next` | Continue at another node of this conversation |
| `talk` | Cut to a different conversation |

A participant or speaker that is neither `player` nor a declared NPC instance is
rejected at load. Nothing checks that the NPC is *in the room* — presence is authored
in `locations.<id>.npcs` and never enforced, which is what lets a script talk to
anybody. See [NPCs](npcs.md).

## Starting one

A conversation is started by the `talk:` directive, which is an ordinary directive and
composes with everything else:

```yaml
actions:
  - id: talk_keeper
    label: Talk to the keeper
    if: { npcVar: passage_keeper.trust, gte: 2 }
    then:
      - talk: keeper_greeting
```

It can equally sit inside a `call` handler, a UI element's `then:`, a conditional
arm, or a Lua timer — anything that runs directives can start a conversation.

Starting a conversation while another is running **replaces** it. `talk:` is a cut,
which is how a branching IF moves between scenes; there is no stack, so you cannot
return to the conversation you left by talking again.

From Lua, a conversation is started by emitting a directive or by calling a handler
that does — see [Lua](lua.md). There is no separate conversation namespace yet; the
seam is designed so adding one is additive rather than a change to this.

## While a conversation is running

The player is *in* the conversation, and that changes three things:

- **The choice list is the conversation's.** Location exits and actions are not
  offered, so there is no way to walk away in the middle of an exchange.
- **The command box is hidden.** Typing `north` into the middle of a conversation is
  not a thing a player means, so the input is removed rather than left to fail.
- **The transcript accumulates.** Spoken lines are ordinary output, so taking an
  option *appends* rather than replacing what is on screen. The whole exchange stays
  readable afterwards, the same way an item action's output does. See
  [the turn model](scenario.md#the-turn-model) for how that differs from a typed
  command.

If an option's `then` moves the player with `goto:`, ends the run with `end: true`, or
starts another conversation with `talk:`, that wins: the option does not then also
continue into its own `next`.

## What ends a conversation

Four things, and only these four:

| Ending | When |
|---|---|
| **The choice goes nowhere** | An option with neither `next` nor `talk` |
| **The node has nothing to answer** | See below |
| **The player moves** | A `goto:` in an option's `then`, or anything that changes location |
| **The run ends** | `end: true` anywhere it can reach |

An option needs no `end` key of its own: having nowhere to continue *is* the ending.
`end:` at the top level of a directive list still means the game, which is a
different thing.

### A node with no options ends the conversation

This is deliberate, and worth stating plainly because it is the one place Inkforge
does not fail closed.

A node whose options are **all** gated shut, or which declares no options at all, is a
terminal beat: the conversation ends and the player is handed back to the room, with
its exits and actions. Its dialogue has already been printed, so nothing is lost.

The alternative — holding the node — would be a soft-lock. The command box is hidden
for the duration of a conversation, so a node with nothing to answer leaves the player
with no choices and no way to type anything. Ending the conversation is strictly
better than stranding them, and a node that was meant to have options almost always
has a gate that is not passing, which is an authoring mistake worth finding in play
rather than a dead end to sit in.

So: if a conversation ends sooner than you expected, look for a node whose options
are all conditional.

```yaml
    farewell:
      # No options, so this is a terminal beat and the exchange ends here. The line
      # is gated, so the node speaks only if the player earned it.
      dialogue:
        - speaker: passage_keeper
          if: { npcVar: passage_keeper.trust, gte: 4 }
          text: "Then go carefully. Mind the third one."
```

## Lua inside a conversation

A `call:` in an option's `then` receives the conversation as execution context, the
same way an inventory action receives its item:

```lua
function keeper.asked(params, context)
  GameOutput.add("Trust is " .. tostring(GameState.get("npc.passage_keeper.trust")) .. ".")
  -- context.conversation.id           == "keeper_greeting"
  -- context.conversation.nodeId       == the node the choice was taken at
  -- context.conversation.optionId     == the option's id
  -- context.conversation.participants == { "player", "passage_keeper" }
end
```

Every `call:` in a conversation — including one in a node reached later — is checked
against the loaded script at boot, like any other. See [Lua](lua.md).

## Saving

A conversation is a **position**, not a log: the conversation id and the node id. The
lines are ordinary transcript entries, so they are capped, saved and restored by the
machinery that already handles prose. A save taken mid-exchange resumes at the same
node with the same options.

If the scenario has moved on since the save — the conversation renamed, or the node
edited away — the run resumes *outside* the conversation and says so in the
transcript:

```
Conversation 'keeper_greeting' no longer has node 'lamps' in this scenario; the run resumes outside it.
```

## Not rendered here

Inkforge draws no dialogue UI, no speaker portraits and no name plates. A line is a
printed string with the speaker's name in front of it, and an option is a choice
button. That is deliberate: an engine that invented a shape for a dialogue panel would
be one more thing to unpick, and a text-forward game wants none of it.

If you want a portrait or a panel, you have everything you need:

- `npcs.<id>.portrait` records which asset belongs to an NPC — see [NPCs](npcs.md#portraits)
- a canvas scene can read it from Lua through `GameNPCs` and draw it
- a UI element can be bound to state and shown or hidden on a condition

## What is not here yet

- **Starting one from a Lua namespace.** A `call:` handler that runs `talk:` works
  today; a `GameConversations.start()` does not exist yet. The engine is built so that
  adding one threads a single type rather than reshaping anything.
- **Nesting.** A `talk:` cuts; it does not push. There is no "return to the previous
  conversation".
- **A typed `talk <npc>` command**, and offering "Talk to X" for whoever is in the
  room. Both are cheap to add later and neither is authored for now.
- **Moving NPCs.** `locations.<id>.npcs` is static, so a conversation can name an NPC
  who is not present without anything objecting.
