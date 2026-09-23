import type { ToolDefinition, ToolEntry, ToolIcon, ToolRegistry } from "../types/index.ts";

function validIcon(icon: unknown): icon is ToolIcon {
  return typeof icon === "string" || (
    !!icon && typeof icon === "object" && typeof (icon as { image?: unknown }).image === "string"
  );
}

/** Validate and copy one authored/runtime tool definition. */
export function normalizeTool(value: unknown): ToolDefinition {
  if (!value || typeof value !== "object") throw new Error("Tool must be a mapping.");
  const candidate = value as Partial<ToolDefinition>;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) throw new Error("Tool needs a non-empty id.");
  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    throw new Error(`Tool ${candidate.id} needs a non-empty label.`);
  }
  if (candidate.icon !== undefined && !validIcon(candidate.icon)) {
    throw new Error(`Tool ${candidate.id} has an invalid icon.`);
  }
  if (candidate.modal !== undefined && typeof candidate.modal !== "string") {
    throw new Error(`Tool ${candidate.id} has an invalid modal target.`);
  }
  if (candidate.action !== undefined && typeof candidate.action !== "string") {
    throw new Error(`Tool ${candidate.id} has an invalid action target.`);
  }
  return {
    id: candidate.id,
    label: candidate.label,
    ...(candidate.icon === undefined
      ? {}
      : { icon: typeof candidate.icon === "string" ? candidate.icon : { ...candidate.icon } }),
    ...(candidate.modal === undefined ? {} : { modal: candidate.modal }),
    ...(candidate.action === undefined ? {} : { action: candidate.action }),
  };
}

/** Create the one registry shared by authored YAML and runtime Lua tools. */
export function createToolRegistry(definitions: ToolDefinition[] = []): ToolRegistry {
  const registry: ToolRegistry = { entries: new Map() };
  for (const definition of definitions) registerTool(registry, definition, "yaml");
  return registry;
}

/** Upsert a tool entry while preserving the explicit source of the registration. */
export function registerTool(
  registry: ToolRegistry,
  value: unknown,
  source: ToolEntry["source"] = "lua",
): ToolEntry {
  const definition = normalizeTool(value);
  const entry: ToolEntry = { definition, hidden: false, disabled: false, source };
  registry.entries.set(definition.id, entry);
  return entry;
}

export function removeTool(registry: ToolRegistry, id: string): void {
  registry.entries.delete(id);
}

export function setToolHidden(registry: ToolRegistry, id: string, hidden: boolean): void {
  const entry = registry.entries.get(id);
  if (entry) entry.hidden = hidden;
}

export function setToolDisabled(registry: ToolRegistry, id: string, disabled: boolean): void {
  const entry = registry.entries.get(id);
  if (entry) entry.disabled = disabled;
}

/** Return entries in authored/registration order, excluding hidden tools. */
export function visibleTools(registry: ToolRegistry): ToolEntry[] {
  return [...registry.entries.values()].filter((entry) => !entry.hidden);
}
