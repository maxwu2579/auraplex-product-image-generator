import { describe, expect, it } from "vitest";
import { autoPlaceProducts, classifyProductAspect, getRegions, layoutConfig } from "./layout";
import type { ImageAsset, ProductPlacement, Rect } from "./types";

function item(id: number, aspect: number): ImageAsset {
  return { id: String(id), name: `Item ${id}`, url: "", width: aspect * 100, height: 100 };
}

function rowSizes(placements: ProductPlacement[]): number[] {
  const rows = new Map<number, number>();
  for (const placement of placements) {
    const center = Math.round((placement.y + placement.height / 2) * 100) / 100;
    rows.set(center, (rows.get(center) ?? 0) + 1);
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, count]) => count);
}

function expectSafe(placements: ProductPlacement[], items: ImageAsset[], region: Rect): void {
  const { horizontalMargin, verticalMargin } = layoutConfig.productArea;
  for (const [index, placement] of placements.entries()) {
    expect(placement.x).toBeGreaterThanOrEqual(region.x + horizontalMargin - 0.001);
    expect(placement.y).toBeGreaterThanOrEqual(region.y + verticalMargin - 0.001);
    expect(placement.x + placement.width).toBeLessThanOrEqual(region.x + region.width - horizontalMargin + 0.001);
    expect(placement.y + placement.height).toBeLessThanOrEqual(region.y + region.height - verticalMargin + 0.001);
    expect(placement.width / placement.height).toBeCloseTo(items[index].width / items[index].height);
    for (const other of placements.slice(index + 1)) {
      const overlapWidth = Math.min(placement.x + placement.width, other.x + other.width) - Math.max(placement.x, other.x);
      const overlapHeight = Math.min(placement.y + placement.height, other.y + other.height) - Math.max(placement.y, other.y);
      expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
    }
  }
}

const region = getRegions("brand-only", "text-only").middle;

describe("aspect-aware product layout", () => {
  it("classifies cropped dimensions using central thresholds", () => {
    expect(classifyProductAspect(item(0, 0.5))).toBe("portrait");
    expect(classifyProductAspect(item(0, 1))).toBe("neutral");
    expect(classifyProductAspect(item(0, 2))).toBe("landscape");
  });

  it.each([0.35, 1, 3.5])("centers one product with aspect ratio %s", (aspect) => {
    const items = [item(0, aspect)];
    const [placement] = autoPlaceProducts(items, region);
    expect(placement.x + placement.width / 2).toBeCloseTo(region.x + region.width / 2);
    expect(placement.y + placement.height / 2).toBeCloseTo(region.y + region.height / 2);
    expectSafe([placement], items, region);
  });

  it.each([0.08, 12])("contains an extreme aspect ratio %s without distortion", (aspect) => {
    const items = [item(0, aspect), item(1, 1), item(2, aspect)];
    expectSafe(autoPlaceProducts(items, region), items, region);
  });

  it.each([
    { name: "square pair", aspects: [1, 1], rows: [2] },
    { name: "portrait pair", aspects: [0.45, 0.5], rows: [2] },
    { name: "landscape pair", aspects: [3, 3.5], rows: [1, 1] },
    { name: "mixed pair", aspects: [0.45, 2.5], rows: [2] },
  ])("chooses a sensible arrangement for $name", ({ aspects, rows }) => {
    const items = aspects.map((aspect, index) => item(index, aspect));
    const placements = autoPlaceProducts(items, region);
    expect(rowSizes(placements)).toEqual(rows);
    expectSafe(placements, items, region);
  });

  it("gives a wide pair substantially more usable area than the former fixed side-by-side cells", () => {
    const items = [item(0, 3), item(1, 3)];
    const placements = autoPlaceProducts(items, region);
    const oldCellWidth = (region.width - 2 * 36 - 24) / 2 - 24;
    const oldItemArea = oldCellWidth * oldCellWidth / 3;
    expect(Math.min(...placements.map((placement) => placement.width * placement.height))).toBeGreaterThan(oldItemArea * 2);
  });

  it.each([
    { aspects: [3, 1, 1], rows: [1, 2] },
    { aspects: [0.45, 3, 3], rows: [2, 1] },
    { aspects: [0.4, 0.4, 0.4], rows: [3] },
  ])("evaluates all three-item candidate patterns: $rows", ({ aspects, rows }) => {
    const items = aspects.map((aspect, index) => item(index, aspect));
    const placements = autoPlaceProducts(items, region);
    expect(rowSizes(placements)).toEqual(rows);
    expect(autoPlaceProducts(items, region)).toEqual(placements);
    expectSafe(placements, items, region);
  });

  it("keeps four products in a stable 2×2 grid", () => {
    const items = [0.4, 1, 3, 0.6].map(itemFromAspect);
    const placements = autoPlaceProducts(items, region);
    expect(rowSizes(placements)).toEqual([2, 2]);
    expectSafe(placements, items, region);
  });

  it.each([
    { aspects: [1, 1, 1, 3, 3], rows: [3, 2] },
    { aspects: [3, 3, 1, 1, 1], rows: [2, 3] },
  ])("scores both five-product row orders: $rows", ({ aspects, rows }) => {
    const items = aspects.map((aspect, index) => item(index, aspect));
    const placements = autoPlaceProducts(items, region);
    expect(rowSizes(placements)).toEqual(rows);
    expectSafe(placements, items, region);
  });

  it("stays within safe margins for 1–5 mixed items in all four region modes", () => {
    const items = [0.3, 3.8, 1, 0.55, 2.4].map(itemFromAspect);
    for (const top of ["brand-only", "brand-image"] as const) {
      for (const bottom of ["text-only", "text-image"] as const) {
        const middle = getRegions(top, bottom).middle;
        for (let count = 1; count <= 5; count++) {
          const selected = items.slice(0, count);
          const placements = autoPlaceProducts(selected, middle);
          expect(placements).toHaveLength(count);
          expectSafe(placements, selected, middle);
        }
      }
    }
  });
});

function itemFromAspect(aspect: number, index: number): ImageAsset {
  return item(index, aspect);
}
