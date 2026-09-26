import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { lua as legacyLua } from "@codemirror/legacy-modes/mode/lua";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { lua, luaCompletion } from "@fazelstudio/codemirror-lang-lua";
import { tags } from "@lezer/highlight";
import { type EditorLanguage } from "./language.ts";
import { luaAssist } from "./lua-assist.ts";

/**
 * Which Lua grammar to run.
 *
 * `lezer` (the default) is a real parser — folding, bracket matching,
 * indentation — but it is a young third-party package. `stream` is CodeMirror's
 * own legacy mode: highlight and indent only, no folding or bracket matching,
 * but maintained. Both are a `LanguageSupport`, so this constant is the whole
 * switch — flip it to `stream` if the Lezer grammar misparses a script.
 */
const LUA_GRAMMAR: "lezer" | "stream" = "lezer";

/**
 * The CodeMirror language for a file, or `null` for plain text.
 *
 * Lua carries the assistant with it, inside the same `Compartment`: completion
 * and hover are only meaningful where the buffer really is Lua, and swapping the
 * language (a tab switch) must take them away again. The grammar's own stdlib
 * completion is passed to `luaAssist` rather than left to `lua()`'s
 * `enableCompletion`, so the two sources are ordered in one place — ours first,
 * and only when it has something to say.
 */
export function languageSupport(language: EditorLanguage): Extension | null {
  if (language === "yaml") return yaml();
  if (language === "lua") {
    if (LUA_GRAMMAR === "stream") return [new LanguageSupport(StreamLanguage.define(legacyLua)), luaAssist()];
    return [lua({ enableCompletion: false }), luaAssist([luaCompletion])];
  }
  return null;
}

/**
 * Marks a transaction that came from `setValue` rather than from typing.
 *
 * A file switch rewrites the whole document, which would otherwise read as an
 * edit: it would persist the buffer and, worse, land on the undo stack, so
 * Ctrl+Z after switching files would restore the *previous* file's text.
 */
const programmaticEdit = Annotation.define<boolean>();

const languageConf = new Compartment();

/** The editor facade the rest of the app uses; no CodeMirror type escapes it. */
export interface CodeEditor {
  getValue(): string;
  setValue(text: string): void;
  setLanguage(language: EditorLanguage): void;
  focus(): void;
  destroy(): void;
}

export interface CodeEditorOptions {
  parent: HTMLElement;
  doc?: string;
  language?: EditorLanguage;
  /** Called for edits made in the editor, never for `setValue`. */
  onChange?: () => void;
  /** Called with the 1-based caret position on every selection or edit. */
  onSelection?: (line: number, column: number) => void;
}

/**
 * Read a shell custom property.
 *
 * The palette lives in `styles/01-shell.css`; reading it here keeps the editor
 * from becoming a second copy of it. The fallback covers a variable being
 * removed from the stylesheet — an empty colour string would otherwise produce
 * invalid CSS and a silently unstyled rule.
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

interface Palette {
  bg: string;
  fg: string;
  gutter: string;
  line: string;
  text: string;
  muted: string;
  gold: string;
  cyan: string;
  red: string;
  panel: string;
}

function palette(): Palette {
  return {
    bg: cssVar("--editor-bg", "#12131b"),
    fg: cssVar("--editor-fg", "#dde1eb"),
    gutter: cssVar("--editor-gutter", "#555b6b"),
    line: cssVar("--editor-line", "#1f222e"),
    text: cssVar("--text", "#eceaf1"),
    muted: cssVar("--muted", "#8990a3"),
    gold: cssVar("--gold", "#f3b74f"),
    cyan: cssVar("--cyan", "#79d6d2"),
    red: cssVar("--red", "#ee7c78"),
    panel: cssVar("--panel", "#141620"),
  };
}

/** Editor chrome, in the shell's palette. */
function theme(p: Palette): ReturnType<typeof EditorView.theme> {
  return EditorView.theme({
    "&": { height: "100%", backgroundColor: p.bg, color: p.fg, fontSize: "14px" },
    ".cm-scroller": {
      fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace",
      lineHeight: "1.68",
      overflow: "auto",
    },
    ".cm-content": { padding: "16px 18px", tabSize: "2", caretColor: p.gold },
    ".cm-line": { padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.gold, borderLeftWidth: "2px" },
    ".cm-selectionBackground": { backgroundColor: "#332e4a" },
    "&.cm-focused .cm-selectionBackground": { backgroundColor: "#443c66" },
    ".cm-content ::selection": { backgroundColor: "#443c66" },
    ".cm-activeLine": { backgroundColor: "#191b25" },
    ".cm-selectionMatch": { backgroundColor: "#2f3a46" },
    ".cm-gutters": {
      backgroundColor: p.bg,
      color: p.gutter,
      border: "none",
      borderRight: `1px solid ${p.line}`,
      paddingRight: "6px",
    },
    ".cm-activeLineGutter": { backgroundColor: "#191b25", color: p.muted },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "#3c4553",
      color: p.cyan,
    },
    ".cm-panels": { backgroundColor: p.panel, color: p.text, borderColor: p.line },
    ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${p.line}` },
    ".cm-panel.cm-search": { padding: "8px 10px" },
    ".cm-panel.cm-search input": {
      backgroundColor: "#1b1e2a",
      border: `1px solid #303646`,
      borderRadius: "4px",
      color: p.text,
      padding: "5px 7px",
      outline: "none",
    },
    ".cm-panel.cm-search label": { color: p.muted, fontSize: "11px" },
    ".cm-panel.cm-search button": {
      backgroundColor: "transparent",
      border: `1px solid ${p.line}`,
      borderRadius: "5px",
      color: p.text,
      padding: "5px 9px",
    },
    ".cm-button": { backgroundImage: "none", backgroundColor: "transparent" },
    ".cm-tooltip": {
      backgroundColor: p.panel,
      border: `1px solid ${p.line}`,
      borderRadius: "6px",
      color: p.text,
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "#292533",
      color: p.text,
    },
    ".cm-completionLabel": { fontSize: "13px" },
    ".cm-completionDetail": { color: p.muted, fontStyle: "normal", marginLeft: "8px" },
    ".cm-completionInfo": {
      backgroundColor: p.panel,
      border: `1px solid ${p.line}`,
      color: p.muted,
      padding: "8px 10px",
      maxWidth: "320px",
    },
    // The Lua assistant's documentation panel, shared by the completion info
    // popup and the hover tooltip.
    ".cm-tooltip-hover:has(.lua-doc)": { padding: "8px 10px", maxWidth: "360px" },
    ".lua-doc-signature": {
      fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace",
      fontSize: "12.5px",
      color: p.gold,
    },
    ".lua-doc-summary": { color: p.muted, lineHeight: "1.5", marginTop: "3px" },
  }, { dark: true });
}

/** Token colours, in the shell's palette. */
function highlight(p: Palette): HighlightStyle {
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: p.cyan },
    { tag: [tags.string, tags.special(tags.string), tags.character], color: p.gold },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: p.gutter, fontStyle: "italic" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#e0a3c0" },
    { tag: [tags.propertyName, tags.attributeName], color: p.text },
    { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: "#9ec7a8" },
    { tag: [tags.typeName, tags.className, tags.namespace], color: p.cyan },
    { tag: [tags.operator, tags.punctuation], color: p.muted },
    { tag: [tags.meta, tags.documentMeta], color: "#8b93a7" },
    { tag: [tags.link, tags.url], color: p.cyan, textDecoration: "underline" },
    { tag: tags.heading, color: p.gold, fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.invalid, color: p.red },
  ]);
}

/**
 * Mount a CodeMirror editor and return the app's facade for it.
 *
 * Extensions are kept to what an author of prose and small scripts needs:
 * line numbers, indentation that follows the language, bracket matching, undo,
 * find, and active-line highlighting. Wrapping is deliberately off — the
 * textarea it replaces used `white-space: pre`, and YAML indentation is easier
 * to read unwrapped.
 */
export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  const p = palette();

  const reportSelection = (state: EditorState): void => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    options.onSelection?.(line.number, head - line.from + 1);
  };

  const state = EditorState.create({
    doc: options.doc ?? "",
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      indentUnit.of("  "),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      languageConf.of(languageSupport(options.language ?? null) ?? []),
      EditorView.contentAttributes.of({
        "aria-label": "Game source",
        spellcheck: "false",
        autocapitalize: "off",
      }),
      EditorView.updateListener.of((update) => {
        const programmatic = update.transactions.some((tr) => tr.annotation(programmaticEdit));
        if (update.docChanged && !programmatic) options.onChange?.();
        if (update.docChanged || update.selectionSet) reportSelection(update.state);
      }),
      theme(p),
      syntaxHighlighting(highlight(p)),
    ],
  });

  const view = new EditorView({ state, parent: options.parent });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (text: string) => {
      // Skipping an identical document keeps a tab switch from costing a
      // transaction (and a scroll reset) when the file has not changed.
      if (view.state.doc.toString() === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        annotations: [programmaticEdit.of(true), Transaction.addToHistory.of(false)],
      });
      view.scrollDOM.scrollTop = 0;
    },
    setLanguage: (language: EditorLanguage) => {
      view.dispatch({ effects: languageConf.reconfigure(languageSupport(language) ?? []) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
