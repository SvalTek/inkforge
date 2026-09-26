# Conditions

A condition decides whether something happens. Conditions guard exits, location actions, location text, UI elements and
`if:` directives.

```yaml
exits:
  cellar:
    to: cellar
    if: { hasItem: brassLantern }
```

## The recognised keys

| Key | Meaning |
|---|---|
| `and` | Every condition in the list must pass |
| `or` | At least one condition in the list must pass |
| `not` | Inverts the condition inside it |
| `hasItem` | The inventory contains this item id |
| `var` | Names the state path to test |
| `eq` | `var` equals this value |
| `ne` / `neq` | `var` does not equal this value |
| `gt` `gte` `lt` `lte` | `var` is greater/greater-or-equal/less/less-or-equal than this number |

Anything else is rejected at load time: `unknown condition key 'hasitem'`. See [why that matters](#failing-closed).

## Comparison conditions

A comparison needs a `var` to compare against. On its own it is a load-time error —
`comparison needs a 'var' to compare against`.

```yaml
if: { var: courage, gte: 3 }
if: { var: ending, eq: "flooded" }
if: { var: lanternLit, ne: true }
```

`eq`/`ne`/`neq` compare directly. `gt`/`gte`/`lt`/`lte` coerce both sides with `Number(...)`, so they are for numbers —
comparing strings numerically will not do what you want.

`neq` is an accepted spelling of `ne`; use one consistently.

## Truthiness

`var` with no comparison is a truthiness test: it passes when the value is not `false`, `0`, `""`, `null`, or `undefined`.

```yaml
if: { var: doorOpen }
```

This is the idiomatic way to test a flag set with `set: { doorOpen: true }`.

## Combining

```yaml
if:
  and:
    - hasItem: brassLantern
    - var: oil
      gt: 0
    - not: { var: hatchLocked }
```

Nesting is unlimited. `and` and `or` take lists; `not` takes a single condition.

## Empty and missing conditions

- A **missing** condition always passes. An exit with no `if` is always available.
- An **empty** condition (`if: {}`) is a load-time error — `condition is empty` — and fails closed at runtime.

## Failing closed

An unrecognised key makes the condition **false**, not true, and the same is true of any condition the runtime cannot
interpret.

This is worth stating plainly because the alternative is so much worse. A misspelled `hasitem` in a gate condition, if
it defaulted to "pass", would silently open the gate — the player walks through a door they were never meant to reach,
and nothing anywhere reports a problem. Failing closed means the worst case is a door that never opens, which is
visible, reproducible, and reported at load time by `unknown condition key 'hasitem'`.

The same principle applies to directives: an unknown directive key is reported rather than ignored. See
[Diagnostics](diagnostics.md).

## Where conditions are checked

| Site | Field |
|---|---|
| An exit | `exits.<direction>.if` |
| A location action | `actions[].if` |
| A line of location text | `if` on a directive inside `text` |
| A UI element | `if` on the element itself |
| A directive | `if` on the directive mapping |

A UI element whose condition is false is not rendered at all, and a location action whose condition is false does not
appear in the available actions list. Exits whose condition is false are hidden from the choice list; typing the
direction anyway prints `That way is not available.`

## Conditional location text

A location's `text` runs on entry **and again on `look`**, so prose that describes something a directive can change
becomes a lie the second time it is read. Take the lantern out of the entry and `look` still reports one resting beside
the threshold, because nothing told the text it had moved.

The fix is a condition on the line itself:

```yaml
locations:
  entry:
    text:
      - "Cold air rises from the passage ahead."
      - if: { hasItem: entry_lantern }
        then: "A pale ring in the dust is all that marks where the lantern stood."
        else: "A brass lantern rests beside the threshold."
    items: [entry_lantern]
```

`then` and `else` each take a string, a directive mapping, or a list of either — the same shapes `text` itself accepts.
`else` is optional: a false condition with no `else` prints nothing.

The rule of thumb is that any sentence naming an item, a count or a flag is a sentence that needs a condition, unless
something else already guarantees it. See [the turn model](scenario.md#the-turn-model) for why `look` replays the text.

### The key order matters

`if` is resolved **after** the mutating keys, so a directive that mixes them silently skips the condition:

```yaml
- if: { hasItem: key }        # this `set` runs unconditionally
  set: { doorOpen: true }     # and the `if` below it is never reached
```

Keep a conditional directive to `if`, `then` and `else` alone, and put the state change inside the branch it belongs to.
See [Directives](directives.md) for the full order and the other keys it affects.
