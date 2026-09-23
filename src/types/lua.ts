/** A Lua-facing value; dynamic by nature, so it stays `unknown`. */
export type LuaValue = unknown;

/** A Lua function reference handed to/from the host (events, timers, `update`). */
export type LuaCallback = (...args: unknown[]) => unknown;

/** Global table bridge exposed by a wasmoon engine (`lua.global`). */
export interface LuaGlobal {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  close(): void;
}

/** A live wasmoon Lua engine. */
export interface LuaEngine {
  global: LuaGlobal;
  doString(source: string): Promise<unknown>;
  doFile(path: string): Promise<unknown>;
}

/** Options accepted by `LuaFactory.createEngine`. */
export interface LuaFactoryOptions {
  injectObjects?: boolean;
}

/** wasmoon factory: mounts VFS Lua files, then creates engines. */
export interface LuaFactory {
  mountFile(path: string, content: string): Promise<void>;
  createEngine(options?: LuaFactoryOptions): Promise<LuaEngine>;
}

/** Shape of the dynamic `wasmoon` ESM module. */
export interface WasmoonModule {
  LuaFactory: new () => LuaFactory;
}

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
