# Inkforge documentation

Inkforge is a browser-only studio for authoring and playing YAML + Lua text adventures. A project is a folder of text
files and assets; the studio edits it, runs it, and packs it for sharing, all in one tab with no server.

Two trees, two audiences:

| | |
|---|---|
| **[Authoring](authoring/README.md)** | Writing a scenario: the YAML schema, the Lua API, the canvas, UI, tools, audio, and what to do when something goes wrong |
| **[Development](development/README.md)** | Working on Inkforge itself: the toolchain, the module map, the invariants, and the rules to follow when changing code |

Authors should start at [Authoring](authoring/README.md). Developers should start at
[Development](development/README.md) — which links into the authoring tree, since the authored surface is much of what
the code implements.
