import type { BottomLayout, ImageAsset, ProductPlacement, Rect, TopLayout } from "./types";

export const CANVAS_SIZE = 1000;

export const layoutConfig = {
  top: { "brand-only": 0.14, "brand-image": 0.17 },
  bottom: { "text-only": 0.19, "text-image": 0.26 },
  minMiddleHeight: 520,
  productArea: {
    horizontalMargin: 36,
    verticalMargin: 36,
    itemGap: 24,
    rowGap: 28,
    occupancy: 0.94,
    widthWeight: { portrait: 0.82, neutral: 1, landscape: 1.2 },
  },
  aspectRatio: { portraitMax: 0.8, landscapeMin: 1.25 },
  layoutScoring: {
    coverage: 0.45,
    minimumSize: 0.2,
    sizeBalance: 0.15,
    spread: 0.1,
    centering: 0.1,
  },
  brandLogo: {
    "brand-only": { x: 100, width: 800, verticalInset: 5 },
    "brand-image": { x: 58, width: 575, verticalInset: 7 },
  },
} as const;

export interface Regions {
  top: Rect;
  middle: Rect;
  bottom: Rect;
}

export function getRegions(topMode: TopLayout, bottomMode: BottomLayout): Regions {
  const topHeight = Math.round(CANVAS_SIZE * layoutConfig.top[topMode]);
  const bottomHeight = Math.round(CANVAS_SIZE * layoutConfig.bottom[bottomMode]);
  const middleHeight = CANVAS_SIZE - topHeight - bottomHeight;
  if (middleHeight < layoutConfig.minMiddleHeight) {
    throw new Error("Layout leaves too little space for products");
  }
  return {
    top: { x: 0, y: 0, width: CANVAS_SIZE, height: topHeight },
    middle: { x: 0, y: topHeight, width: CANVAS_SIZE, height: middleHeight },
    bottom: { x: 0, y: topHeight + middleHeight, width: CANVAS_SIZE, height: bottomHeight },
  };
}

export function fitInside(source: Pick<ImageAsset, "width" | "height">, box: Rect, padding = 0): Rect {
  const innerWidth = Math.max(1, box.width - padding * 2);
  const innerHeight = Math.max(1, box.height - padding * 2);
  const scale = Math.min(innerWidth / source.width, innerHeight / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function supportingImageBox(role: "top" | "bottom", regions: Regions): Rect {
  return role === "top"
    ? { x: 670, y: 12, width: 290, height: regions.top.height - 24 }
    : { x: 610, y: regions.bottom.y + 16, width: 355, height: regions.bottom.height - 32 };
}

export function brandLogoBox(topMode: TopLayout, regions: Regions): Rect {
  const config = layoutConfig.brandLogo[topMode];
  return {
    x: config.x,
    y: regions.top.y + config.verticalInset,
    width: config.width,
    height: regions.top.height - config.verticalInset * 2,
  };
}

type LayoutItem = Pick<ImageAsset, "id" | "width" | "height">;
type Pattern = readonly (readonly number[])[];

const productPatterns: Record<1 | 2 | 3 | 4 | 5, readonly Pattern[]> = {
  1: [[[0]]],
  2: [[[0, 1]], [[0], [1]]],
  3: [[[0, 1], [2]], [[0], [1, 2]], [[0, 1, 2]]],
  4: [[[0, 1], [2, 3]]],
  5: [[[0, 1, 2], [3, 4]], [[0, 1], [2, 3, 4]]],
};

export function classifyProductAspect(item: Pick<ImageAsset, "width" | "height">): "portrait" | "neutral" | "landscape" {
  const aspect = item.width / item.height;
  if (aspect < layoutConfig.aspectRatio.portraitMax) return "portrait";
  if (aspect > layoutConfig.aspectRatio.landscapeMin) return "landscape";
  return "neutral";
}

function productArea(region: Rect): Rect {
  const { horizontalMargin, verticalMargin } = layoutConfig.productArea;
  return {
    x: region.x + horizontalMargin,
    y: region.y + verticalMargin,
    width: region.width - horizontalMargin * 2,
    height: region.height - verticalMargin * 2,
  };
}

function placePattern(items: readonly LayoutItem[], area: Rect, pattern: Pattern): ProductPlacement[] {
  const { itemGap, rowGap, occupancy, widthWeight } = layoutConfig.productArea;
  const rowHeight = (area.height - rowGap * (pattern.length - 1)) / pattern.length;
  const placements: ProductPlacement[] = Array(items.length);
  for (const [rowIndex, row] of pattern.entries()) {
    const weights = row.map((index) => widthWeight[classifyProductAspect(items[index])]);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const availableWidth = area.width - itemGap * (row.length - 1);
    let x = area.x;
    for (const [column, index] of row.entries()) {
      const cellWidth = availableWidth * weights[column] / totalWeight;
      const cell = { x, y: area.y + rowIndex * (rowHeight + rowGap), width: cellWidth, height: rowHeight };
      const fit = fitInside(items[index], cell);
      const width = fit.width * occupancy;
      const height = fit.height * occupancy;
      placements[index] = {
        id: items[index].id,
        x: cell.x + (cell.width - width) / 2,
        y: cell.y + (cell.height - height) / 2,
        width,
        height,
      };
      x += cellWidth + itemGap;
    }
  }
  return placements;
}

function scoreProductLayout(placements: readonly ProductPlacement[], area: Rect): number {
  const weights = layoutConfig.layoutScoring;
  const sizes = placements.map((item) => item.width * item.height);
  const totalSize = sizes.reduce((sum, size) => sum + size, 0);
  const smallest = Math.min(...sizes);
  const largest = Math.max(...sizes);
  const targetSize = area.width * area.height / placements.length;
  const coverage = Math.min(1, totalSize / (area.width * area.height));
  const minimumSize = Math.min(1, smallest / targetSize);
  const sizeBalance = smallest / largest;
  const left = Math.min(...placements.map((item) => item.x));
  const right = Math.max(...placements.map((item) => item.x + item.width));
  const top = Math.min(...placements.map((item) => item.y));
  const bottom = Math.max(...placements.map((item) => item.y + item.height));
  const spread = ((right - left) / area.width + (bottom - top) / area.height) / 2;
  const centerX = placements.reduce((sum, item, index) => sum + (item.x + item.width / 2) * sizes[index], 0) / totalSize;
  const centerY = placements.reduce((sum, item, index) => sum + (item.y + item.height / 2) * sizes[index], 0) / totalSize;
  const centering = 1 - Math.min(1, Math.hypot((centerX - area.x - area.width / 2) / area.width, (centerY - area.y - area.height / 2) / area.height));
  return weights.coverage * coverage + weights.minimumSize * minimumSize + weights.sizeBalance * sizeBalance
    + weights.spread * spread + weights.centering * centering;
}

export function autoPlaceProducts(images: readonly LayoutItem[], region: Rect): ProductPlacement[] {
  if (images.length < 1 || images.length > 5) return [];
  const area = productArea(region);
  const patterns = productPatterns[images.length as 1 | 2 | 3 | 4 | 5];
  let best: ProductPlacement[] = [];
  let bestScore = -Infinity;
  for (const pattern of patterns) {
    const placements = placePattern(images, area, pattern);
    const score = scoreProductLayout(placements, area);
    if (score > bestScore) { best = placements; bestScore = score; }
  }
  return best;
}

export function clampPlacement(rect: Rect, region: Rect): Rect {
  const scale = Math.min(1, region.width / rect.width, region.height / rect.height);
  const width = rect.width * scale;
  const height = rect.height * scale;
  return {
    x: Math.max(region.x, Math.min(rect.x, region.x + region.width - width)),
    y: Math.max(region.y, Math.min(rect.y, region.y + region.height - height)),
    width,
    height,
  };
}
