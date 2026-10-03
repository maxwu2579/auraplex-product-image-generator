export type TopLayout = "brand-only" | "brand-image";
export type BottomLayout = "text-only" | "text-image";

export interface ImageAsset {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  /** Product images only: identity of the processing run that produced this image. Reprocessing changes it. */
  generation?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProductPlacement extends Rect {
  id: string;
}
