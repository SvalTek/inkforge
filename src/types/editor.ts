/** Editor format label derived from the active file extension. */
export type EditorFormat = "YAML" | "LUA";

/** Author-mode editor state: the active VFS path and its format label. */
export interface EditorState {
  current: string;
  format: EditorFormat;
}
