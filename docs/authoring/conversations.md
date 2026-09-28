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
| `discoverable` | Offer this as `Talk to <npc>` while one of its NPCs is in the room |
| `if` | [Condition](conditions.md) gating that offer, and nothing else |
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

`id` must be unique within its node. An option is chosen by its id, so two options
sharing one would draw two buttons that both ran the first one's directives — refused
at load rather than resolved, because which of them you meant is not guessable.

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

From Lua, `GameConversations.start(id)` enters a conversation and `GameConversations.finish()` leaves the one you are in
— see [Lua](lua.md#gameconversations). Both are the same calls `talk:` makes, so a conversation opened from a timer or
a canvas callback behaves exactly like one an action opened.

## Presence-driven: `discoverable`

Sometimes an interaction is so obvious it should not need an action written to offer
it. You walk into a room, somebody is standing there, and `Talk to Rowan` is simply
one of the things you can do:

```yaml
conversations:
  keeper_greeting:
    discoverable: true
    if: { npcVar: passage_keeper.trust, gte: 2 }
    participants: [player, passage_keeper]
    start: greeting
    nodes: { ... }
```

**Nothing appears unless you ask for it.** A conversation without `discoverable` is
never offered, so a project that never writes the key behaves exactly as if this
feature did not exist.

The offer appears while one of the conversation's NPC **instances** is listed in the
room's `npcs:`, and while the conversation's `if` passes. The button is labelled
`Talk to <name>` from `npcs.<id>.name`, so name your NPCs without a leading article —
`Talk to Rowan` reads, `Talk to The Keeper` does not.

This is defined as *exactly* the `talk:` directive you would otherwise have written on
a location action: same state machine, same entry, same ending. Which is why every
question about *when* somebody may be talked to is answered by `if`, and why the two
ways coexist:

- **`discoverable: true`** for the person in the room who is plainly there to be
  talked to
- **no `discoverable`**, reached by an explicit action, for the person you have to
  *notice* — plenty of IF games have somebody you only find out is talkable by trying

Lantern Below has both: `keeper_greeting` is discoverable, and `keeper_lamps` is not,
reached by watching Rowan work.

Four things worth knowing:

- **An NPC present with no eligible conversation gets no button.** That is not a
  failure — there is no conversation, so there is nothing to talk *about*.
- **`if` gates the offer, not the conversation.** Starting one is never conditional; a
  discovered conversation is always enterable once offered.
- **Taking it restarts at `start` every time.** To make somebody stop being talkable
  once spoken to, gate on a flag the conversation itself sets:
  ```yaml
  keeper_greeting:
    discoverable: true
    if: { var: spokeToRowan, neq: true }
  ```
  with `- set: { spokeToRowan: true }` in its last node.
- **Two ungated `discoverable` conversations for the same NPC are refused at load**,
  because `Talk to Rowan` cannot mean two things.
- **If you gate them, that is allowed** — a morning and an evening conversation with
  one person is the ordinary way to write this. But a gate is not proof that two
  conditions are exclusive: `morning` and `questActive` can both be true. So when two
  of them are live at once, the first in the order you wrote them is offered and the
  terminal tells you which two collided:
  > Two conversations are offered to Rowan at once: `morning_talk`, `evening_talk`. Their
  > conditions overlap, so only "morning_talk" is reachable. Make their `if` mutually
  > exclusive.

  It is a warning rather than an error, and it is said once rather than on every
  repaint. The run continues correctly — you get a conversation, just not the second
  one. Silently dropping it is the one thing it will not do, because an author who
  believes their gates are exclusive has no other way to find out.

Offered talks appear after the location's own actions and before `Take`, so they never
outrank an exit you ordered or a thing the player did not ask about. Taking one
*appends* the opening line below the room description rather than replacing it, for the
same reason an item action's output appends.

## While a conversation is running

The player is *in* the conversation, and that changes four things:

- **The choice list is the conversation's.** Location exits and actions are not
  offered, so there is no way to walk away in the middle of an exchange.
- **The command box is hidden.** Typing `north` into the middle of a conversation is
  not a thing a player means, so the input is removed rather than left to fail.
- **Only permitted surfaces remain.** UI elements, tools and item actions are hidden for
  the duration unless they say `allowInConversation: true` — a look-around button has no
  business in the middle of an exchange. A script can put one back with `GameUI.show` /
  `GameTools.show` / `GameItemActions.show` if a particular conversation needs it. See
  [`allowInConversation`](ui.md#allowinconversation).
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

Moving *away* ends a conversation; entering the room you are already in does not, which
is what lets a `GameConversations.start()` in `OnInit` survive boot. The first thing
boot does after Lua runs is a `move` to the location the run is already in, and
clearing the conversation there would wipe every conversation an author opens at
startup.

**On a resumed run, the save wins.** A conversation started or finished in `OnInit`
applies to a *fresh* boot only: the saved position is restored after Lua has run, and it
overwrites whatever `OnInit` decided. That is the right order of authority — where the
player actually was beats what the script would have opened now — but it does mean
`GameConversations.start()` in `OnInit` is not a way to reopen a conversation someone
walked out of. To make somebody talkable again on load, gate the conversation on the
state the run saved, not on a boot-time call.

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

- **Nesting.** A `talk:` cuts; it does not push. There is no "return to the previous
  conversation".
- **A typed `talk <npc>` command.** `discoverable` covers the obvious case and an
  action covers a deliberate one; typing somebody's name is a third door, and it is
  cheap to add later.
- **Moving NPCs.** `locations.<id>.npcs` is static, so a conversation can name an NPC
  who is not present without anything objecting.
