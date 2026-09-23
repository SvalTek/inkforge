import type { LuaCallback } from "./lua.ts";
import type { ResolvedUiElement } from "./ui.ts";

/** Affine 2D transform matrix, matching the runtime's `{a,b,c,d,e,f}` shape. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/** A logical point with optional pseudo-3D elevation. */
export interface CanvasWorldPoint extends Point {
  z: number;
}

/** Named easing function key (see `InkforgeCanvasRuntime.easings`). */
export type CanvasEasingName = string;

/** A sprite-sheet frame rectangle. */
export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Optional custom hit-testing spec attached to a node via `node.hit`. */
export interface CanvasHitSpec {
  type?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  radius?: number;
  points?: CanvasPointInput[];
  padding?: number;
  tolerance?: number;
}

/** A node event binding: a callback reference string or an object wrapper. */
export type CanvasEventBinding = string | { callback?: string };

/** Coordinate space used by a node or layer. */
export type CanvasSpace = "world" | "screen";

/** Projection family and parameters used by a viewport. */
export interface CanvasProjectionSpec {
  type?: "flat" | "isometric" | "oblique";
  origin?: Point;
  originX?: number;
  originY?: number;
  tileWidth?: number;
  tileHeight?: number;
  elevation?: number;
  skew?: number;
}

/** Runtime projection contract used by drawing and inverse hit-testing. */
export interface CanvasProjection {
  readonly type: "flat" | "isometric" | "oblique";
  project(point: CanvasWorldPoint): Point;
  unproject(point: Point, elevation?: number): CanvasWorldPoint;
  depth(point: CanvasWorldPoint): number;
  transform(matrix: Matrix, elevation: number): Matrix;
}

/** Composition and ordering policy for a scene layer. */
export interface CanvasLayerSpec {
  id: string;
  order?: number;
  space?: CanvasSpace;
  sort?: "order" | "depth";
}

/** Point input accepted from Lua: `{x,y}`, `[x,y]`, or a dynamic record. */
export type CanvasPointInput = Point | [number, number] | Record<string, unknown>;

/**
 * A dynamic drawable node. Declared fields mirror the runtime's known reads;
 * the index signature carries arbitrary Lua-supplied keys.
 */
export interface CanvasNode {
  id: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  width?: number;
  height?: number;
  radius?: number;
  originX?: number;
  originY?: number;
  parentId?: string | null;
  layer?: string;
  space?: CanvasSpace;
  z?: number;
  elevation?: number;
  depth?: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
  strokeWidth?: number;
  blend?: string;
  lineCap?: string;
  lineJoin?: string;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  fontSize?: number;
  fontWeight?: number | string;
  fontFamily?: string;
  align?: string;
  baseline?: string;
  text?: unknown;
  maxWidth?: number;
  asset?: string;
  frame?: CanvasFrame;
  points?: CanvasPointInput[];
  closed?: boolean;
  cursor?: string;
  hit?: CanvasHitSpec;
  interactive?: boolean;
  events?: Record<string, CanvasEventBinding>;
  children?: CanvasNode[];
  [key: string]: unknown;
}

/** Viewport configuration for a scene. */
export interface CanvasViewport {
  width: number;
  height: number;
  fit: "contain" | "cover" | "stretch" | string;
  projection?: CanvasProjectionSpec;
}

/** Scene creation spec passed to `scene.create`. */
export interface CanvasSceneSpec {
  id: string;
  viewport?: Partial<CanvasViewport>;
  background?: string;
  accessibleLabel?: string;
  layers?: CanvasLayerSpec[];
  nodes?: CanvasNode[];
}

/** Internal runtime scene record (`createScene` output). */
export interface CanvasScene {
  id: string;
  viewport: CanvasViewport;
  projection: CanvasProjection;
  layers: CanvasLayerSpec[];
  background: string;
  accessibleLabel: string;
  nodes: Map<string, CanvasNode>;
  order: string[];
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  view: CanvasViewState | null;
  hitStack: CanvasHitEntry[];
  hoverNode: CanvasNode | null;
  pointerNode: CanvasNode | null;
}

/** Computed viewport transform stored on a scene after a draw. */
export interface CanvasViewState {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
}

/** A hit-test stack entry pairing a node with its world matrix. */
export interface CanvasHitEntry {
  node: CanvasNode;
  matrix: Matrix;
}

/** Animation control verbs accepted by `animation.control`. */
export type CanvasAnimationAction = "pause" | "resume" | "cancel" | "finish" | string;

/** Tween/keyframe options (`options` in `animation.create`/`keyframes`). */
export interface CanvasAnimationOptions {
  duration?: number;
  easing?: CanvasEasingName;
  repeat_count?: number;
  yoyo?: boolean;
}

/** A single keyframe: an `at` time plus arbitrary interpolated keys. */
export interface CanvasKeyframe {
  at?: number;
  [key: string]: unknown;
}

/** Canvas command union mirroring the runtime `command()` switch. */
export type CanvasCommand =
  | { op: "scene.create"; scene: CanvasSceneSpec }
  | { op: "scene.clear"; sceneId?: string }
  | { op: "scene.remove"; sceneId?: string }
  | { op: "node.add"; sceneId?: string; node: CanvasNode }
  | { op: "node.set"; sceneId?: string; nodeId?: string; values: Record<string, unknown> }
  | { op: "node.translate"; sceneId?: string; nodeId?: string; dx?: number; dy?: number }
  | { op: "node.remove"; sceneId?: string; nodeId?: string }
  | { op: "event.set"; sceneId?: string; nodeId?: string; event: string; binding: CanvasEventBinding }
  | { op: "event.remove"; sceneId?: string; nodeId?: string; event: string }
  | {
    op: "animation.create";
    id: string;
    sceneId?: string;
    nodeId?: string;
    values: Record<string, unknown>;
    options?: CanvasAnimationOptions;
  }
  | {
    op: "animation.keyframes";
    id: string;
    sceneId?: string;
    nodeId?: string;
    keyframes: CanvasKeyframe[];
    options?: CanvasAnimationOptions;
  }
  | { op: "animation.control"; id: string; action: CanvasAnimationAction };

/** Timer command union mirroring the runtime `timer()` switch. */
export type TimerCommand =
  | {
    op: "create";
    id: string;
    delay?: number;
    callback?: string;
    repeating?: boolean;
    repeatCount?: number;
    immediate?: boolean;
  }
  | { op: "pause" | "resume" | "restart" | "cancel"; id: string };

/** Internal runtime timer record. */
export interface CanvasTimer {
  id: string;
  delay: number;
  remaining: number;
  callback?: string;
  repeating: boolean;
  repeatCount: number;
  iteration: number;
  active: boolean;
  paused: boolean;
}

/** Internal tween animation record. */
export interface CanvasTweenAnimation {
  id: string;
  kind: "tween";
  sceneId: string;
  nodeId: string;
  start: Record<string, unknown>;
  target: Record<string, unknown>;
  duration: number;
  easing: CanvasEasingName;
  repeatCount: number;
  yoyo: boolean;
  elapsed: number;
  iteration: number;
  reversed: boolean;
  paused: boolean;
}

/** Internal keyframe animation record. */
export interface CanvasKeyframesAnimation {
  id: string;
  kind: "keyframes";
  sceneId: string;
  nodeId: string;
  frames: CanvasKeyframe[];
  duration: number;
  easing: CanvasEasingName;
  repeatCount: number;
  yoyo: boolean;
  elapsed: number;
  iteration: number;
  reversed: boolean;
  paused: boolean;
}

/** Internal animation record (tween or keyframes). */
export type CanvasAnimation = CanvasTweenAnimation | CanvasKeyframesAnimation;

/** Per-frame Lua update callback passed to `setUpdate`. */
export type CanvasUpdate = (dt: number) => void;

/** Event payload forwarded to Lua via `__canvas_event`. */
export interface CanvasPointerEvent {
  sceneId: string;
  nodeId: string;
  type: string;
  x: number;
  y: number;
  localX: number;
  localY: number;
  button: number;
  pointerType: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** Host hooks the runtime calls back into (`InkforgeCanvasRuntime` options). */
export interface CanvasHooks {
  callLua?: (callback: LuaCallback | null, dt: number) => void;
  ensureSurface?: (id: string, label: string) => void;
  removeSurface?: (id: string) => void;
  asset?: (path: string) => string | undefined;
  event?: (reference: string, event: CanvasPointerEvent) => void;
  timer?: (reference: string, id: string, iteration: number) => void;
  afterFrame?: () => void;
}

/** Public surface of the canvas runtime class. */
export interface CanvasHost {
  command(command: CanvasCommand): void;
  timer(command: TimerCommand): void;
  timerRemaining(id: string): number;
  timerActive(id: string): boolean;
  setUpdate(callback: CanvasUpdate | null): void;
  mountSurfaces(elements: ResolvedUiElement[]): void;
  destroy(): void;
}
