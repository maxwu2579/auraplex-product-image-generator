import { describe, expect, it } from "vitest";
import { applyErase, EraseMask, eraseChangesPixels, isFullyTransparent, MAX_UNDO_STROKES, planCleanupApply, rasterizeStroke, stampSegment } from "./cleanupMask";
import type { Point, Stroke } from "./cleanupMask";
import { decodePng, encodePng } from "./pngCodec";

// 6×2 fixture with known straight-alpha values: opaque, semi-transparent edge values and already-transparent pixels.
const FIXTURE = new Uint8Array([
  200, 10, 20, 255, 30, 40, 50, 128, 60, 70, 80, 1, 90, 100, 110, 0, 5, 6, 7, 254, 11, 12, 13, 77,
  120, 130, 140, 255, 150, 160, 170, 2, 180, 190, 200, 0, 210, 220, 230, 127, 1, 2, 3, 255, 250, 251, 252, 64,
]);

function maskOf(width: number, height: number, pixels: [number, number][]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const [x, y] of pixels) mask[y * width + x] = 1;
  return mask;
}

/** Brute-force reference: a pixel is erased when its centre lies within `radius` of the segment. */
function referenceSegment(width: number, height: number, from: Point, to: Point, radius: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((px - from.x) * dx + (py - from.y) * dy) / lengthSquared)) : 0;
      if ((from.x + t * dx - px) ** 2 + (from.y + t * dy - py) ** 2 <= radius * radius) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function stroke(mask: EraseMask, radius: number, points: Point[]): void {
  mask.begin(points[0], radius);
  points.slice(1).forEach((point) => mask.extend(point));
  mask.end();
}

function strokesMask(width: number, height: number, strokes: Stroke[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  strokes.forEach((item) => rasterizeStroke(mask, width, height, item));
  return mask;
}

const erased = (mask: Uint8Array) => Array.from(mask).reduce((total, value) => total + value, 0);

describe("erase pixels", () => {
  it("sets alpha to 0 inside the mask and copies every other sample, including RGB under the mask", () => {
    const mask = maskOf(6, 2, [[0, 0], [1, 0], [3, 1]]);
    const output = applyErase(FIXTURE, mask);
    for (let pixel = 0; pixel < 12; pixel++) {
      const offset = pixel * 4;
      expect(Array.from(output.subarray(offset, offset + 3))).toEqual(Array.from(FIXTURE.subarray(offset, offset + 3)));
      expect(output[offset + 3]).toBe(mask[pixel] ? 0 : FIXTURE[offset + 3]);
    }
    expect(FIXTURE[3]).toBe(255);
  });

  it("keeps semi-transparent edges exact through the real erase → PNG encode → decode chain", async () => {
    const width = 37;
    const height = 23;
    const source = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = x < 3 ? 0 : Math.min(255, (x - 3) * 19 + y * 3);
        source.set([(x * 7 + y * 3) % 256, (x * x + y * 11) % 256, (255 - x * 5 - y * 2) % 256, alpha], (y * width + x) * 4);
      }
    }
    const mask = new Uint8Array(width * height);
    stampSegment(mask, width, height, { x: 10, y: 4 }, { x: 30, y: 18 }, 3.5);
    const png = await encodePng({ width, height, data: applyErase(source, mask) });
    const decoded = await decodePng(png);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    let semiTransparentKept = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      expect(Array.from(decoded.data.subarray(offset, offset + 3))).toEqual(Array.from(source.subarray(offset, offset + 3)));
      expect(decoded.data[offset + 3]).toBe(mask[pixel] ? 0 : source[offset + 3]);
      if (!mask[pixel] && source[offset + 3] > 0 && source[offset + 3] < 255) semiTransparentKept++;
    }
    expect(erased(mask)).toBeGreaterThan(50);
    expect(semiTransparentKept).toBeGreaterThan(100);
  });

  it("treats an empty mask or a mask over already-transparent pixels as no change", () => {
    expect(eraseChangesPixels(FIXTURE, new Uint8Array(12))).toBe(false);
    expect(eraseChangesPixels(FIXTURE, maskOf(6, 2, [[3, 0], [2, 1]]))).toBe(false);
    expect(planCleanupApply({ entry: FIXTURE, base: FIXTURE, baseIsProcessed: true, mask: maskOf(6, 2, [[3, 0], [2, 1]]) })).toEqual({ kind: "unchanged" });
    expect(applyErase(FIXTURE, new Uint8Array(12))).toEqual(FIXTURE);
  });

  it("repeated erasing of the same area has no further effect", () => {
    const mask = maskOf(6, 2, [[0, 0], [4, 1]]);
    const once = applyErase(FIXTURE, mask);
    expect(applyErase(once, mask)).toEqual(once);
    expect(planCleanupApply({ entry: once, base: once, baseIsProcessed: false, mask })).toEqual({ kind: "unchanged" });
  });

  it("detects a completely erased result", () => {
    const all = new Uint8Array(12).fill(1);
    const plan = planCleanupApply({ entry: FIXTURE, base: FIXTURE, baseIsProcessed: true, mask: all });
    expect(plan.kind).toBe("encode");
    expect(plan.kind === "encode" && plan.fullyTransparent).toBe(true);
    expect(isFullyTransparent(applyErase(FIXTURE, all))).toBe(true);
    expect(isFullyTransparent(FIXTURE)).toBe(false);
  });
});

describe("hard round brush", () => {
  it("matches the pixel-centre distance rule for random segments, radii and clipping", () => {
    let seed = 99;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let run = 0; run < 300; run++) {
      const width = 5 + Math.floor(random() * 40);
      const height = 5 + Math.floor(random() * 40);
      const from = { x: random() * (width + 20) - 10, y: random() * (height + 20) - 10 };
      const to = run % 5 ? { x: random() * (width + 20) - 10, y: random() * (height + 20) - 10 } : from;
      const radius = 0.3 + random() * 9;
      const mask = new Uint8Array(width * height);
      stampSegment(mask, width, height, from, to, radius);
      expect(mask).toEqual(referenceSegment(width, height, from, to, radius));
    }
  });

  it("covers exact boundary pixels of a disc consistently", () => {
    const mask = new Uint8Array(11 * 11);
    stampSegment(mask, 11, 11, { x: 5.5, y: 5.5 }, { x: 5.5, y: 5.5 }, 2);
    expect(mask).toEqual(referenceSegment(11, 11, { x: 5.5, y: 5.5 }, { x: 5.5, y: 5.5 }, 2));
    expect(erased(mask)).toBe(13);
  });

  it("keeps a fast single-event movement continuous", () => {
    const mask = new EraseMask(100, 40);
    mask.begin({ x: 2.5, y: 10.5 }, 1.5);
    mask.extend({ x: 97.5, y: 10.5 });
    mask.extend({ x: 3.5, y: 37.5 });
    mask.end();
    for (let x = 1; x <= 98; x++) expect(mask.data[10 * 100 + x]).toBe(1);
    // Every row crossed by the fast diagonal move has erased pixels, with no gap between rows.
    for (let y = 11; y <= 37; y++) expect(mask.data.subarray(y * 100, y * 100 + 100).some(Boolean)).toBe(true);
  });

  it("unions overlapping strokes", () => {
    const first: Stroke = { radius: 4, points: [{ x: 5, y: 5 }, { x: 25, y: 12 }] };
    const second: Stroke = { radius: 2.5, points: [{ x: 20, y: 3 }, { x: 8, y: 18 }] };
    const mask = new EraseMask(30, 20);
    stroke(mask, first.radius, first.points);
    stroke(mask, second.radius, second.points);
    const a = strokesMask(30, 20, [first]);
    const b = strokesMask(30, 20, [second]);
    expect(Array.from(mask.data)).toEqual(Array.from(a, (value, index) => value | b[index]));
    expect(Array.from(a, (value, index) => value & b[index]).some(Boolean)).toBe(true);
  });

  it("clips strokes to the image and ignores strokes entirely outside", () => {
    const mask = new Uint8Array(10 * 8);
    const dirty = stampSegment(mask, 10, 8, { x: -50, y: -50 }, { x: 3, y: 3 }, 2);
    expect(dirty).not.toBeNull();
    expect(dirty!.x).toBeGreaterThanOrEqual(0);
    expect(dirty!.y).toBeGreaterThanOrEqual(0);
    expect(mask).toEqual(referenceSegment(10, 8, { x: -50, y: -50 }, { x: 3, y: 3 }, 2));
    const untouched = new Uint8Array(10 * 8);
    expect(stampSegment(untouched, 10, 8, { x: -20, y: 2 }, { x: -5, y: 6 }, 3)).toBeNull();
    expect(stampSegment(untouched, 10, 8, { x: 3, y: 30 }, { x: 8, y: 40 }, 3)).toBeNull();
    expect(erased(untouched)).toBe(0);
  });

  it("keeps each stroke's radius fixed in source pixels", () => {
    const mask = new EraseMask(40, 10);
    stroke(mask, 1, [{ x: 5.5, y: 5.5 }]);
    stroke(mask, 3, [{ x: 25.5, y: 5.5 }]);
    expect(Array.from(mask.data)).toEqual(Array.from(strokesMask(40, 10, [
      { radius: 1, points: [{ x: 5.5, y: 5.5 }] }, { radius: 3, points: [{ x: 25.5, y: 5.5 }] },
    ])));
  });
});

describe("stroke undo", () => {
  const strokeAt = (index: number): Stroke => ({ radius: 1.5, points: [{ x: 3 + (index % 10) * 6, y: 3 + Math.floor(index / 10) * 6 }, { x: 5 + (index % 10) * 6, y: 4 + Math.floor(index / 10) * 6 }] });

  it("undoes exactly one complete stroke", () => {
    const mask = new EraseMask(30, 20);
    stroke(mask, 3, [{ x: 4, y: 4 }, { x: 12, y: 9 }]);
    const afterFirst = mask.data.slice();
    stroke(mask, 2, [{ x: 10, y: 5 }, { x: 25, y: 15 }, { x: 5, y: 18 }]);
    expect(mask.undoDepth).toBe(2);
    expect(mask.undo()).toBe(true);
    expect(mask.data).toEqual(afterFirst);
    expect(mask.undoDepth).toBe(1);
  });

  it("allows exactly 20 undo steps", () => {
    const mask = new EraseMask(64, 30);
    for (let index = 0; index < MAX_UNDO_STROKES; index++) stroke(mask, 1.5, strokeAt(index).points);
    expect(mask.undoDepth).toBe(20);
    for (let index = 0; index < 20; index++) expect(mask.undo()).toBe(true);
    expect(mask.undo()).toBe(false);
    expect(erased(mask.data)).toBe(0);
    expect(mask.hasStrokes).toBe(false);
  });

  it("merges strokes beyond 20 into a checkpoint that later undos keep", () => {
    const mask = new EraseMask(64, 30);
    const strokes = Array.from({ length: 25 }, (_, index) => strokeAt(index));
    strokes.forEach((item) => stroke(mask, item.radius, item.points));
    expect(mask.undoDepth).toBe(20);
    expect(mask.data).toEqual(strokesMask(64, 30, strokes));
    for (let index = 0; index < 20; index++) expect(mask.undo()).toBe(true);
    expect(mask.undo()).toBe(false);
    expect(mask.data).toEqual(strokesMask(64, 30, strokes.slice(0, 5)));
    expect(mask.hasStrokes).toBe(true);
  });

  it("does not undo while a stroke is still being drawn, and clears everything on reset", () => {
    const mask = new EraseMask(20, 20);
    stroke(mask, 2, [{ x: 5, y: 5 }]);
    mask.begin({ x: 12, y: 12 }, 2);
    expect(mask.undo()).toBe(false);
    mask.end();
    mask.clear();
    expect(erased(mask.data)).toBe(0);
    expect(mask.undoDepth).toBe(0);
    expect(mask.hasStrokes).toBe(false);
  });

  it("rejects invalid or oversized masks", () => {
    expect(() => new EraseMask(0, 10)).toThrow(RangeError);
    expect(() => new EraseMask(5001, 5000)).toThrow(RangeError);
  });
});

describe("Apply planning", () => {
  const processed = FIXTURE;
  const cleaned = applyErase(FIXTURE, maskOf(6, 2, [[0, 0], [5, 1]]));

  it("commits the processed base by reference after Reset when nothing else is erased", () => {
    expect(planCleanupApply({ entry: cleaned, base: processed, baseIsProcessed: true, mask: new Uint8Array(12) })).toEqual({ kind: "base" });
  });

  it("is unchanged after Reset when the entry already was the processed base", () => {
    expect(planCleanupApply({ entry: processed, base: processed.slice(), baseIsProcessed: true, mask: new Uint8Array(12) })).toEqual({ kind: "unchanged" });
  });

  it("is unchanged after Reset when the same pixels are erased again", () => {
    expect(planCleanupApply({ entry: cleaned, base: processed, baseIsProcessed: true, mask: maskOf(6, 2, [[0, 0], [5, 1]]) })).toEqual({ kind: "unchanged" });
  });

  it("encodes a real change from the current applied image", () => {
    const plan = planCleanupApply({ entry: cleaned, base: cleaned, baseIsProcessed: false, mask: maskOf(6, 2, [[1, 0]]) });
    expect(plan.kind).toBe("encode");
    if (plan.kind === "encode") {
      expect(plan.fullyTransparent).toBe(false);
      expect(plan.output[7]).toBe(0);
      expect(plan.output[3]).toBe(0);
    }
  });
});
