import { describe, expect, it } from "vitest";
import { autoPlaceProducts, brandLogoBox, CANVAS_SIZE, clampPlacement, fitInside, getRegions, supportingImageBox } from "./layout";
import type { ImageAsset } from "./types";

const images = Array.from({ length: 5 }, (_, index): ImageAsset => ({
  id: String(index), name: `Product ${index}`, url: "", width: index % 2 ? 1200 : 400, height: index % 2 ? 300 : 900,
}));

describe("adaptive canvas layout", () => {
  it("keeps each mode inside a 1000px canvas with a useful middle region", () => {
    for (const top of ["brand-only", "brand-image"] as const) {
      for (const bottom of ["text-only", "text-image"] as const) {
        const regions = getRegions(top, bottom);
        expect(regions.top.height + regions.middle.height + regions.bottom.height).toBe(CANVAS_SIZE);
        expect(regions.middle.height).toBeGreaterThanOrEqual(520);
        expect(regions.bottom.y + regions.bottom.height).toBe(CANVAS_SIZE);
      }
    }
  });

  it("places 1–5 images within the middle region while retaining aspect ratio", () => {
    const middle = getRegions("brand-image", "text-image").middle;
    for (let count = 1; count <= 5; count++) {
      const placements = autoPlaceProducts(images.slice(0, count), middle);
      expect(placements).toHaveLength(count);
      for (const [index, placement] of placements.entries()) {
        expect(placement.x).toBeGreaterThanOrEqual(middle.x);
        expect(placement.y).toBeGreaterThanOrEqual(middle.y);
        expect(placement.x + placement.width).toBeLessThanOrEqual(middle.x + middle.width);
        expect(placement.y + placement.height).toBeLessThanOrEqual(middle.y + middle.height);
        expect(placement.width / placement.height).toBeCloseTo(images[index].width / images[index].height);
      }
    }
  });

  it("clamps adjusted objects to their intended region", () => {
    const middle = getRegions("brand-only", "text-only").middle;
    const rect = clampPlacement({ x: -50, y: 900, width: 300, height: 250 }, middle);
    expect(rect.x).toBe(middle.x);
    expect(rect.y + rect.height).toBe(middle.y + middle.height);
  });

  it("fits a cropped portrait or wide logo centrally with larger safe bounds", () => {
    for (const mode of ["brand-only", "brand-image"] as const) {
      const regions = getRegions(mode, "text-only");
      const box = brandLogoBox(mode, regions);
      const priorUsableHeight = regions.top.height - 40;
      expect(box.height).toBeGreaterThan(priorUsableHeight);
      expect(box.y).toBeGreaterThanOrEqual(regions.top.y);
      expect(box.y + box.height).toBeLessThanOrEqual(regions.top.height);
      if (mode === "brand-image") {
        expect(box.x + box.width).toBeLessThan(supportingImageBox("top", regions).x);
      }
      for (const source of [{ width: 525, height: 600 }, { width: 1200, height: 250 }]) {
        const placement = fitInside(source, box);
        expect(placement.width / placement.height).toBeCloseTo(source.width / source.height);
        expect(placement.x + placement.width / 2).toBeCloseTo(box.x + box.width / 2);
        expect(placement.y + placement.height / 2).toBeCloseTo(box.y + box.height / 2);
      }
    }
  });
});
