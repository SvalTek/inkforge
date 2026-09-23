import type { UiElement } from "./ui.ts";

/** A rail icon rendered as text/Unicode/emoji or resolved from a project asset. */
export type ToolIcon = string | { image: string };

/** A shell-level authored launcher declared in YAML or registered by Lua. */
export interface ToolDefinition {
  id: string;
  label: string;
  icon?: ToolIcon;
  modal?: string;
  action?: string;
}

/** A discrete authored window model with a recursive UI element tree. */
export interface ModalDefinition {
  id: string;
  title?: string;
  kicker?: string;
  dismissible?: boolean;
  elements?: UiElement[];
}

/** A tool definition plus mutable state held for the current runtime. */
export interface ToolEntry {
  definition: ToolDefinition;
  hidden: boolean;
  disabled: boolean;
  source: "yaml" | "lua";
}

/** Shared registry consumed by the rail and mutated by YAML/Lua integration. */
export interface ToolRegistry {
  entries: Map<string, ToolEntry>;
}

/** Runtime state for the modal host; reset whenever a project runtime is rebuilt. */
export interface ModalRuntimeState {
  open: string | null;
  activePages: Record<string, string>;
}
