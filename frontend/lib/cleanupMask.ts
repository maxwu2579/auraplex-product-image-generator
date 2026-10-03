/** Binary erase mask in product-image pixel coordinates, with bounded stroke undo. */

export const MAX_UNDO_STROKES = 20;
/**
 * Largest product image Cleanup accepts: the backend's MAX_PIXELS source limit
 * (backend/app/image_processing/service.py). Processed images are crops of sources
 * within it, so this never rejects a valid processed image.
 */
export const MAX_CLEANUP_PIXELS = 25_000_000;

export interface Point {
  x: number;
  y: number;
}

/** Integer pixel rectangle. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Stroke {
  /** Brush radius in source pixels, fixed for the whole stroke. */
  radius: number;
  points: Point[];
}

type Span = [number, number];

/** Solves { x : c <= k·x <= c + span } for span >= 0. */
function linearSpan(k: number, c: number, span: number): Span {
  if (k === 0) return c <= 0 && 0 <= c + span ? [-Infinity, Infinity] : [Infinity, -Infinity];
  const a = c / k;
  const b = (c + span) / k;
  return k > 0 ? [a, b] : [b, a];
}

/**
 * Horizontal extent, at height py, of the capsule of points within `radius` of
 * segment from→to: the union of both end discs and the segment body. The capsule
 * is convex, so the union is one interval.
 */
function capsuleRowSpan(from: Point, to: Point, radius: number, py: number): Span {
  let left = Infinity;
  let right = -Infinity;
  for (const end of [from, to]) {
    const reach = radius * radius - (py - end.y) ** 2;
    if (reach >= 0) {
      const half = Math.sqrt(reach);
      left = Math.min(left, end.x - half);
      right = Math.max(right, end.x + half);
    }
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared > 0) {
    const length = Math.sqrt(lengthSquared);
    const offset = py - from.y;
    // Projection onto the segment within [0, |d|²] and perpendicular distance within radius.
    const along = linearSpan(dx, from.x * dx - offset * dy, lengthSquared);
    const across = linearSpan(dy, from.x * dy + offset * dx - radius * length, 2 * radius * length);
    const low = Math.max(along[0], across[0]);
    const high = Math.min(along[1], across[1]);
    if (low <= high) {
      left = Math.min(left, low);
      right = Math.max(right, high);
    }
  }
  return [left, right];
}

/**
 * Marks every pixel whose centre lies within `radius` of the segment (a hard round
 * brush swept along the segment). Pixels outside the image are clipped. Returns
 * the touched rectangle, or null when nothing inside the image was covered.
 */
export function stampSegment(mask: Uint8Array, width: number, height: number, from: Point, to: Point, radius: number): PixelRect | null {
  if (!(radius > 0) || ![from.x, from.y, to.x, to.y].every(Number.isFinite)) return null;
  const top = Math.max(0, Math.ceil(Math.min(from.y, to.y) - radius - 0.5));
  const bottom = Math.min(height - 1, Math.floor(Math.max(from.y, to.y) + radius - 0.5));
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = top; y <= bottom; y++) {
    const [left, right] = capsuleRowSpan(from, to, radius, y + 0.5);
    const x0 = Math.max(0, Math.ceil(left - 0.5));
    const x1 = Math.min(width - 1, Math.floor(right - 0.5));
    if (x0 > x1) continue;
    mask.fill(1, y * width + x0, y * width + x1 + 1);
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y);
    maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Rasterizes a stroke exactly as it was drawn: a disc at the first point, then connected segments. */
export function rasterizeStroke(mask: Uint8Array, width: number, height: number, stroke: Stroke): PixelRect | null {
  let dirty: PixelRect | null = null;
  for (let index = 0; index < stroke.points.length; index++) {
    dirty = unionRect(dirty, stampSegment(mask, width, height, stroke.points[Math.max(0, index - 1)], stroke.points[index], stroke.radius));
  }
  return dirty;
}

/**
 * Erase selection for one Cleanup session. Each complete stroke is one undo unit;
 * only the latest MAX_UNDO_STROKES strokes stay undoable, older ones are merged
 * into a checkpoint mask. Stroke geometry is stored, never RGBA snapshots.
 */
export class EraseMask {
  readonly width: number;
  readonly height: number;
  /** 1 = erase, 0 = keep; one byte per source pixel. */
  readonly data: Uint8Array;
  private checkpoint: Uint8Array | null = null;
  private strokes: Stroke[] = [];
  private active: Stroke | null = null;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_CLEANUP_PIXELS) {
      throw new RangeError("Invalid mask size");
    }
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  get undoDepth(): number {
    return this.strokes.length;
  }

  get drawing(): boolean {
    return this.active !== null;
  }

  /** Whether any stroke (undoable or merged into the checkpoint) is part of the selection. */
  get hasStrokes(): boolean {
    return this.strokes.length > 0 || this.checkpoint !== null || this.active !== null;
  }

  begin(point: Point, radius: number): PixelRect | null {
    if (this.active) this.end();
    this.active = { radius, points: [{ x: point.x, y: point.y }] };
    return stampSegment(this.data, this.width, this.height, point, point, radius);
  }

  extend(point: Point): PixelRect | null {
    const stroke = this.active;
    if (!stroke) return null;
    const last = stroke.points[stroke.points.length - 1];
    if (last.x === point.x && last.y === point.y) return null;
    stroke.points.push({ x: point.x, y: point.y });
    return stampSegment(this.data, this.width, this.height, last, point, stroke.radius);
  }

  /** Completes the active stroke as one undo unit. Returns false when no stroke was active. */
  end(): boolean {
    if (!this.active) return false;
    this.strokes.push(this.active);
    this.active = null;
    while (this.strokes.length > MAX_UNDO_STROKES) {
      this.checkpoint ??= new Uint8Array(this.data.length);
      rasterizeStroke(this.checkpoint, this.width, this.height, this.strokes.shift()!);
    }
    return true;
  }

  /** Removes the latest complete stroke and rebuilds the mask from the checkpoint. */
  undo(): boolean {
    if (this.active || !this.strokes.length) return false;
    this.strokes.pop();
    if (this.checkpoint) this.data.set(this.checkpoint);
    else this.data.fill(0);
    for (const stroke of this.strokes) rasterizeStroke(this.data, this.width, this.height, stroke);
    return true;
  }

  clear(): void {
    this.data.fill(0);
    this.checkpoint = null;
    this.strokes = [];
    this.active = null;
  }
}

/** Mask pixels become fully transparent; every other sample, including RGB under the mask, is copied unchanged. */
export function applyErase(base: Uint8Array, mask: Uint8Array): Uint8Array<ArrayBuffer> {
  if (base.length !== mask.length * 4) throw new RangeError("Mask does not match image size");
  const output = new Uint8Array(base);
  for (let index = 0; index < mask.length; index++) if (mask[index]) output[index * 4 + 3] = 0;
  return output;
}

/** Whether erasing would change anything, i.e. the mask covers a pixel that is not already transparent. */
export function eraseChangesPixels(base: Uint8Array, mask: Uint8Array): boolean {
  for (let index = 0; index < mask.length; index++) if (mask[index] && base[index * 4 + 3] !== 0) return true;
  return false;
}

export function isFullyTransparent(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index] !== 0) return false;
  return true;
}

export function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

export type CleanupApplyPlan =
  | { kind: "unchanged" }
  | { kind: "base" }
  | { kind: "encode"; output: Uint8Array<ArrayBuffer>; fullyTransparent: boolean };

/**
 * Decides what Apply commits.
 * - unchanged: the result equals the content applied when the session opened (no new version).
 * - base: after Reset, the result is exactly the processed base, which is committed by reference.
 * - encode: a new PNG must be generated from `output`.
 */
export function planCleanupApply({ entry, base, baseIsProcessed, mask }: {
  entry: Uint8Array;
  base: Uint8Array;
  baseIsProcessed: boolean;
  mask: Uint8Array;
}): CleanupApplyPlan {
  const changesBase = eraseChangesPixels(base, mask);
  if (!changesBase && (base === entry || samePixels(base, entry))) return { kind: "unchanged" };
  if (!changesBase && baseIsProcessed) return { kind: "base" };
  const output = applyErase(base, mask);
  if (samePixels(output, entry)) return { kind: "unchanged" };
  return { kind: "encode", output, fullyTransparent: isFullyTransparent(output) };
}
