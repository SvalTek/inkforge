/**
 * Helpers for values arriving from Lua.
 *
 * Lua has a single table type, so it cannot distinguish an empty array from an
 * empty object: `{}` crosses the bridge as a JS object rather than `[]`. Any
 * field documented as an array must be coerced here, otherwise an authored
 * empty collection arrives as a non-iterable object and crashes the consumer.
 *
 * Non-empty tables are converted to real JS arrays by the bridge, so this is
 * only about the empty case.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
