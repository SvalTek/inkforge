import type { EngineRuntime, ResolvedUiElement, UiCommand, UiElement, UiField, UiOverride } from "../types/index.ts";

export function applyUi(command: UiCommand, runtime: EngineRuntime): void {
  const c: UiCommand = command || {};
  if (c.show) runtime.ui.hidden.delete(c.show);
  if (c.hide) runtime.ui.hidden.add(c.hide);
  if (c.remove) runtime.ui.elements = runtime.ui.elements.filter((e) => e.id !== c.remove);
  if (c.create) runtime.ui.elements.push(c.create as UiElement);
  if (c.set) {
    for (const [id, props] of Object.entries(c.set)) {
      const override = props as UiOverride;
      runtime.ui.overrides[id] = { ...(runtime.ui.overrides[id] || {}), ...override };
      runtime.events.push({ type: "ui:update", elementId: id });
    }
  }
}

export function resolveField(field: UiField | undefined, runtime: EngineRuntime): unknown {
  if (!field) return undefined;
  if (field.type === "state") return runtime.state[field.path as string];
  return field.value;
}

export function uiFields(element: UiElement, runtime: EngineRuntime): Record<string, unknown> {
  const override: UiOverride = runtime.ui.overrides[element.id] || {};
  const values = Object.fromEntries(
    (element.fields || []).map((f) => [f.id, resolveField(f, runtime)]),
  ) as Record<string, unknown>;
  if (Array.isArray(override.fields)) {
    Object.assign(
      values,
      Object.fromEntries(override.fields.map((f) => [f.id, resolveField(f, runtime)])) as Record<string, unknown>,
    );
  } else if (override.fields) {
    for (const [id, value] of Object.entries(override.fields)) {
      values[id] = typeof value === "object" ? resolveField(value as UiField, runtime) : value;
    }
  }
  return values;
}

export function uiElement(element: UiElement, runtime: EngineRuntime, runtimePath = element.id): ResolvedUiElement {
  return {
    ...element,
    ...(runtime.ui.overrides[element.id] || {}),
    values: uiFields(element, runtime),
    runtimePath,
    elements: element.elements?.map((nested) => uiElement(nested, runtime, `${runtimePath}.${nested.id}`)),
  } as ResolvedUiElement;
}
