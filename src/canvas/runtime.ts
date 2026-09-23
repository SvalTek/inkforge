import {
  interpolate as interpolateValue,
  invert as invertMatrix,
  multiply as multiplyMatrices,
  nodeMatrix as nodeMatrixOf,
  pointX,
  pointY,
  polygonContains,
  segmentDistance as segmentDistanceOf,
  transform as transformPoint,
} from "./math.ts";
import { type EasingFn, EASINGS } from "./easings.ts";
import { createProjection, nodeElevation } from "./projection.ts";
import type {
  CanvasAnimation,
  CanvasAnimationOptions,
  CanvasCommand,
  CanvasHitEntry,
  CanvasHooks,
  CanvasHost,
  CanvasKeyframe,
  CanvasKeyframesAnimation,
  CanvasLayerSpec,
  CanvasNode,
  CanvasPointerEvent,
  CanvasPointInput,
  CanvasScene,
  CanvasSceneSpec,
  CanvasSpace,
  CanvasTimer,
  CanvasTweenAnimation,
  CanvasUpdate,
  CanvasViewport,
  CanvasViewState,
  Matrix,
  Point,
  TimerCommand,
} from "../types/canvas.ts";
import type { ResolvedUiElement } from "../types/ui.ts";

type CreateTweenCommand = Extract<CanvasCommand, { op: "animation.create" }>;
type CreateKeyframesCommand = Extract<CanvasCommand, { op: "animation.keyframes" }>;

export class InkforgeCanvasRuntime implements CanvasHost {
  static easings: Record<string, EasingFn> = EASINGS;

  host: HTMLElement;
  hooks: CanvasHooks;
  scenes: Map<string, CanvasScene>;
  timers: Map<string, CanvasTimer>;
  animations: Map<string, CanvasAnimation>;
  images: Map<string, { image: HTMLImageElement; ready: boolean; failed: boolean }>;
  update: CanvasUpdate | null;
  frameId: number | null;
  lastFrame: number;

  constructor(host: HTMLElement, hooks: CanvasHooks = {}) {
    this.host = host;
    this.hooks = hooks;
    this.scenes = new Map();
    this.timers = new Map();
    this.animations = new Map();
    this.images = new Map();
    this.update = null;
    this.frameId = null;
    this.lastFrame = 0;
  }

  destroy(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.scenes.clear();
    this.timers.clear();
    this.animations.clear();
    this.images.clear();
    this.update = null;
    this.host.replaceChildren();
  }

  setUpdate(callback: CanvasUpdate | null): void {
    this.update = typeof callback === "function" ? callback : null;
    if (this.update) this.schedule();
  }

  schedule(): void {
    if (this.frameId !== null) return;
    this.frameId = requestAnimationFrame((time) => this.tick(time));
  }

  tick(time: number): void {
    this.frameId = null;
    const dt = this.lastFrame ? Math.min(Math.max((time - this.lastFrame) / 1000, 0), 0.1) : 0;
    this.lastFrame = time;
    this.advanceTimers(dt);
    this.hooks.callLua?.(this.update as Parameters<NonNullable<CanvasHooks["callLua"]>>[0], dt);
    this.advanceAnimations(dt);
    this.draw();
    this.hooks.afterFrame?.();
    if (this.update || this.hasClockWork()) this.schedule();
  }

  hasClockWork(): boolean {
    return [...this.timers.values()].some((timer) => timer.active && !timer.paused) ||
      [...this.animations.values()].some((animation) => !animation.paused);
  }

  resetClock(): void {
    this.lastFrame = performance.now();
  }

  command(command: CanvasCommand): void {
    const cmd = command as CanvasCommand & { sceneId?: string; nodeId?: string };
    const scene = cmd.sceneId ? this.scenes.get(cmd.sceneId) : null;
    const node = scene && cmd.nodeId ? scene.nodes.get(cmd.nodeId) : null;
    switch (command.op) {
      case "scene.create":
        this.createScene(command.scene);
        break;
      case "scene.clear":
        if (scene) {
          scene.nodes.clear();
          scene.order = [];
        }
        break;
      case "scene.remove":
        this.scenes.delete(command.sceneId as string);
        this.hooks.removeSurface?.(command.sceneId as string);
        break;
      case "node.add":
        if (!scene) throw Error(`Canvas scene not found: ${command.sceneId}`);
        this.addNode(scene, command.node);
        break;
      case "node.set":
        if (node) Object.assign(node, command.values);
        break;
      case "node.translate":
        if (node) {
          node.x = (Number(node.x) || 0) + Number(command.dx || 0);
          node.y = (Number(node.y) || 0) + Number(command.dy || 0);
        }
        break;
      case "node.remove":
        if (scene) this.removeNode(scene, command.nodeId as string);
        break;
      case "event.set":
        if (node) node.events = { ...(node.events || {}), [command.event]: command.binding };
        break;
      case "event.remove":
        if (node?.events) delete node.events[command.event];
        break;
      case "animation.create":
        this.createTween(command);
        break;
      case "animation.keyframes":
        this.createKeyframes(command);
        break;
      case "animation.control":
        this.controlAnimation(command.id, command.action);
        break;
    }
    this.draw();
    this.schedule();
  }

  createScene(spec: Partial<CanvasSceneSpec> = {}): CanvasScene {
    if (!spec.id) throw Error("Canvas scene requires an id.");
    const scene: CanvasScene = {
      id: spec.id,
      viewport: { width: 960, height: 720, fit: "contain", ...(spec.viewport || {}) } as CanvasViewport,
      projection: createProjection((spec.viewport as CanvasViewport | undefined)?.projection),
      layers: [...(spec.layers || [])],
      background: spec.background || "transparent",
      accessibleLabel: spec.accessibleLabel || spec.id,
      nodes: new Map(),
      order: [],
      canvas: null,
      context: null,
      view: null,
      hitStack: [],
      hoverNode: null,
      pointerNode: null,
    };
    this.scenes.set(scene.id, scene);
    for (const node of spec.nodes || []) this.addNode(scene, node);
    this.hooks.ensureSurface?.(scene.id, scene.accessibleLabel);
    this.schedule();
    return scene;
  }

  addNode(scene: CanvasScene, source: CanvasNode, parentId: string | null = null): CanvasNode {
    if (!source?.id) throw Error(`Canvas node in ${scene.id} requires an id.`);
    const node = {
      visible: true,
      opacity: 1,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 1,
      interactive: true,
      ...source,
      parentId,
    } as CanvasNode;
    delete node.children;
    if (!scene.nodes.has(node.id)) scene.order.push(node.id);
    scene.nodes.set(node.id, node);
    for (const child of source.children || []) this.addNode(scene, child, node.id);
    return node;
  }

  removeNode(scene: CanvasScene, id: string): void {
    for (const child of [...scene.nodes.values()].filter((node) => node.parentId === id)) {
      this.removeNode(scene, child.id);
    }
    scene.nodes.delete(id);
    scene.order = scene.order.filter((nodeId) => nodeId !== id);
    for (const [animationId, animation] of this.animations) {
      if (animation.sceneId === scene.id && animation.nodeId === id) this.animations.delete(animationId);
    }
  }

  mountSurfaces(surfaceElements: ResolvedUiElement[]): void {
    this.host.replaceChildren();
    for (const element of surfaceElements) {
      if (element.type === "text") {
        const text = document.createElement("div");
        text.className = "ui-text";
        text.textContent = (element.values.text || "") as string;
        this.host.append(text);
        continue;
      }
      if (element.type !== "canvas") continue;
      const canvas = document.createElement("canvas");
      canvas.className = "game-canvas";
      canvas.dataset.scene = element.id;
      canvas.setAttribute("aria-label", (element.values.label || element.accessibleLabel || element.id) as string);
      this.host.append(canvas);
      const scene = this.scenes.get(element.id);
      if (scene) this.bind(canvas, scene);
    }
    this.draw();
  }

  bind(canvas: HTMLCanvasElement, scene: CanvasScene): void {
    scene.canvas = canvas;
    scene.context = canvas.getContext("2d");
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointermove", (event) => this.pointerMove(scene, event));
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(scene, event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(scene, event));
    canvas.addEventListener("pointercancel", () => {
      scene.pointerNode = null;
    });
    this.drawScene(scene);
  }

  pointerMove(scene: CanvasScene, event: PointerEvent): void {
    const point = this.canvasPoint(scene, event);
    if (!point) return;
    const hit = this.hit(scene, point);
    const next = hit?.node || null;
    if (scene.hoverNode && scene.hoverNode !== next) {
      const local = this.localPoint(scene, scene.hoverNode, point) || point;
      this.dispatch(scene, scene.hoverNode, "pointer_leave", event, point, local);
    }
    if (next && scene.hoverNode !== next) this.dispatch(scene, next, "pointer_enter", event, point, hit!.local);
    scene.hoverNode = next;
    scene.canvas!.style.cursor = next?.cursor || (next ? "pointer" : "default");
    if (scene.pointerNode) {
      const local = this.localPoint(scene, scene.pointerNode, point) || point;
      this.dispatch(scene, scene.pointerNode, "drag", event, point, local);
    }
  }

  pointerDown(scene: CanvasScene, event: PointerEvent): void {
    const point = this.canvasPoint(scene, event);
    const hit = point && this.hit(scene, point);
    if (!hit) return;
    scene.pointerNode = hit.node;
    scene.canvas!.setPointerCapture(event.pointerId);
    this.dispatch(scene, hit.node, "pointer_down", event, point, hit.local);
    this.dispatch(scene, hit.node, "drag_start", event, point, hit.local);
  }

  pointerUp(scene: CanvasScene, event: PointerEvent): void {
    if (!scene.pointerNode) return;
    const node = scene.pointerNode;
    const point = this.canvasPoint(scene, event);
    const local = point && (this.localPoint(scene, node, point) || point);
    if (point && local) {
      this.dispatch(scene, node, "pointer_up", event, point, local);
      this.dispatch(scene, node, "drag_end", event, point, local);
      if (this.hit(scene, point)?.node === node) this.dispatch(scene, node, "activate", event, point, local);
    }
    scene.pointerNode = null;
    if (scene.canvas!.hasPointerCapture(event.pointerId)) scene.canvas!.releasePointerCapture(event.pointerId);
  }

  dispatch(
    scene: CanvasScene,
    node: CanvasNode,
    type: string,
    event: PointerEvent,
    point: Point,
    local: Point,
  ): boolean {
    const binding = node?.events?.[type];
    const callback = typeof binding === "string" ? binding : binding?.callback;
    if (!callback) return false;
    this.hooks.event?.(callback, {
      sceneId: scene.id,
      nodeId: node.id,
      type,
      x: point.x,
      y: point.y,
      localX: local.x,
      localY: local.y,
      button: Number(event.button || 0),
      pointerType: event.pointerType || "mouse",
      altKey: Boolean(event.altKey),
      ctrlKey: Boolean(event.ctrlKey),
      shiftKey: Boolean(event.shiftKey),
    } as CanvasPointerEvent);
    this.draw();
    return true;
  }

  timer(command: TimerCommand): void {
    if (command.op === "create") {
      const delay = Math.max(0, Number(command.delay) || 0);
      this.timers.set(command.id, {
        id: command.id,
        delay,
        remaining: command.immediate ? 0 : delay,
        callback: command.callback,
        repeating: Boolean(command.repeating),
        repeatCount: command.repeatCount == null ? -1 : Number(command.repeatCount),
        iteration: 0,
        active: true,
        paused: false,
      });
    } else {
      const timer = this.timers.get(command.id);
      if (!timer) return;
      if (command.op === "pause") timer.paused = true;
      if (command.op === "resume") timer.paused = false;
      if (command.op === "restart") {
        Object.assign(timer, { remaining: timer.delay, iteration: 0, active: true, paused: false });
      }
      if (command.op === "cancel") this.timers.delete(timer.id);
    }
    this.schedule();
  }

  timerRemaining(id: string): number {
    return this.timers.get(id)?.remaining ?? 0;
  }

  timerActive(id: string): boolean {
    return Boolean(this.timers.get(id)?.active);
  }

  advanceTimers(dt: number): void {
    for (const timer of [...this.timers.values()]) {
      if (!timer.active || timer.paused) continue;
      timer.remaining -= dt;
      if (timer.remaining > 0) continue;
      timer.iteration += 1;
      this.hooks.timer?.(timer.callback as string, timer.id, timer.iteration);
      if (!this.timers.has(timer.id)) continue;
      const repeat = timer.repeating && (timer.repeatCount < 0 || timer.iteration <= timer.repeatCount);
      if (repeat) timer.remaining += Math.max(timer.delay, 0.001);
      else this.timers.delete(timer.id);
    }
  }

  createTween(command: CreateTweenCommand): void {
    const node = this.scenes.get(command.sceneId as string)?.nodes.get(command.nodeId as string);
    if (!node) return;
    const options = (command.options || {}) as CanvasAnimationOptions;
    const start: Record<string, unknown> = {};
    for (const key of Object.keys(command.values || {})) start[key] = node[key];
    this.animations.set(command.id, {
      id: command.id,
      kind: "tween",
      sceneId: command.sceneId as string,
      nodeId: command.nodeId as string,
      start,
      target: command.values || {},
      duration: Math.max(0.001, Number(options.duration) || 0.3),
      easing: options.easing || "linear",
      repeatCount: options.repeat_count == null ? 0 : Number(options.repeat_count),
      yoyo: Boolean(options.yoyo),
      elapsed: 0,
      iteration: 0,
      reversed: false,
      paused: false,
    } as CanvasTweenAnimation);
  }

  createKeyframes(command: CreateKeyframesCommand): void {
    const frames = [...(command.keyframes || [])].sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    if (!frames.length) return;
    const options = (command.options || {}) as CanvasAnimationOptions;
    this.animations.set(command.id, {
      id: command.id,
      kind: "keyframes",
      sceneId: command.sceneId as string,
      nodeId: command.nodeId as string,
      frames,
      duration: Math.max(0.001, Number(options.duration) || 1),
      easing: options.easing || "linear",
      repeatCount: options.repeat_count == null ? 0 : Number(options.repeat_count),
      yoyo: Boolean(options.yoyo),
      elapsed: 0,
      iteration: 0,
      reversed: false,
      paused: false,
    } as CanvasKeyframesAnimation);
  }

  controlAnimation(id: string, action: string): void {
    const animation = this.animations.get(id);
    if (!animation) return;
    if (action === "pause") animation.paused = true;
    if (action === "resume") animation.paused = false;
    if (action === "cancel") this.animations.delete(id);
    if (action === "finish") {
      this.applyAnimation(animation, animation.reversed ? 0 : 1);
      this.animations.delete(id);
    }
  }

  advanceAnimations(dt: number): void {
    for (const animation of [...this.animations.values()]) {
      if (animation.paused) continue;
      animation.elapsed += dt;
      const base = Math.min(animation.elapsed / animation.duration, 1);
      const progress = animation.reversed ? 1 - base : base;
      if (!this.applyAnimation(animation, progress)) {
        this.animations.delete(animation.id);
        continue;
      }
      if (base < 1) continue;
      const repeat = animation.repeatCount < 0 || animation.iteration < animation.repeatCount;
      if (repeat) {
        animation.iteration += 1;
        animation.elapsed = 0;
        if (animation.yoyo) animation.reversed = !animation.reversed;
      } else this.animations.delete(animation.id);
    }
  }

  applyAnimation(animation: CanvasAnimation, rawProgress: number): boolean {
    const node = this.scenes.get(animation.sceneId)?.nodes.get(animation.nodeId);
    if (!node) return false;
    const easing = EASINGS[animation.easing] ?? EASINGS.linear;
    const progress = easing(Math.min(Math.max(rawProgress, 0), 1));
    if (animation.kind === "tween") {
      for (const [key, target] of Object.entries(animation.target)) {
        node[key] = this.interpolate(animation.start[key], target, progress);
      }
      return true;
    }
    let previous = animation.frames[0];
    let next = animation.frames.at(-1) as CanvasKeyframe;
    for (let index = 1; index < animation.frames.length; index += 1) {
      if (progress <= Number(animation.frames[index].at ?? 1)) {
        previous = animation.frames[index - 1];
        next = animation.frames[index];
        break;
      }
    }
    const start = Number(previous.at || 0);
    const end = Number(next.at ?? 1);
    const local = end === start ? 1 : Math.min(Math.max((progress - start) / (end - start), 0), 1);
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    keys.delete("at");
    for (const key of keys) node[key] = this.interpolate(previous[key], next[key], local);
    return true;
  }

  interpolate(from: unknown, to: unknown, progress: number): unknown {
    return interpolateValue(from, to, progress);
  }

  draw(): void {
    for (const scene of this.scenes.values()) this.drawScene(scene);
  }

  drawScene(scene: CanvasScene): void {
    const canvas = scene.canvas;
    if (!canvas?.isConnected) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(bounds.width * ratio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = (scene.context || canvas.getContext("2d")) as CanvasRenderingContext2D;
    scene.context = context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    const virtualWidth = Number(scene.viewport.width || 960);
    const virtualHeight = Number(scene.viewport.height || 720);
    const sx = bounds.width / virtualWidth;
    const sy = bounds.height / virtualHeight;
    let scaleX = sx, scaleY = sy;
    if (scene.viewport.fit !== "stretch") {
      const scale = scene.viewport.fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
      scaleX = scaleY = scale;
    }
    const offsetX = (bounds.width - virtualWidth * scaleX) / 2;
    const offsetY = (bounds.height - virtualHeight * scaleY) / 2;
    scene.view = { offsetX, offsetY, scaleX, scaleY } as CanvasViewState;
    context.save();
    context.translate(offsetX, offsetY);
    context.scale(scaleX, scaleY);
    if (scene.background && scene.background !== "transparent") {
      context.fillStyle = scene.background;
      context.fillRect(0, 0, virtualWidth, virtualHeight);
    }
    scene.hitStack = [];
    const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    for (const node of this.children(scene, null)) this.drawNode(context, scene, node, identity, 1, false, node.layer);
    context.restore();
  }

  children(scene: CanvasScene, parentId: string | null, inheritedLayer?: string): CanvasNode[] {
    const nodes = scene.order.map((id) => scene.nodes.get(id)).filter((node) =>
      node?.parentId === parentId
    ) as CanvasNode[];
    const hasLayerPolicy = scene.layers.length > 0 || nodes.some((node) => node.layer);
    if (!hasLayerPolicy) return nodes;
    const positions = new Map(scene.order.map((id, index) => [id, index]));
    return nodes.slice().sort((left, right) => {
      const leftLayer = left.layer || inheritedLayer;
      const rightLayer = right.layer || inheritedLayer;
      const layerOrder = this.layerOrder(scene, leftLayer) - this.layerOrder(scene, rightLayer);
      if (layerOrder) return layerOrder;
      const layer = this.layer(scene, leftLayer);
      if (layer?.sort === "depth") {
        const depth = this.depth(scene, right) - this.depth(scene, left);
        if (depth) return depth;
      }
      return (positions.get(left.id) || 0) - (positions.get(right.id) || 0);
    });
  }

  layer(scene: CanvasScene, id: string | undefined): CanvasLayerSpec | undefined {
    return id ? scene.layers.find((layer) => layer.id === id) : undefined;
  }

  layerOrder(scene: CanvasScene, id: string | undefined): number {
    const layer = this.layer(scene, id);
    return layer?.order ?? (id ? scene.layers.findIndex((candidate) => candidate.id === id) : 0);
  }

  depth(scene: CanvasScene, node: CanvasNode): number {
    if (node.depth !== undefined) return Number(node.depth);
    return scene.projection.depth({ x: Number(node.x || 0), y: Number(node.y || 0), z: nodeElevation(node) });
  }

  drawNode(
    context: CanvasRenderingContext2D,
    scene: CanvasScene,
    node: CanvasNode,
    parentMatrix: Matrix,
    parentOpacity: number,
    projectedParent = false,
    inheritedLayer?: string,
  ): void {
    if (node.visible === false) return;
    const local = this.nodeMatrix(node);
    const layerId = node.layer || inheritedLayer;
    const layer = this.layer(scene, layerId);
    const space: CanvasSpace = node.space || layer?.space || (scene.projection.type === "flat" ? "screen" : "world");
    const projected = !projectedParent && space === "world";
    const renderLocal = projected ? scene.projection.transform(local, nodeElevation(node)) : local;
    const world = this.multiply(parentMatrix, renderLocal);
    const opacity = parentOpacity * Math.min(Math.max(Number(node.opacity ?? 1), 0), 1);
    context.save();
    context.transform(renderLocal.a, renderLocal.b, renderLocal.c, renderLocal.d, renderLocal.e, renderLocal.f);
    context.globalAlpha *= Math.min(Math.max(Number(node.opacity ?? 1), 0), 1);
    this.drawShape(context, node);
    const hasEvents = node.events && Object.keys(node.events).length > 0;
    if (hasEvents && node.interactive !== false && opacity > 0) scene.hitStack.push({ node, matrix: world });
    for (const child of this.children(scene, node.id, layerId)) {
      this.drawNode(context, scene, child, world, opacity, projectedParent || projected, layerId);
    }
    context.restore();
  }

  drawShape(context: CanvasRenderingContext2D, node: CanvasNode): void {
    const width = Number(node.width || 0), height = Number(node.height || 0);
    const originX = Number(node.originX || 0) * width, originY = Number(node.originY || 0) * height;
    this.paint(context, node);
    if (node.type === "rect") {
      context.beginPath();
      context.roundRect(-originX, -originY, width, height, Math.min(Number(node.radius || 0), width / 2, height / 2));
      this.fillStroke(context, node);
    } else if (node.type === "circle" || node.type === "marker") {
      context.beginPath();
      context.arc(0, 0, Number(node.radius || 0), 0, Math.PI * 2);
      this.fillStroke(context, node);
    } else if (node.type === "line" || node.type === "path") {
      const points = node.points || [];
      if (!points.length) return;
      context.beginPath();
      context.moveTo(this.px(points[0]), this.py(points[0]));
      for (const point of points.slice(1)) context.lineTo(this.px(point), this.py(point));
      if (node.closed || node.type === "path") context.closePath();
      this.fillStroke(context, node);
    } else if (node.type === "text") {
      context.font = `${node.fontWeight || 400} ${Number(node.fontSize || 24)}px ${
        node.fontFamily || "Georgia, serif"
      }`;
      context.textAlign = (node.align || "left") as CanvasTextAlign;
      context.textBaseline = (node.baseline || "top") as CanvasTextBaseline;
      if (node.fill) context.fillText(String(node.text || ""), -originX, -originY, node.maxWidth || undefined);
      if (node.stroke) context.strokeText(String(node.text || ""), -originX, -originY, node.maxWidth || undefined);
    } else if (node.type === "image" || node.type === "sprite") {
      const record = this.image(node.asset);
      if (!record?.ready) return;
      if (node.type === "sprite" && node.frame) {
        const frame = node.frame;
        context.drawImage(record.image, frame.x, frame.y, frame.width, frame.height, -originX, -originY, width, height);
      } else context.drawImage(record.image, -originX, -originY, width, height);
    }
  }

  paint(context: CanvasRenderingContext2D, node: CanvasNode): void {
    if (node.shadowColor) context.shadowColor = node.shadowColor;
    context.shadowBlur = Number(node.shadowBlur || 0);
    context.shadowOffsetX = Number(node.shadowOffsetX || 0);
    context.shadowOffsetY = Number(node.shadowOffsetY || 0);
    if (node.blend) context.globalCompositeOperation = node.blend as GlobalCompositeOperation;
    if (node.fill) context.fillStyle = node.fill;
    if (node.stroke) context.strokeStyle = node.stroke;
    context.lineWidth = Number(node.lineWidth || node.strokeWidth || 1);
    context.lineCap = (node.lineCap || "round") as CanvasLineCap;
    context.lineJoin = (node.lineJoin || "round") as CanvasLineJoin;
  }

  fillStroke(context: CanvasRenderingContext2D, node: CanvasNode): void {
    if (node.fill) context.fill();
    if (node.stroke) context.stroke();
  }

  px(point: CanvasPointInput): number {
    return pointX(point);
  }

  py(point: CanvasPointInput): number {
    return pointY(point);
  }

  image(asset: string | undefined): { image: HTMLImageElement; ready: boolean; failed: boolean } | null | undefined {
    if (!asset) return null;
    if (this.images.has(asset)) return this.images.get(asset);
    const image = new Image();
    const record = { image, ready: false, failed: false };
    this.images.set(asset, record);
    image.onload = () => {
      record.ready = true;
      this.schedule();
    };
    image.onerror = () => {
      record.failed = true;
    };
    image.src = this.hooks.asset?.(asset) || asset;
    return record;
  }

  canvasPoint(scene: CanvasScene, event: PointerEvent): Point | null {
    if (!scene.view || !scene.canvas) return null;
    const bounds = scene.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - scene.view.offsetX) / scene.view.scaleX,
      y: (event.clientY - bounds.top - scene.view.offsetY) / scene.view.scaleY,
    };
  }

  localPoint(scene: CanvasScene, node: CanvasNode, point: Point): Point | null {
    const entry = scene.hitStack.find((item) => item.node === node);
    const inverse = entry && this.invert(entry.matrix);
    return inverse ? this.transform(inverse, point.x, point.y) : null;
  }

  hit(scene: CanvasScene, point: Point): { node: CanvasNode; local: Point } | null {
    for (let index = scene.hitStack.length - 1; index >= 0; index -= 1) {
      const entry = scene.hitStack[index];
      const local = this.contains(entry, point);
      if (local) return { node: entry.node, local };
    }
    return null;
  }

  contains(entry: CanvasHitEntry, point: Point): Point | null {
    const inverse = this.invert(entry.matrix);
    if (!inverse) return null;
    const local = this.transform(inverse, point.x, point.y);
    const node = entry.node, hit = (node.hit || {}) as NonNullable<CanvasNode["hit"]>, type = hit.type || node.type;
    const width = Number(hit.width ?? node.width ?? 0), height = Number(hit.height ?? node.height ?? 0);
    const originX = Number(node.originX || 0) * Number(node.width || 0);
    const originY = Number(node.originY || 0) * Number(node.height || 0);
    const padding = Number(hit.padding || 0);
    let inside = false;
    if (type === "circle" || type === "marker") {
      inside = Math.hypot(local.x - Number(hit.x || 0), local.y - Number(hit.y || 0)) <=
        Number(hit.radius ?? node.radius ?? 0) + padding;
    } else if (type === "path" && (hit.points || node.points)) {
      inside = this.polygon((hit.points || node.points) as CanvasPointInput[], local.x, local.y);
    } else if (type === "line") {
      const points = hit.points || node.points || [],
        tolerance = Number(hit.tolerance || node.lineWidth || 1) / 2 + padding;
      inside = points.slice(1).some((end, index) =>
        this.segmentDistance(
          local,
          { x: this.px(points[index]), y: this.py(points[index]) },
          { x: this.px(end), y: this.py(end) },
        ) <= tolerance
      );
    } else {
      inside = local.x >= -originX - padding && local.x <= width - originX + padding &&
        local.y >= -originY - padding && local.y <= height - originY + padding;
    }
    return inside ? local : null;
  }

  polygon(points: CanvasPointInput[], x: number, y: number): boolean {
    return polygonContains(points, x, y);
  }

  segmentDistance(point: Point, start: Point, end: Point): number {
    return segmentDistanceOf(point, start, end);
  }

  nodeMatrix(node: CanvasNode): Matrix {
    return nodeMatrixOf(node);
  }

  multiply(left: Matrix, right: Matrix): Matrix {
    return multiplyMatrices(left, right);
  }

  invert(matrix: Matrix): Matrix | null {
    return invertMatrix(matrix);
  }

  transform(matrix: Matrix, x: number, y: number): Point {
    return transformPoint(matrix, x, y);
  }
}

export default InkforgeCanvasRuntime;
