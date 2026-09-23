/** CDN URL for the `yaml` ESM build (mirrors the original runtime import). */
export const YAML_ESM_URL: string = "https://cdn.jsdelivr.net/npm/yaml@2.6.0/+esm";

/** CDN URL for the `wasmoon` ESM build (mirrors the original runtime import). */
export const WASMOON_ESM_URL: string = "https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/+esm";

/**
 * Dynamically import a remote ESM module by URL.
 *
 * `url` is deliberately a non-literal expression: keeping the specifier in a
 * variable stops both esbuild and Deno from statically resolving or bundling
 * the remote CDN URL, preserving the original runtime `import('https://…')`
 * behaviour. Callers cast the resolved module to the relevant `*Module` type.
 */
export async function loadEsm<T>(url: string): Promise<T> {
  return (await import(/* @ts-ignore: remote ESM URL resolved at runtime */ url)) as T;
}
