import { createProjection } from "../src/canvas/projection.ts";
import { InkforgeCanvasRuntime } from "../src/canvas/runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 0.000001, `${message}: ${actual} !== ${expected}`);
}

function pointClose(actual: { x: number; y: number }, expected: { x: number; y: number }, message: string): void {
  close(actual.x, expected.x, `${message}.x`);
  close(actual.y, expected.y, `${message}.y`);
}

const flat = createProjection({ type: "flat", originX: 10, originY: 20 });
pointClose(flat.project({ x: 4, y: 7, z: 3 }), { x: 14, y: 27 }, "flat projection");
pointClose(flat.unproject({ x: 14, y: 27 }, 3), { x: 4, y: 7 }, "flat inverse");

const isometric = createProjection({
  type: "isometric",
  originX: 100,
  originY: 40,
  tileWidth: 64,
  tileHeight: 32,
  elevation: 20,
});
pointClose(isometric.project({ x: 1, y: 0, z: 0 }), { x: 132, y: 56 }, "isometric east point");
pointClose(isometric.project({ x: 0, y: 1, z: 0 }), { x: 68, y: 56 }, "isometric south point");
pointClose(isometric.project({ x: 1, y: 1, z: 2 }), { x: 100, y: 32 }, "isometric elevated point");
const isometricIdentity = isometric.transform({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0);
pointClose({ x: isometricIdentity.a, y: isometricIdentity.b }, { x: 32, y: 16 }, "isometric x basis");
pointClose({ x: isometricIdentity.c, y: isometricIdentity.d }, { x: -32, y: 16 }, "isometric y basis");
const isometricRoundTrip = isometric.unproject(isometric.project({ x: 3.5, y: -2, z: 2 }), 2);
close(isometricRoundTrip.x, 3.5, "isometric round trip x");
close(isometricRoundTrip.y, -2, "isometric round trip y");

const oblique = createProjection({ type: "oblique", originX: 5, originY: 9, skew: 0.5, elevation: 12 });
const obliqueIdentity = oblique.transform({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0);
pointClose({ x: obliqueIdentity.a, y: obliqueIdentity.b }, { x: 1, y: 0 }, "oblique x basis");
pointClose({ x: obliqueIdentity.c, y: obliqueIdentity.d }, { x: 0.5, y: 1 }, "oblique y basis");
const obliqueRoundTrip = oblique.unproject(oblique.project({ x: 8, y: 6, z: 3 }), 3);
close(obliqueRoundTrip.x, 8, "oblique round trip x");
close(obliqueRoundTrip.y, 6, "oblique round trip y");

globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
const runtime = new InkforgeCanvasRuntime({ replaceChildren() {} } as HTMLElement);
const scene = runtime.createScene({
  id: "layers",
  viewport: { projection: { type: "isometric" } },
  layers: [
    { id: "background", order: 0 },
    { id: "foreground", order: 10 },
  ],
  nodes: [
    { id: "front", type: "rect", layer: "foreground" },
    { id: "back", type: "rect", layer: "background" },
  ],
});
assert(runtime.children(scene, null).map((node) => node.id).join(",") === "back,front", "layer order is not stable");

const projectedNode = {
  id: "projected",
  type: "rect",
  x: 1,
  y: 0,
  width: 10,
  height: 10,
  events: { activate: "activate_projected" },
};
runtime.addNode(scene, projectedNode);
const projectedMatrix = scene.projection.transform(runtime.nodeMatrix(projectedNode), 0);
scene.hitStack = [{ node: scene.nodes.get("projected") as typeof projectedNode, matrix: projectedMatrix }];
const projectedPoint = runtime.transform(projectedMatrix, 5, 5);
const projectedHit = runtime.hit(scene, projectedPoint);
assert(projectedHit?.node.id === "projected", "projected hit-test missed the node");
close(projectedHit.local.x, 5, "projected local hit x");
close(projectedHit.local.y, 5, "projected local hit y");

let pointerPayload: Record<string, unknown> | undefined;
const pointerRuntime = new InkforgeCanvasRuntime({ replaceChildren() {} } as HTMLElement, {
  canvasEvent: (event) => pointerPayload = event as unknown as Record<string, unknown>,
});
const pointerScene = pointerRuntime.createScene({
  id: "pointer",
  viewport: { projection: { type: "isometric", originX: 100, originY: 40, tileWidth: 64, tileHeight: 32 } },
});
const pointerNode = pointerRuntime.addNode(pointerScene, {
  id: "pointer-node",
  type: "rect",
  events: { activate: "pointer_callback" },
});
const worldPoint = pointerScene.projection.project({ x: 3, y: 2, z: 0 });
assert(
  pointerRuntime.dispatch(
    pointerScene,
    pointerNode,
    "activate",
    { button: 0, pointerType: "mouse", altKey: false, ctrlKey: false, shiftKey: false } as PointerEvent,
    worldPoint,
    { x: 0, y: 0 },
  ),
  "projected pointer dispatch did not invoke the hook",
);
close(Number(pointerPayload?.worldX), 3, "projected pointer world x");
close(Number(pointerPayload?.worldY), 2, "projected pointer world y");
close(Number(pointerPayload?.worldZ), 0, "projected pointer world z");

console.log("Renderer projection/layer checks passed.");
