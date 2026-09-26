# Markdown

Prose you author is markdown. Write `**bold**`, `*italic*`, `` `code` `` or a list, and it renders as such wherever the
text is meant to be read as writing.

This is a rendering rule, not a directive: nothing about how you write a string changes, and there is no `markdown: true`
to set. If a surface takes markdown, everything written into it is markdown.

## Where markdown applies

| Surface | How it renders |
|---|---|
| A location's `text`, and any line a directive prints | Inline for a one-line string, full markdown for a multi-line one |
| `GameOutput.add` | Same rule as `text:` — the string's shape decides |
| An item `description` | Full markdown |
| A UI `text` element | Full markdown |
| A modal's `text` element | Full markdown |
| A location title, a modal title, an inventory title | Inline markdown |

## Where it does not

Short labels stay literal. A choice label, an action label, a UI button label, a meter label, an item name, a tool's icon
and label, a kicker and the event stream are all printed exactly as written — a `*` in a button label is a `*`.

That is deliberate. These are identifiers as much as prose: they sit in fixed-width chrome, they are compared and quoted
in the event stream, and a label that silently turned half of itself italic would be a bug you could not see.

Kickers are the exception in the other direction: they are *always* italic, because that is what a kicker looks like. The
style is the app's, so writing `*EXTERNAL LINK*` there would only double it.

## Inline and block

Inline markdown covers emphasis, inline code, links and line breaks — everything that fits inside a line of text. Block
markdown adds paragraphs, lists, headings, quotes, fenced code and tables.

**In the transcript, the shape of the string decides which one you get.** A one-line string is inline:

```yaml
text:
  - "Read **the note**."          # emphasis, and a leading `-` stays a hyphen
```

A string containing a newline is a block, which is what a YAML block scalar gives you:

```yaml
text:
  - |
    The note lists what to carry:
    - a stub of candle
    - a bent nail
```

The second one renders a real `<ul>` in the transcript. The first one cannot: a prose line that happens to begin with `-`
or `#` is still prose, because a one-line string is never parsed as a block.

The trigger is your own choice of YAML style — `|` always produces a trailing newline, so `|` is the opt-in and there is
nothing else to remember. The same rule applies to `GameOutput.add`: a Lua string with a newline in it is a block.

## Raw HTML renders literally

Markdown is parsed with raw HTML disabled, so `<b>bold</b>` in authored text prints the characters `<b>bold</b>`. It does
not become bold, and it cannot introduce an element.

This is the reason markdown is safe to render at all. A project is authored data, and a `.inkforge` pack can be imported
from someone else; if authored strings could produce elements, a pack could produce a `<script>`. Because they cannot,
markdown is the only place in the app where authored text becomes markup, and the rest of the interface can go on treating
every authored string as text.

## Links

A link renders as a real anchor, so hovering shows you where it goes and you can copy it — but clicking one does not
open it. It shows a confirmation first, quoting the **full URL** the link would open, with a warning that it leaves
Inkforge for a page nobody can vouch for. Cancel is the default answer.

Only `http:`, `https:` and `mailto:` become links. Anything else — `javascript:`, `data:`, `file:` — is not an anchor at
all and prints as the literal markdown you wrote.

Right-clicking a link and choosing "open in new tab" skips the confirmation, because the `href` is real. That is a
deliberate trade: the real `href` is what buys the hover preview and "copy link address".

## Images are not rendered

`![a map](https://example.com/map.png)` prints `a map`. A link waits for a click; an image does not, and a pack that
pointed one at a tracking URL would leak the reader's IP address and referrer the moment the entry painted. Markdown
therefore cannot reach the network at all.

Project images are the `image` UI element, which resolves through the pack's own assets and never leaves it. See
[UI](ui.md).

## Tables

A table written in a block renders as a table:

```yaml
text:
  - |
    | Carry | Where |
    | --- | --- |
    | candle | the left pocket |
```

Anything wider than the text is the container's problem, not yours: a long code block scrolls sideways inside its own box
rather than pushing the page wider, and a table wraps inside the width it is given.
