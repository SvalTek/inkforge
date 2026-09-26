/**
 * Which language a file is edited as — pure policy, no editor dependency.
 *
 * This module deliberately imports nothing. `src/editor/codemirror.ts` binds
 * these answers to a grammar, and non-browser callers (the pack tools reach the
 * editor through `src/import-export/pack.ts`) stay out of the editor's module
 * graph: CodeMirror's Lezer runtime probes `process.env` on import, which makes
 * it unusable outside the browser bundle.
 */

/** The languages the Author view edits. `null` means plain text. */
export type EditorLanguage = "lua" | "yaml" | null;

/** The grammar a VFS path is edited with. */
export function languageForPath(path: string): EditorLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".lua")) return "lua";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return null;
}

/** The footer badge text for a language, so the badge cannot disagree with the grammar. */
export function badgeForLanguage(language: EditorLanguage): string {
  if (language === "lua") return "LUA";
  if (language === "yaml") return "YAML";
  return "";
}
