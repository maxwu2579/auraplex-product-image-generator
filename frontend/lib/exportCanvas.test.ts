import { describe, expect, it, vi } from "vitest";
import type Konva from "konva";
import { captureStage, captureWhenReady, ExportNotReadyError, exportFilename, PRODUCT_NODE_NAME } from "./exportCanvas";

function fakeStage(imageCount = 1, fail = false) {
  let visible = true;
  const transformer = {
    visible: vi.fn((next?: boolean) => {
      if (next !== undefined) visible = next;
      return visible;
    }),
    hide: vi.fn(() => { visible = false; }),
  };
  const stage = {
    find: vi.fn((selector: string) => selector === "Image"
      ? Array.from({ length: imageCount }, () => ({ image: () => ({}) }))
      : [transformer]),
    width: () => 680,
    draw: vi.fn(),
    toDataURL: vi.fn(() => {
      if (fail) throw new Error("Canvas blocked");
      return "data:image/png;base64,AA==";
    }),
  };
  return { stage: stage as unknown as Konva.Stage, transformer, raw: stage };
}

/** Stage whose product image nodes carry productId / contentUrl attrs like CanvasPreview's. */
function productStage(products: [id: string, url: string, loaded?: boolean][]) {
  const nodes = products.map(([id, url, loaded = true]) => ({
    getAttr: (key: string) => key === "productId" ? id : key === "contentUrl" ? url : undefined,
    image: () => loaded ? {} : undefined,
  }));
  const stage = {
    find: vi.fn((selector: string) => selector === "Image" || selector === `.${PRODUCT_NODE_NAME}` ? nodes : []),
    width: () => 680,
    draw: vi.fn(),
    toDataURL: vi.fn(() => "data:image/png;base64,AA=="),
  };
  return { stage: stage as unknown as Konva.Stage, raw: stage };
}

describe("canvas export", () => {
  it("uses the logical 1000-pixel resolution and hides editing handles", () => {
    const { stage, raw, transformer } = fakeStage(2);
    expect(captureStage(stage, "png", 2)).toContain("data:image/png");
    expect(raw.toDataURL).toHaveBeenCalledWith({ pixelRatio: 1000 / 680, mimeType: "image/png", quality: undefined });
    expect(transformer.hide).toHaveBeenCalledOnce();
    expect(transformer.visible()).toBe(true);
  });

  it("uses high-quality JPEG and restores handles after a capture error", () => {
    const success = fakeStage();
    captureStage(success.stage, "jpg", 1);
    expect(success.raw.toDataURL).toHaveBeenCalledWith({ pixelRatio: 1000 / 680, mimeType: "image/jpeg", quality: 0.94 });
    const failed = fakeStage(1, true);
    expect(() => captureStage(failed.stage, "png", 1)).toThrow("Canvas blocked");
    expect(failed.transformer.visible()).toBe(true);
  });

  it("refuses to export before every expected image is rendered", () => {
    const { stage, raw } = fakeStage(1);
    expect(() => captureStage(stage, "png", 2)).toThrow("图片仍在加载");
    expect(raw.toDataURL).not.toHaveBeenCalled();
  });

  it("refuses to export when the image count matches but a product still shows an older revision", () => {
    const { stage, raw } = productStage([["a", "blob:a-v1"], ["b", "blob:b-v1"]]);
    const expected = [{ id: "a", url: "blob:a-v2", revision: 2 }, { id: "b", url: "blob:b-v1", revision: 0 }];
    expect(() => captureStage(stage, "png", 2, { products: expected })).toThrow(ExportNotReadyError);
    expect(raw.toDataURL).not.toHaveBeenCalled();
  });

  it("exports once every product shows the expected content version", () => {
    const { stage, raw } = productStage([["a", "blob:a-v2"], ["b", "blob:b-v1"]]);
    const expected = [{ id: "a", url: "blob:a-v2", revision: 2 }, { id: "b", url: "blob:b-v1", revision: 0 }];
    expect(captureStage(stage, "png", 2, { products: expected })).toContain("data:image/png");
    expect(raw.toDataURL).toHaveBeenCalledOnce();
  });

  it("refuses to export with a missing, duplicated or still-loading product", () => {
    const expected = [{ id: "a", url: "blob:a", revision: 0 }, { id: "b", url: "blob:b", revision: 0 }];
    expect(() => captureStage(productStage([["a", "blob:a"], ["x", "blob:b"]]).stage, "png", 2, { products: expected })).toThrow(ExportNotReadyError);
    expect(() => captureStage(productStage([["a", "blob:a"], ["a", "blob:a"]]).stage, "png", 2, { products: expected })).toThrow(ExportNotReadyError);
    expect(() => captureStage(productStage([["a", "blob:a"], ["b", "blob:b", false]]).stage, "png", 2, { products: expected })).toThrow(ExportNotReadyError);
  });

  it("reports a content version that failed to load instead of waiting or exporting an older one", () => {
    const { stage, raw } = productStage([["a", "blob:a-v1"]]);
    expect(() => captureStage(stage, "png", 1, { products: [{ id: "a", url: "blob:a-v2", revision: 1 }], failedUrls: new Set(["blob:a-v2"]) }))
      .toThrow("产品图片加载失败");
    expect(raw.toDataURL).not.toHaveBeenCalled();
  });

  it("waits for the expected content to render, then captures", async () => {
    let attempts = 0;
    const onWaiting = vi.fn();
    const result = await captureWhenReady(() => {
      if (++attempts < 3) throw new ExportNotReadyError();
      return "data:image/png;base64,AA==";
    }, { wait: async () => undefined, onWaiting });
    expect(result).toContain("data:image/png");
    expect(attempts).toBe(3);
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("stops waiting at the deadline and does not retry real failures", async () => {
    let clock = 0;
    const stuck = captureWhenReady(() => { throw new ExportNotReadyError(); }, { timeoutMs: 200, now: () => clock, wait: async () => { clock += 50; } });
    await expect(stuck).rejects.toThrow("图片仍在加载");
    const failing = vi.fn(() => { throw new Error("Canvas blocked"); });
    await expect(captureWhenReady(failing, { wait: async () => undefined })).rejects.toThrow("Canvas blocked");
    expect(failing).toHaveBeenCalledOnce();
  });

  it("produces safe, predictable filenames", () => {
    const date = new Date(2026, 8, 24, 9, 5, 3);
    expect(exportFilename("png", date)).toBe("product-image-20260924-090503.png");
    expect(exportFilename("jpg", date)).toBe("product-image-20260924-090503.jpg");
  });
});
