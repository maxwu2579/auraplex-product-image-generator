import type { ImageAsset } from "./types";

/**
 * Product content versions for Cleanup, kept apart from placements.
 *
 * A product is identified by its asset id plus the processing generation that
 * produced its image. Resolution rule, used by the main canvas, derived product
 * lists, Cleanup sessions and export alike:
 *   a record for the current generation exists → its applied content
 *   otherwise                                  → the processed base
 */

export interface ContentImage {
  url: string;
  width: number;
  height: number;
}

export interface ProductContentRecord {
  generation: string;
  /** Committed content revision; the processed base alone is revision 0. */
  revision: number;
  /** Applied Cleanup image, or null when the processed base is applied. */
  applied: ContentImage | null;
  /** One-level Undo Last Apply target (null inside means the processed base); consumed when used. */
  undo: { applied: ContentImage | null } | null;
}

export type ProductContentState = Readonly<Record<string, ProductContentRecord>>;

export interface ResolvedProduct extends ImageAsset {
  revision: number;
}

/** Product identity and the content revision an operation was prepared against. */
export interface ContentTarget {
  id: string;
  generation: string;
  revision: number;
}

export interface ContentChange {
  state: ProductContentState;
  /** Object URLs no longer referenced by this state. */
  released: string[];
}

export type ContentUpdate =
  | { ok: true; change: ContentChange }
  | { ok: false; reason: "missing" | "stale" | "size" | "unchanged" | "no-undo" };

export interface CleanupSession {
  id: number;
  productId: string;
  name: string;
  generation: string;
  /** Revision the session started from; Apply is refused if it changes. */
  revision: number;
  /** Content applied when the session opened. */
  entry: ContentImage;
  /** Processed base of the current generation: the Reset target. */
  base: ContentImage;
}

export type CleanupResult =
  | { kind: "unchanged" }
  | { kind: "base" }
  | { kind: "image"; image: ContentImage };

export function currentRecord(state: ProductContentState, product: Pick<ImageAsset, "id" | "generation">): ProductContentRecord | null {
  const record = state[product.id];
  return record && product.generation && record.generation === product.generation ? record : null;
}

export function resolveProduct(product: ImageAsset, state: ProductContentState): ResolvedProduct {
  const record = currentRecord(state, product);
  return { ...product, url: record?.applied?.url ?? product.url, revision: record?.revision ?? 0 };
}

export function resolveProducts(products: readonly ImageAsset[], state: ProductContentState): ResolvedProduct[] {
  return products.map((product) => resolveProduct(product, state));
}

export function createCleanupSession(id: number, product: ImageAsset, state: ProductContentState): CleanupSession | null {
  if (!product.generation) return null;
  const resolved = resolveProduct(product, state);
  const size = { width: product.width, height: product.height };
  return {
    id, productId: product.id, name: product.name, generation: product.generation, revision: resolved.revision,
    entry: { url: resolved.url, ...size }, base: { url: product.url, ...size },
  };
}

export function referencedUrls(state: ProductContentState): Set<string> {
  const urls = new Set<string>();
  for (const record of Object.values(state)) {
    if (record.applied) urls.add(record.applied.url);
    if (record.undo?.applied) urls.add(record.undo.applied.url);
  }
  return urls;
}

function unreferenced(urls: (string | undefined)[], state: ProductContentState): string[] {
  const kept = referencedUrls(state);
  return urls.filter((url): url is string => Boolean(url) && !kept.has(url!));
}

function liveTarget(live: readonly ImageAsset[], state: ProductContentState, target: ContentTarget) {
  const product = live.find((item) => item.id === target.id && item.generation === target.generation);
  if (!product) return { ok: false as const, reason: "missing" as const };
  const record = currentRecord(state, product);
  if ((record?.revision ?? 0) !== target.revision) return { ok: false as const, reason: "stale" as const };
  return { ok: true as const, product, record };
}

/**
 * Commits new applied content for one product (null = processed base). The previous
 * applied content becomes the one-level undo target; the older undo target is released.
 * Refused when the product is gone, was reprocessed, or changed since `target.revision`.
 */
export function commitContent(state: ProductContentState, live: readonly ImageAsset[], target: ContentTarget, next: ContentImage | null): ContentUpdate {
  const found = liveTarget(live, state, target);
  if (!found.ok) return found;
  const { product, record } = found;
  if (next && (next.width !== product.width || next.height !== product.height)) return { ok: false, reason: "size" };
  const current = record?.applied ?? null;
  if ((current?.url ?? null) === (next?.url ?? null)) return { ok: false, reason: "unchanged" };
  const nextState = { ...state, [product.id]: { generation: target.generation, revision: target.revision + 1, applied: next, undo: { applied: current } } };
  return { ok: true, change: { state: nextState, released: unreferenced([record?.undo?.applied?.url], nextState) } };
}

/** Restores the undo target and consumes it; the undone content is released. */
export function undoLastApply(state: ProductContentState, live: readonly ImageAsset[], target: ContentTarget): ContentUpdate {
  const found = liveTarget(live, state, target);
  if (!found.ok) return found;
  const { product, record } = found;
  if (!record?.undo) return { ok: false, reason: "no-undo" };
  const nextState = { ...state, [product.id]: { ...record, revision: record.revision + 1, applied: record.undo.applied, undo: null } };
  return { ok: true, change: { state: nextState, released: unreferenced([record.applied?.url], nextState) } };
}

/**
 * Drops records whose product image no longer exists in the current generation
 * (source removed, reprocessed or failed). Images that are still available as a
 * whole image or subject candidate keep their records even when not on the canvas.
 */
export function pruneContent(state: ProductContentState, live: readonly ImageAsset[]): ContentChange | null {
  const stale = Object.entries(state).filter(([id, record]) => !live.some((item) => item.id === id && item.generation === record.generation));
  if (!stale.length) return null;
  const nextState = Object.fromEntries(Object.entries(state).filter(([id]) => !stale.some(([staleId]) => staleId === id)));
  return { state: nextState, released: unreferenced(stale.flatMap(([, record]) => [record.applied?.url, record.undo?.applied?.url]), nextState) };
}

/**
 * Object URLs created for Cleanup results. Only URLs adopted here are ever revoked,
 * and only once no content record or pinned user (such as an open session) needs them.
 */
export class OwnedObjectUrls {
  private readonly owned = new Set<string>();

  constructor(private readonly revoke: (url: string) => void) {}

  get size(): number {
    return this.owned.size;
  }

  adopt(url: string): void {
    this.owned.add(url);
  }

  release(urls: Iterable<string>, stillReferenced: ReadonlySet<string>): void {
    for (const url of urls) {
      if (this.owned.has(url) && !stillReferenced.has(url)) {
        this.owned.delete(url);
        this.revoke(url);
      }
    }
  }

  releaseAll(): void {
    this.release([...this.owned], new Set());
  }
}
