# Conventions

The rules to follow when changing Inkforge. Most exist because breaking them produces a failure that is silent rather
than loud, which is the failure mode this codebase is organised against.

[Architecture](architecture.md) explains the shape; this is the list of things to do and not do inside it.

## Failure is loud

**Fail closed.** A condition with no key the engine recognises evaluates to `false`. A misspelled `hasitem` must not read
as "always pass" — that silently opens gates. If you add a condition key, add it to `CONDITION_KEYS` and to `check()`;
an unrecognised key falls through to `false`, which is the safe direction.

**Validate at load, not at use.** A typo in a directive key, a comparison with no `var`, an unknown projection type, a
`!import` that cannot resolve — all of it is reported before the scenario plays. `validateScenario` runs on the composed
scenario and its issues abort the boot with `Scenario problems: <path>: <message>; ...`. When you add a key to a data
shape, add it to the validator in the same change.

**Report, never no-op.** A `call:` that throws, an `emit:` nobody hears, an exit to a location that does not exist — each
produces a message. A seam that quietly does nothing is the bug, not the safe default.

**Route through the existing sinks.** `output(message, kind)` writes to the transcript. `dom.diagnostics` is the single
status slot. `reportMediaError` handles assets and audio. Do not add a fourth channel, and do not use `console.log` for
anything an author needs to see.

## Rendering

**Never `innerHTML`, with one exception.** Every authored string is untrusted: scenario text, labels, commands, item
names, event payloads. Write it with `textContent` or `dataset`. The exception is `src/ui/markdown.ts`, which assigns
`innerHTML` because that is what a markdown renderer does — and which is safe only because it is configured with
`html: false`, so markdown-it escapes every tag it did not generate itself. Authored markup still arrives as text. It is
the only file allowed to hand authored data to `innerHTML`, and smoke checks `6f` and `6g` are what hold that line. If
you find yourself building markup by string concatenation anywhere else, build elements instead.

**Mutations mark dirty; nothing else repaints.** Every function that changes what the author sees calls
`markViewDirty(runtime)`. It is already inside the funnels — `createOutput`, `setState`, `adjustState`, `addItem`,
`removeItem`, `setLocation`, `applyUi`, the tool registry mutations, the canvas surface add/remove, the `end: true`
directive, the modal open/close/page path — so a mutation written in terms of those gets it for free. Writing to
`runtime.state` directly, or to `runtime.events` without going through `createOutput`, is what breaks it.

**One flush gate.** `flushView` is the only place that calls the renderer. It reads `runtime.viewDirty`, clears it, and
repaints if it was set. Do not call `render()` from a mutation, a timeout or an event handler — mark dirty and let the
gate coalesce. This is why a Lua timer decrementing a bound meter needs no call of its own.

**The bridge owns frames.** `Update(dt)` and the timers run on the bridge's fixed 16 ms loop. `requestAnimationFrame` is
for animation and rendering only, scheduled on demand and stopped when there is no animation work left. Do not add
per-tick work to a rAF loop, and do not add frame-rate-dependent logic to `Update` — `dt` is in seconds and is the only
clock a script should use.

**Two renderers, and they are different.** `ui/render.ts` renders the play view's elements by **region**, and each region
accepts only certain types. `ui/modals.ts` renders a modal's elements by **nesting**, where anything unrecognised is a
container. Adding an element type means deciding which of the two it belongs to — or both, if it is meaningful in a modal
and in a region.

**Unrecognised things draw nothing, not something wrong.** An unknown canvas node type, a UI element with a type its
region does not render, an unknown activation type with no `callback`. This is intentional in each case (children still
render; there is no wrong guess), but it means the authored feedback for a typo is *absence*, which is why the load-time
validator exists.

## The Lua seam

**YAML reaches Lua by name, never by source.** `call:` names a function; `emit:` names an event. There is no path from an
authored file to a string of Lua that gets executed, and there must not be one — it would make every scenario a code
injection surface, and it would defeat the boot-time name check.

**Names are validated at boot.** After the entry file has executed, every `call:`, UI `callback:`, directive `call:` and
tool `action:` is resolved against the loaded globals and any miss is reported as
`Missing Lua functions: <name> (<path>)`. If you add a new authored place that names a Lua function, add it to
`collectReferencedLuaNames` in `src/yaml/validate.ts` — otherwise it will not be checked, and it will not appear in that
message.

`emit:` cannot be checked this way, because `Events:On` exposes no listener enumeration. The fallback is that an event
with no handler is reported the first time it fires.

**Ref or wrapper, per binding.** A host capability exposed to Lua is a reference (the Lua side sees the thing as it is)
or a wrapper (the Lua side sees a reshaped view). Decide which for each binding and write down why; a blanket facade
layer over everything is the anti-pattern this codebase was rebuilt to remove. Two things are wrappers and say so:
`GameCanvas` is Lua rather than a `LuaClass` because its handles are closures over per-node state, and the canvas
`command` transport is a single `__canvas_command` entry point rather than one global per operation.

**Namespaces are flat and PascalCase.** `GameState.get`, `GameAudio.setVolume`, `timers.setTimeout`. Host namespaces are
`readonly`, so authored Lua cannot reassign `GameState.get` and quietly break the API. Method names follow the bridge's
own bindings — `setVolume`, not `set_volume` — so the whole Lua surface reads the same way.

**Read-only authored data is returned as a detached value.** `GameItems` may resolve the live composed scenario, but
the definition handed to Lua is a clone. Namespace immutability protects the API surface; cloning separately protects
the source data from mutation through a returned object.

**Every handle method has a host operation.** `GameCanvas`'s Lua handles do not do work locally; they send a command and
the host applies it. A method with no matching host op is a dead method. When you add one, add both halves.

## Boot and teardown

**All boots go through the chain.** `start()` appends to `bootChain` and increments `app.bootGeneration`; a boot that has
been superseded stops before it commits anything or announces readiness. `start()` is fired from four places (the initial
load, Restart, Run, and the play view's restart) and is async, so overlapping boots used to interleave on `app.canvas`,
`app.lua` and `app.runtime`. Never call `bootRuntime` directly, and never assign to `app.canvas`, `app.lua` or
`app.runtime` outside `bootOnce`.

**Teardown must be complete.** A boot destroys the previous canvas runtime, shuts down the previous Lua bridge, and
revokes the previous asset resolver's object URLs. Anything with a lifetime that spans a run belongs on that teardown
path. A restart is a genuine reset — that is what makes the author loop trustworthy.

**Do not let teardown mask a boot failure.** The `shutdown()` calls are wrapped in an empty `catch` on purpose: an error
while tearing down the old runtime must not replace the error from the new one.

## Build and dependencies

**Dependencies come from the import map.** `deno.json` pins everything, and esbuild bundles it via
`@luca/esbuild-deno-loader`. One exception: the YAML parser is imported from a CDN at runtime through
`src/deps/remote.ts`, kept out of the bundle by passing the URL as a non-literal specifier, so the build cannot resolve it
statically. If you add a dependency, prefer the import map; if you need a runtime URL, put it behind `loadEsm` for the
same reason.

**The Lua runtime's WASM is inlined.** `tools/build.ts` generates a base64 data URI into a gitignored module and passes
it to the bridge as `wasmUri`, so the bundle needs no external file and there is nothing to keep in sync. Do not
reintroduce a copied `glue.wasm`.

**`deno task check` before you are finished.** It type-checks `src/main.ts`; `deno task check:tools` type-checks the
tools, which are outside that graph. `deno task fmt` and `deno task lint` are separate, and `deno task fmt:check` reports
formatting drift without writing. Beyond the type checker, the four
browser checks (`check:renderer`, `check:authoring`, `check:pack`, `check:tools`) plus `smoke` cover the surfaces types
cannot reach — see [Build and test](build-and-test.md).

## Recipes

**Add a directive key.** Add it to `DIRECTIVE_KEYS` in `src/engine/directives.ts`, add its type to `DirectiveObject` in
`src/types/scenario.ts`, and add a branch to the if-chain in `execute()`. Note the chain tests keys in a fixed order and
takes the **first** match, so a new key's position is a behavioural decision, not a formatting one. `DIRECTIVE_KEYS`
itself is a set used for validation and is not in execution order — the two lists are separate and both need updating.

**Add a condition key.** `CONDITION_KEYS` in `src/yaml/validate.ts` and `check()` in `src/engine/conditions.ts`. A
state-reading key also participates in the comparison-subject rules in `checkCondition`; `var` and `itemVar` share the
same comparison implementation. Contextual keys must be validated only at sites that can actually supply their subject.

**Add a Lua namespace.** Add it to `createHostNamespaces` in `src/lua/bindings.ts` as a `readonly` `LuaClass`. It is
installed by being present in the globals map passed to `createLuaBridge` — there is no registration step. If it needs
its own host state, pass it in through `LuaHostBindings` rather than reaching for `app`.

**Add a canvas operation.** Add the op to the Lua API in `src/lua/lua-api.ts`, add the host side to
`InkforgeCanvasRuntime.command` in `src/canvas/runtime.ts`, and extend `CanvasCommand` in `src/types/canvas.ts`. If it
mutates something drawn, mark the view dirty; if it starts an animation, the frame scheduling follows from that.

**Add a smoke assertion.** Assertions live in `tools/smoke.ts` and run against a real browser with the app booted. Wait
on `document.body.dataset.projectReady` rather than a timeout, and state the assertion as the behaviour, not the
implementation — the names are what a failure report shows.

**Update the docs.** Both trees document the current surface. A change to an authored key, a Lua method or a failure
message is a change to `docs/authoring/`; a change to a module boundary, a build step or an invariant is a change to
`docs/development/`.
