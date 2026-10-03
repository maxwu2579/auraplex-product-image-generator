import type { PixelRect, Point } from "./cleanupMask";

/**
 * Display geometry for the Cleanup editor. Strokes live in the product image's own
 * W × H source pixels; the editor only shows that image fitted into the dialog.
 * Nothing here depends on the main canvas placement.
 */

export interface Size {
  width: number;
  height: number;
}

/** CSS-pixel box of the displayed image, as returned by getBoundingClientRect(). */
export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Backing-store pixels per CSS pixel are capped to bound preview memory; this never affects source coordinates. */
export const MAX_DISPLAY_PIXEL_RATIO = 2;
export const BRUSH_SLIDER_MAX = 200;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Largest CSS size that shows the whole image inside the view without changing its aspect ratio. */
export function fitImageToView(image: Size, view: Size): Size {
  const scale = Math.min(view.width / image.width, view.height / image.height);
  if (!(scale > 0)) return { width: 0, height: 0 };
  return { width: Math.max(1, Math.floor(image.width * scale)), height: Math.max(1, Math.floor(image.height * scale)) };
}

/**
 * Pointer position (CSS pixels) to continuous source-pixel coordinates: the inverse
 * of the display transform. The displayed rectangle already includes the dialog
 * offset and fit scale; devicePixelRatio does not apply to pointer coordinates.
 */
export function clientToImage(clientX: number, clientY: number, displayed: ViewRect, image: Size): Point {
  return {
    x: (clientX - displayed.left) * image.width / displayed.width,
    y: (clientY - displayed.top) * image.height / displayed.height,
  };
}

/** Length in source pixels shown on screen, in CSS pixels (used for the brush outline). */
export function imageLengthToClient(length: number, displayed: ViewRect, image: Size): number {
  return length * displayed.width / image.width;
}

export function backingStoreSize(css: Size, devicePixelRatio: number): Size {
  const ratio = clamp(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1, MAX_DISPLAY_PIXEL_RATIO);
  return { width: Math.max(1, Math.round(css.width * ratio)), height: Math.max(1, Math.round(css.height * ratio)) };
}

/** Source pixel sampled by each backing-store pixel (nearest, through pixel centres). */
export function samplingMap(backingLength: number, imageLength: number): Uint32Array {
  const map = new Uint32Array(backingLength);
  for (let index = 0; index < backingLength; index++) {
    map[index] = Math.min(imageLength - 1, Math.floor((index + 0.5) * imageLength / backingLength));
  }
  return map;
}

/** Backing-store rectangle whose samples can fall inside a source-pixel rectangle. */
export function imageRectToBacking(rect: PixelRect, image: Size, backing: Size): PixelRect {
  const x0 = clamp(Math.floor(rect.x * backing.width / image.width) - 1, 0, backing.width);
  const y0 = clamp(Math.floor(rect.y * backing.height / image.height) - 1, 0, backing.height);
  const x1 = clamp(Math.ceil((rect.x + rect.width) * backing.width / image.width) + 1, 0, backing.width);
  const y1 = clamp(Math.ceil((rect.y + rect.height) * backing.height / image.height) + 1, 0, backing.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Updates preview alpha inside a backing rectangle: erased samples are transparent,
 * all others show the base display pixel. Display only; the output PNG is built
 * from source pixels.
 */
export function updatePreviewAlpha(
  preview: Uint8ClampedArray,
  base: Uint8ClampedArray,
  backingWidth: number,
  columns: Uint32Array,
  rows: Uint32Array,
  mask: Uint8Array,
  imageWidth: number,
  rect: PixelRect,
): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const maskRow = rows[y] * imageWidth;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const alpha = (y * backingWidth + x) * 4 + 3;
      preview[alpha] = mask[maskRow + columns[x]] ? 0 : base[alpha];
    }
  }
}

export function maxBrushDiameter(image: Size): number {
  return Math.max(8, Math.ceil(Math.max(image.width, image.height) / 2));
}

export function defaultBrushDiameter(image: Size): number {
  return clamp(Math.round(Math.max(image.width, image.height) * 0.04), 2, maxBrushDiameter(image));
}

/** Logarithmic slider so both 1 px touch-ups and large areas are reachable. */
export function brushDiameterFromSlider(step: number, max: number): number {
  return clamp(Math.round(max ** (clamp(step, 0, BRUSH_SLIDER_MAX) / BRUSH_SLIDER_MAX)), 1, max);
}

export function brushSliderFromDiameter(diameter: number, max: number): number {
  return clamp(Math.round(Math.log(clamp(diameter, 1, max)) / Math.log(max) * BRUSH_SLIDER_MAX), 0, BRUSH_SLIDER_MAX);
}

/** Loads and fully decodes an image URL, e.g. to prove a new content version can be displayed before committing it. */
export async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const image = new window.Image();
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image has no size");
  return image;
}
