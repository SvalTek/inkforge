/** A Lua-facing value; dynamic by nature, so it stays `unknown`. */
export type LuaValue = unknown;

/** A Lua function reference handed to/from the host (events, timers, `update`). */
export type LuaCallback = (...args: unknown[]) => unknown;

/** A custom YAML tag resolver (used for `!import` and `!mixin`). */
export interface CustomTag {
  tag: string;
  resolve(value: string): unknown;
}

/** A parsed YAML document (subset of the `yaml` package's Document). */
export interface YamlDocument {
  errors: { message: string }[];
  toJS(): unknown;
}

/** Shape of the dynamic `yaml` ESM module. */
export interface YamlModule {
  parse(text: string): unknown;
  parseDocument(source: string, options?: { customTags?: unknown[] }): YamlDocument;
}
