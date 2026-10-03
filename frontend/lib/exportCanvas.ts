import type Konva from "konva";
import { CANVAS_SIZE } from "./layout";

export type ExportFormat = "png" | "jpg";

const JPG_QUALITY = 0.94;
/** How long export waits for the expected content versions to finish rendering. */
export const EXPORT_READY_TIMEOUT_MS = 5000;
/** Konva node name for product images; their attrs carry productId and the contentUrl actually drawn. */
export const PRODUCT_NODE_NAME = "product-image";

/** Retryable: expected images or content versions are not rendered yet. */
export class ExportNotReadyError extends Error {
  constructor(message = "图片仍在加载，请稍候再导出。") {
    super(message);
    this.name = "ExportNotReadyError";
  }
}

/** One product's content version that an export must contain. */
export interface ExpectedProductContent {
  id: string;
  url: string;
  revision: number;
}

export interface CaptureExpectations {
  /** Content snapshot taken when export started; every product node must show exactly this version. */
  products?: readonly ExpectedProductContent[];
  /** Content URLs that failed to load; exporting would otherwise wait for them forever. */
  failedUrls?: ReadonlySet<string>;
}

export function exportFilename(format: ExportFormat, date = new Date()): string {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("") + "-" + [
    date.getHours(), date.getMinutes(), date.getSeconds(),
  ].map((part) => String(part).padStart(2, "0")).join("");
  return `product-image-${stamp}.${format}`;
}

function imageReady(node: Konva.Node): boolean {
  const image = (node as Konva.Image).image();
  return Boolean(image) && !(typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement && (!image.complete || !image.naturalWidth));
}

/** Every expected product is drawn exactly once, from a loaded image of the expected content version. */
function productsRendered(stage: Konva.Stage, products: readonly ExpectedProductContent[]): boolean {
  const nodes = stage.find(`.${PRODUCT_NODE_NAME}`);
  return nodes.length === products.length && products.every((product) => {
    const matches = nodes.filter((node) => node.getAttr("productId") === product.id);
    return matches.length === 1 && matches[0].getAttr("contentUrl") === product.url && imageReady(matches[0]);
  });
}

export function captureStage(stage: Konva.Stage, format: ExportFormat, expectedImages: number, expected: CaptureExpectations = {}): string {
  if (expected.products?.some((product) => expected.failedUrls?.has(product.url))) {
    throw new Error("产品图片加载失败，无法导出当前版本；请撤销上次清理或重新处理该产品。");
  }
  const images = stage.find("Image");
  if (images.length !== expectedImages || !images.every(imageReady) || (expected.products && !productsRendered(stage, expected.products))) {
    throw new ExportNotReadyError();
  }

  const transformers = stage.find("Transformer");
  const visibility = transformers.map((node) => node.visible());
  try {
    transformers.forEach((node) => node.hide());
    stage.draw();
    return stage.toDataURL({
      pixelRatio: CANVAS_SIZE / stage.width(),
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      quality: format === "jpg" ? JPG_QUALITY : undefined,
    });
  } finally {
    transformers.forEach((node, index) => node.visible(visibility[index]));
    stage.draw();
  }
}

/**
 * Retries a synchronous capture while it reports ExportNotReadyError, up to a
 * deadline. Each attempt checks and draws within one task, so an export never
 * mixes content revisions.
 */
export async function captureWhenReady(attempt: () => string, options: {
  timeoutMs?: number;
  wait?: () => Promise<void>;
  now?: () => number;
  onWaiting?: () => void;
} = {}): Promise<string> {
  const { timeoutMs = EXPORT_READY_TIMEOUT_MS, wait = () => new Promise<void>((resolve) => setTimeout(resolve, 50)), now = () => Date.now(), onWaiting } = options;
  const deadline = now() + timeoutMs;
  for (let waited = false; ; waited = true) {
    try {
      return attempt();
    } catch (cause) {
      if (!(cause instanceof ExportNotReadyError) || now() >= deadline) throw cause;
    }
    if (!waited) onWaiting?.();
    await wait();
  }
}
