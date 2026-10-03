import { describe, expect, it } from "vitest";
import { EraseMask } from "./cleanupMask";
import {
  backingStoreSize, brushDiameterFromSlider, brushSliderFromDiameter, BRUSH_SLIDER_MAX, clientToImage, defaultBrushDiameter,
  fitImageToView, imageLengthToClient, imageRectToBacking, maxBrushDiameter, samplingMap, updatePreviewAlpha,
} from "./cleanupView";

describe("Cleanup coordinates", () => {
  it("fits non-square images into the view without distortion", () => {
    expect(fitImageToView({ width: 1600, height: 400 }, { width: 800, height: 600 })).toEqual({ width: 800, height: 200 });
    expect(fitImageToView({ width: 300, height: 900 }, { width: 800, height: 600 })).toEqual({ width: 200, height: 600 });
    // Small images are enlarged to fill the view.
    expect(fitImageToView({ width: 50, height: 20 }, { width: 700, height: 700 })).toEqual({ width: 700, height: 280 });
  });

  it("inverts the display transform for different scales, offsets and non-square images", () => {
    const cases = [
      { image: { width: 1600, height: 400 }, rect: { left: 120, top: 310, width: 800, height: 200 } },
      { image: { width: 300, height: 900 }, rect: { left: 437.5, top: 88.25, width: 200, height: 600 } },
      { image: { width: 50, height: 20 }, rect: { left: 16, top: 16, width: 700, height: 280 } },
    ];
    for (const { image, rect } of cases) {
      expect(clientToImage(rect.left, rect.top, rect, image)).toEqual({ x: 0, y: 0 });
      const end = clientToImage(rect.left + rect.width, rect.top + rect.height, rect, image);
      expect(end.x).toBeCloseTo(image.width);
      expect(end.y).toBeCloseTo(image.height);
      const point = clientToImage(rect.left + rect.width * 0.25, rect.top + rect.height * 0.75, rect, image);
      expect(point.x).toBeCloseTo(image.width * 0.25);
      expect(point.y).toBeCloseTo(image.height * 0.75);
    }
  });

  it("maps pointer positions outside the image to out-of-range coordinates that strokes clip", () => {
    const point = clientToImage(10, 5, { left: 20, top: 20, width: 100, height: 50 }, { width: 200, height: 100 });
    expect(point).toEqual({ x: -20, y: -30 });
    const mask = new EraseMask(200, 100);
    expect(mask.begin(point, 5)).toBeNull();
  });

  it("does not multiply pointer coordinates by devicePixelRatio", () => {
    const image = { width: 640, height: 480 };
    const css = fitImageToView(image, { width: 400, height: 400 });
    const rect = { left: 30, top: 40, ...css };
    const point = clientToImage(30 + 100, 40 + 75, rect, image);
    for (const ratio of [1, 1.5, 2, 3]) {
      const backing = backingStoreSize(css, ratio);
      expect(backing.width).toBe(Math.round(css.width * Math.min(ratio, 2)));
      // The same CSS pointer always addresses the same source pixel, whatever the backing resolution.
      expect(clientToImage(30 + 100, 40 + 75, rect, image)).toEqual(point);
    }
    expect(point).toEqual({ x: 160, y: 120 });
  });

  it("samples source pixels consistently at high DPR", () => {
    const image = { width: 4, height: 2 };
    const backing = backingStoreSize({ width: 4, height: 2 }, 2);
    expect(backing).toEqual({ width: 8, height: 4 });
    expect(Array.from(samplingMap(backing.width, image.width))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(Array.from(samplingMap(3, 7))).toEqual([1, 3, 5]);
  });

  it("shows the brush outline at the same size as the erased area", () => {
    const image = { width: 1200, height: 800 };
    const rect = { left: 0, top: 0, width: 600, height: 400 };
    // A 40 px source brush is 20 CSS px at half scale.
    expect(imageLengthToClient(40, rect, image)).toBe(20);
    const mask = new EraseMask(image.width, image.height);
    const centre = clientToImage(300, 200, rect, image);
    mask.begin(centre, 20);
    mask.end();
    const row = Math.floor(centre.y);
    const erasedColumns = Array.from(mask.data.subarray(row * image.width, (row + 1) * image.width)).reduce((sum, value) => sum + value, 0);
    expect(erasedColumns).toBe(40);
  });
});

describe("Cleanup preview", () => {
  it("covers every backing pixel that samples a dirty source rectangle", () => {
    const image = { width: 50, height: 30 };
    for (const backing of [{ width: 17, height: 11 }, { width: 100, height: 60 }, { width: 173, height: 104 }]) {
      const columns = samplingMap(backing.width, image.width);
      const rows = samplingMap(backing.height, image.height);
      const rect = { x: 12, y: 7, width: 9, height: 5 };
      const area = imageRectToBacking(rect, image, backing);
      for (let y = 0; y < backing.height; y++) {
        for (let x = 0; x < backing.width; x++) {
          const inside = columns[x] >= rect.x && columns[x] < rect.x + rect.width && rows[y] >= rect.y && rows[y] < rect.y + rect.height;
          if (inside) {
            expect(x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height).toBe(true);
          }
        }
      }
    }
  });

  it("makes erased samples transparent and restores base alpha after undo", () => {
    const image = { width: 4, height: 2 };
    const backing = { width: 8, height: 4 };
    const base = new Uint8ClampedArray(backing.width * backing.height * 4).fill(200);
    const preview = base.slice();
    const mask = new Uint8Array(8);
    mask[1] = 1;
    const columns = samplingMap(backing.width, image.width);
    const rows = samplingMap(backing.height, image.height);
    const all = { x: 0, y: 0, ...backing };
    updatePreviewAlpha(preview, base, backing.width, columns, rows, mask, image.width, all);
    const alphaAt = (x: number, y: number) => preview[(y * backing.width + x) * 4 + 3];
    expect([alphaAt(2, 0), alphaAt(3, 1), alphaAt(1, 0), alphaAt(2, 2)]).toEqual([0, 0, 200, 200]);
    mask[1] = 0;
    updatePreviewAlpha(preview, base, backing.width, columns, rows, mask, image.width, all);
    expect(preview).toEqual(base);
  });
});

describe("brush size", () => {
  it("reaches 1 px and the maximum through a logarithmic slider", () => {
    const max = maxBrushDiameter({ width: 3000, height: 2000 });
    expect(max).toBe(1500);
    expect(brushDiameterFromSlider(0, max)).toBe(1);
    expect(brushDiameterFromSlider(BRUSH_SLIDER_MAX, max)).toBe(max);
    for (const diameter of [1, 7, 40, 300, 1500]) {
      expect(Math.abs(brushDiameterFromSlider(brushSliderFromDiameter(diameter, max), max) - diameter) / diameter).toBeLessThan(0.05);
    }
  });

  it("defaults to a visible brush for small and large images", () => {
    expect(defaultBrushDiameter({ width: 40, height: 20 })).toBe(2);
    expect(defaultBrushDiameter({ width: 600, height: 400 })).toBe(24);
    expect(defaultBrushDiameter({ width: 3000, height: 2000 })).toBe(120);
    expect(maxBrushDiameter({ width: 6, height: 4 })).toBe(8);
  });
});
