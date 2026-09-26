/**
 * Lua completion and hover for the Author view, driven by
 * `src/lua/api-manifest.ts`.
 *
 * This is deliberately thin: all the knowledge is in the manifest, and this file
 * only decides *where* in the buffer a name is being typed. It answers four
 * positions —
 *
 * - a bare name at statement start: the namespaces, the `js_*` globals, the
 *   lifecycle functions
 * - after `<Namespace>.` or `<Namespace>:`: that namespace's members
 * - inside the string of `Events:On("…")` / `Events:Emit("…")`: event names
 * - hovering any of the above: the same description the popup shows
 *
 * The source returns `null` whenever it has nothing to offer, rather than an
 * empty result: `codemirror.ts` installs the Lua grammar's own stdlib
 * completion behind this one, and CodeMirror takes the *first* source that
 * produces options. Bailing out is what lets `string.` and `table.` still
 * complete.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippetCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import {
  LUA_API_MANIFEST,
  LUA_CANVAS_HANDLES,
  LUA_EVENT_NAMES,
  LUA_GLOBAL_FUNCTIONS,
  LUA_LIFECYCLE,
  type LuaApiEntry,
  type LuaApiNamespace,
} from "../lua/api-manifest.ts";

/** A name and its description, as the popup and the hover panel show it. */
interface LuaDocEntry {
  /** The call site, e.g. `GameState.get(path)`. */
  signature: string;
  summary: string;
}

/**
 * The documented spelling of a member — `<Namespace><call><name><args>`, so the
 * popup shows `Events:On(event, handler)` even though `Events.On(...)` also
 * works.
 */
function qualified(namespace: LuaApiNamespace, entry: LuaApiEntry): string {
  return `${namespace.name}${namespace.call}${entry.name}${entry.args}`;
}

/** What the editor inserts for an entry, as a snippet with a tab stop. */
function snippetTemplate(entry: LuaApiEntry, prefix: string): string {
  if (entry.template) return `${prefix}${entry.template}`;
  // `args` is the argument list as documented: `(text)`, or `()` / `` for
  // something that is not called at all.
  const body = entry.args.slice(1, -1).trim();
  if (entry.args === "") return `${prefix}${entry.name}`;
  // `\${}` is a CodeMirror snippet tab stop, not interpolation.
  return body ? `${prefix}${entry.name}(\${})` : `${prefix}${entry.name}()`;
}

function docPanel(entries: readonly LuaDocEntry[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "lua-doc";
  for (const entry of entries) {
    const signature = document.createElement("div");
    signature.className = "lua-doc-signature";
    signature.textContent = entry.signature;
    const summary = document.createElement("div");
    summary.className = "lua-doc-summary";
    summary.textContent = entry.summary;
    root.append(signature, summary);
  }
  return root;
}

function docFor(entries: readonly LuaDocEntry[]): () => HTMLElement {
  return () => docPanel(entries);
}

/** A member completed under its namespace. */
function memberOption(namespace: LuaApiNamespace, entry: LuaApiEntry): Completion {
  const doc: LuaDocEntry = { signature: qualified(namespace, entry), summary: entry.summary };
  return snippetCompletion(snippetTemplate(entry, ""), {
    label: entry.name,
    type: "method",
    detail: entry.args === "" ? entry.name : entry.args,
    info: docFor([doc]),
  });
}

/** A name offered where no namespace is open: a namespace, a global, a lifecycle function. */
function statementOption(entry: LuaApiEntry, type: Completion["type"], detail: string): Completion {
  const doc: LuaDocEntry = { signature: `${entry.name}${entry.args}`, summary: entry.summary };
  return snippetCompletion(snippetTemplate(entry, ""), { label: entry.name, type, detail, info: docFor([doc]) });
}

/** A namespace name, which is never called, so it is offered bare. */
function namespaceOption(namespace: LuaApiNamespace): Completion {
  const doc: LuaDocEntry = { signature: namespace.name, summary: namespace.summary };
  return { label: namespace.name, type: "namespace", detail: "namespace", info: docFor([doc]) };
}

/**
 * The string immediately after a quote that follows `Events:On(` / `Events:Emit(`,
 * if the cursor is in one.
 */
const EVENT_STRING = /Events\s*:\s*(?:On|Emit)\s*\(\s*(["'])([^"']*)$/;

/** `<Owner>.` / `<Owner>:` / `<Owner>.par`, with the partial name if there is one. */
const MEMBER = /([A-Za-z_]\w*)\s*([.:])([A-Za-z_]\w*)?$/;

const WORD = /[A-Za-z_]\w*/;

/**
 * What the source's result stays valid for.
 *
 * `*`, not `+`: completion has to open on the separator alone — after
 * `GameState.` the query is empty — and `validFor` is what decides whether the
 * result survives the keystrokes that follow. Requiring a word character here
 * would leave the member list unable to appear until something was typed after
 * the dot.
 */
const QUERY = /^\w*$/;

/** A dotted or colon-called token, for hover. */
const TOKEN = /[A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*)*/g;

export const luaApiCompletion: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  // 1. An event name inside `Events:On("…")` or `Events:Emit("…")`.
  const event = EVENT_STRING.exec(before);
  if (event) {
    return {
      from: context.pos - event[2].length,
      options: LUA_EVENT_NAMES.map((entry) => statementOption(entry, "constant", "event")),
      validFor: /^[^"']*$/,
    };
  }

  // 2. A member of a namespace, which is the one position a partially typed
  //    name can still be recognised — the separator is before it.
  const member = MEMBER.exec(before);
  if (member) {
    const namespace = LUA_API_MANIFEST.find((candidate) => candidate.name === member[1]);
    if (!namespace) return null;
    const partial = member[3] ?? "";
    const options = namespace.members
      .filter((entry) => entry.name.startsWith(partial))
      .map((entry) => memberOption(namespace, entry));
    return options.length ? { from: context.pos - partial.length, options, validFor: QUERY } : null;
  }

  // 3. A bare name. Everything offered here is filtered by what has been typed,
  //    and an empty field hands over to the grammar's own completion.
  const word = context.matchBefore(WORD);
  if (!word && !context.explicit) return null;
  const prefix = word?.text ?? "";
  const options: Completion[] = [
    ...LUA_API_MANIFEST.map(namespaceOption),
    ...LUA_GLOBAL_FUNCTIONS.map((entry) => statementOption(entry, "function", entry.args)),
    ...LUA_LIFECYCLE.map((entry) => statementOption(entry, "function", entry.args)),
  ].filter((option) => option.label.startsWith(prefix));
  if (!options.length) return null;
  return { from: word?.from ?? context.pos, options, validFor: QUERY };
};

/**
 * Document the name under the cursor.
 *
 * A handle's members are resolved by name alone, since a variable's type is not
 * knowable from the buffer — so `scene:add` is found through the member list,
 * and a name carried by more than one handle kind lists each one rather than
 * guessing.
 */
function resolveDoc(token: string): LuaDocEntry[] | null {
  const segments = token.split(/[.:]/).map((segment) => segment.trim());

  if (segments.length === 1) {
    const [name] = segments;
    const namespace = LUA_API_MANIFEST.find((candidate) => candidate.name === name);
    if (namespace) return [{ signature: namespace.name, summary: namespace.summary }];
    const entry = [...LUA_GLOBAL_FUNCTIONS, ...LUA_LIFECYCLE].find((candidate) => candidate.name === name);
    if (entry) return [{ signature: `${entry.name}${entry.args}`, summary: entry.summary }];
    return null;
  }

  const owner = segments[0];
  const memberName = segments[segments.length - 1];
  const namespace = LUA_API_MANIFEST.find((candidate) => candidate.name === owner);
  if (namespace) {
    const entry = namespace.members.find((candidate) => candidate.name === memberName);
    return entry ? [{ signature: qualified(namespace, entry), summary: entry.summary }] : null;
  }

  // A handle's members are called with `:` — they are Lua-defined functions
  // taking an implicit self (`facades/canvas.ts`), unlike the dot-called host
  // namespaces.
  const handles = LUA_CANVAS_HANDLES.flatMap((handle) =>
    handle.members
      .filter((member) => member.name === memberName)
      .map((member) => ({ signature: `${owner}:${member.name}${member.args}`, summary: member.summary }))
  );
  return handles.length ? handles : null;
}

/**
 * The chain truncated at the segment the cursor is on.
 *
 * Hovering `GameState` in `GameState.get("oil")` documents the namespace;
 * hovering `get` documents the method, because the chain up to that segment is
 * what has a meaning of its own. A cursor on the separator reads as the segment
 * before it.
 */
function pathAt(chain: string, index: number): string {
  const segment = /[A-Za-z_]\w*/g;
  let seen = chain;
  for (let match = segment.exec(chain); match; match = segment.exec(chain)) {
    seen = chain.slice(0, match.index + match[0].length);
    if (index <= match.index + match[0].length) break;
  }
  return seen;
}

export const luaApiHover: Extension = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const offset = pos - line.from;
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(line.text); match; match = TOKEN.exec(line.text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset < start || offset > end) continue;
    const path = pathAt(match[0], offset - start);
    const entries = resolveDoc(path);
    if (!entries) return null;
    return {
      pos: line.from + start,
      end: line.from + start + path.length,
      above: true,
      create: () => ({ dom: docPanel(entries) }),
    };
  }
  return null;
});

/**
 * Completion and hover for a Lua buffer.
 *
 * `stdlib` is the grammar's own completion source, passed in by
 * `codemirror.ts` so this module never depends on which Lua grammar is
 * installed.
 */
export function luaAssist(stdlib: readonly CompletionSource[] = []): Extension {
  return [
    autocompletion({
      // Our source is offered first: CodeMirror takes the first one that
      // produces options, and ours returns `null` rather than an empty list
      // when it has nothing, so the stdlib completes after it.
      override: [luaApiCompletion, ...stdlib],
      maxRenderedOptions: 30,
    }),
    luaApiHover,
  ];
}
