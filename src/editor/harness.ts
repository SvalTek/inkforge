import type { CodeEditor } from "./codemirror.ts";

/** The page-side editor hook the browser harnesses use. */
export interface EditorHarness {
  /** The full buffer text. */
  getValue(): string;
  /** Replace the buffer as an author's edit — see `installEditorHarness`. */
  setValue(text: string): void;
}

declare global {
  var inkforgeEditor: EditorHarness | undefined;
}

/**
 * Publish the editor's buffer to the browser harnesses.
 *
 * `tools/smoke.ts` and `tools/authoring-check.ts` drive the Author view through
 * Playwright, and they cannot read the buffer off the page: CodeMirror renders
 * only the lines in view, so `.cm-content`'s text would silently truncate on a
 * long file, and the old `#code` textarea reads (`inputValue`, `fill`) do not
 * exist on a `div`. Those tests reach for this hook instead — `tools/*` declares
 * the cast locally against `EditorHarness`, since a `page.evaluate` callback is
 * serialised into the page and can only reference in-page values.
 *
 * `setValue` models an *author's* edit, not a file switch: it replaces the
 * buffer and then runs `onEdit` — the same path typing takes — so a test that
 * writes text still exercises `#saved`, the debounced persist and the export
 * flush. (`CodeEditor.setValue` alone stays silent, because a tab switch must
 * not read as an edit.)
 */
export function installEditorHarness(editor: CodeEditor, onEdit: () => void): void {
  globalThis.inkforgeEditor = {
    getValue: () => editor.getValue(),
    setValue: (text: string) => {
      editor.setValue(text);
      onEdit();
    },
  };
}
