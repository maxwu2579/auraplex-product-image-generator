import type { ImageAsset } from "./types";

export const MAX_FINAL_PRODUCTS = 5;

export interface SubjectCandidate {
  id: string;
  image: ImageAsset;
  small: boolean;
  area: number;
}

export interface ProductSource {
  id: string;
  file: File;
  name: string;
  status: "processing" | "ready" | "error";
  whole: ImageAsset | null;
  candidates: SubjectCandidate[];
  mode: "whole" | "subjects";
  selectedIds: string[];
  confirmed: boolean;
  error: string;
  warning: string;
}

export function chosenImages(source: ProductSource): ImageAsset[] {
  if (source.status !== "ready") return [];
  if (source.mode === "whole") return source.whole ? [source.whole] : [];
  return source.candidates.filter((item) => source.selectedIds.includes(item.id)).map((item) => item.image);
}

export function selectedTotal(sources: ProductSource[]): number {
  return sources.reduce((total, source) => total + chosenImages(source).length, 0);
}

export function canvasImages(sources: ProductSource[]): ImageAsset[] {
  return sources.filter((source) => source.confirmed).flatMap(chosenImages);
}

/** Every product image a ready source still offers (whole image and all candidates), selected or not. */
export function sourceImages(sources: ProductSource[]): ImageAsset[] {
  return sources.flatMap((source) => source.status === "ready"
    ? [...(source.whole ? [source.whole] : []), ...source.candidates.map((candidate) => candidate.image)]
    : []);
}

export function defaultSelection(source: ProductSource, existing: ProductSource[]): ProductSource {
  const available = Math.max(0, MAX_FINAL_PRODUCTS - selectedTotal(existing));
  const likely = source.candidates.filter((item) => !item.small).slice(0, available);
  if (likely.length) return { ...source, mode: "subjects", selectedIds: likely.map((item) => item.id) };
  return { ...source, mode: source.candidates.length || available === 0 ? "subjects" : "whole", selectedIds: [] };
}

export function chooseWhole(sources: ProductSource[], sourceId: string, checked: boolean): ProductSource[] | null {
  const target = sources.find((source) => source.id === sourceId);
  if (!target || target.status !== "ready") return sources;
  const next = sources.map((source) => source.id === sourceId
    ? { ...source, mode: checked ? "whole" as const : "subjects" as const, selectedIds: [], confirmed: false }
    : source);
  return selectedTotal(next) <= MAX_FINAL_PRODUCTS ? next : null;
}

export function chooseCandidate(sources: ProductSource[], sourceId: string, candidateId: string, checked: boolean): ProductSource[] | null {
  const target = sources.find((source) => source.id === sourceId);
  if (!target || target.status !== "ready" || !target.candidates.some((item) => item.id === candidateId)) return sources;
  const next = sources.map((source) => source.id === sourceId ? {
    ...source,
    mode: "subjects" as const,
    selectedIds: checked
      ? [...(source.mode === "subjects" ? source.selectedIds : []), candidateId]
      : source.selectedIds.filter((id) => id !== candidateId),
    confirmed: false,
  } : source);
  return selectedTotal(next) <= MAX_FINAL_PRODUCTS ? next : null;
}
