import type { CanvasNode, CanvasPointInput, Matrix, Point } from "../types/canvas.ts";

export function multiply(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function invert(matrix: Matrix): Matrix | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!determinant) return null;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function transform(matrix: Matrix, x: number, y: number): Point {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

export function nodeMatrix(node: CanvasNode): Matrix {
  const radians = Number(node.rotation || 0) * Math.PI / 180;
  const sx = Number(node.scaleX ?? node.scale ?? 1), sy = Number(node.scaleY ?? node.scale ?? 1);
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return {
    a: cosine * sx,
    b: sine * sx,
    c: -sine * sy,
    d: cosine * sy,
    e: Number(node.x || 0),
    f: Number(node.y || 0),
  };
}

export function pointX(point: CanvasPointInput): number {
  const record = point as { x?: unknown; 0?: unknown };
  return Number(record.x ?? record[0] ?? 0);
}

export function pointY(point: CanvasPointInput): number {
  const record = point as { y?: unknown; 1?: unknown };
  return Number(record.y ?? record[1] ?? 0);
}

export function polygonContains(points: CanvasPointInput[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = pointX(points[i]), yi = pointY(points[i]), xj = pointX(points[j]), yj = pointY(points[j]);
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y, length = dx * dx + dy * dy;
  const amount = length ? Math.min(Math.max(((point.x - start.x) * dx + (point.y - start.y) * dy) / length, 0), 1) : 0;
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

export function interpolate(from: unknown, to: unknown, progress: number): unknown {
  if (typeof from === "number" && typeof to === "number") return from + (to - from) * progress;
  return progress >= 1 ? to : from;
}
