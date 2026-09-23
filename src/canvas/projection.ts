import type {
  CanvasNode,
  CanvasProjection,
  CanvasProjectionSpec,
  CanvasWorldPoint,
  Matrix,
  Point,
} from "../types/canvas.ts";

interface ProjectionConfig {
  originX: number;
  originY: number;
  tileWidth: number;
  tileHeight: number;
  elevation: number;
  skew: number;
}

const DEFAULT_CONFIG: ProjectionConfig = {
  originX: 0,
  originY: 0,
  tileWidth: 64,
  tileHeight: 32,
  elevation: 32,
  skew: 0.5,
};

function configOf(spec: CanvasProjectionSpec = {}): ProjectionConfig {
  return {
    originX: Number(spec.origin?.x ?? spec.originX ?? DEFAULT_CONFIG.originX),
    originY: Number(spec.origin?.y ?? spec.originY ?? DEFAULT_CONFIG.originY),
    tileWidth: Math.max(0.001, Number(spec.tileWidth ?? DEFAULT_CONFIG.tileWidth)),
    tileHeight: Math.max(0.001, Number(spec.tileHeight ?? DEFAULT_CONFIG.tileHeight)),
    elevation: Number(spec.elevation ?? DEFAULT_CONFIG.elevation),
    skew: Number(spec.skew ?? DEFAULT_CONFIG.skew),
  };
}

class FlatProjection implements CanvasProjection {
  readonly type = "flat" as const;
  readonly config: ProjectionConfig;

  constructor(spec: CanvasProjectionSpec) {
    this.config = configOf(spec);
  }

  project(point: CanvasWorldPoint): Point {
    return {
      x: this.config.originX + point.x,
      y: this.config.originY + point.y,
    };
  }

  unproject(point: Point, elevation = 0): CanvasWorldPoint {
    return {
      x: point.x - this.config.originX,
      y: point.y - this.config.originY,
      z: elevation,
    };
  }

  depth(point: CanvasWorldPoint): number {
    return point.y + point.z * 0.001;
  }

  transform(matrix: Matrix, elevation: number): Matrix {
    const anchor = this.project({ x: matrix.e, y: matrix.f, z: elevation });
    return { ...matrix, e: anchor.x, f: anchor.y };
  }
}

class IsometricProjection implements CanvasProjection {
  readonly type = "isometric" as const;
  readonly config: ProjectionConfig;

  constructor(spec: CanvasProjectionSpec) {
    this.config = configOf(spec);
  }

  project(point: CanvasWorldPoint): Point {
    const halfWidth = this.config.tileWidth / 2;
    const halfHeight = this.config.tileHeight / 2;
    return {
      x: this.config.originX + (point.x - point.y) * halfWidth,
      y: this.config.originY + (point.x + point.y) * halfHeight - point.z * this.config.elevation,
    };
  }

  unproject(point: Point, elevation = 0): CanvasWorldPoint {
    const halfWidth = this.config.tileWidth / 2;
    const halfHeight = this.config.tileHeight / 2;
    const diagonalX = (point.x - this.config.originX) / halfWidth;
    const diagonalY = (point.y - this.config.originY + elevation * this.config.elevation) / halfHeight;
    return {
      x: (diagonalX + diagonalY) / 2,
      y: (diagonalY - diagonalX) / 2,
      z: elevation,
    };
  }

  depth(point: CanvasWorldPoint): number {
    return point.x + point.y + point.z * 0.001;
  }

  transform(matrix: Matrix, elevation: number): Matrix {
    const anchor = this.project({ x: matrix.e, y: matrix.f, z: elevation });
    const halfWidth = this.config.tileWidth / 2;
    const halfHeight = this.config.tileHeight / 2;
    return {
      a: halfWidth * matrix.a - halfWidth * matrix.b,
      b: halfHeight * matrix.a + halfHeight * matrix.b,
      c: halfWidth * matrix.c - halfWidth * matrix.d,
      d: halfHeight * matrix.c + halfHeight * matrix.d,
      e: anchor.x,
      f: anchor.y,
    };
  }
}

class ObliqueProjection implements CanvasProjection {
  readonly type = "oblique" as const;
  readonly config: ProjectionConfig;

  constructor(spec: CanvasProjectionSpec) {
    this.config = configOf(spec);
  }

  project(point: CanvasWorldPoint): Point {
    return {
      x: this.config.originX + point.x + point.y * this.config.skew,
      y: this.config.originY + point.y - point.z * this.config.elevation,
    };
  }

  unproject(point: Point, elevation = 0): CanvasWorldPoint {
    const y = point.y - this.config.originY + elevation * this.config.elevation;
    return {
      x: point.x - this.config.originX - y * this.config.skew,
      y,
      z: elevation,
    };
  }

  depth(point: CanvasWorldPoint): number {
    return point.y + point.z * 0.001;
  }

  transform(matrix: Matrix, elevation: number): Matrix {
    const anchor = this.project({ x: matrix.e, y: matrix.f, z: elevation });
    return {
      a: matrix.a,
      b: matrix.b,
      c: this.config.skew * matrix.d + matrix.c,
      d: matrix.d,
      e: anchor.x,
      f: anchor.y,
    };
  }
}

export function createProjection(spec: CanvasProjectionSpec = {}): CanvasProjection {
  switch (spec.type || "flat") {
    case "flat":
      return new FlatProjection(spec);
    case "isometric":
      return new IsometricProjection(spec);
    case "oblique":
      return new ObliqueProjection(spec);
    default:
      throw new Error(`Unknown canvas projection: ${String(spec.type)}`);
  }
}

export function nodeElevation(node: CanvasNode): number {
  return Number(node.z ?? node.elevation ?? 0);
}
