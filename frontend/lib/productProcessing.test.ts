import { afterEach, describe, expect, it, vi } from "vitest";
import { detectProductSubjects, prepareSupportingImage, removeProductBackground, validateImageUpload } from "./productProcessing";

const file = new File(["sample"], "sample.jpg", { type: "image/jpeg" });

afterEach(() => vi.unstubAllGlobals());

describe("product background processing client", () => {
  it("sends one file and accepts a PNG", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }), {
      headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await removeProductBackground(file);
    expect(result.size).toBe(3);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/images/remove-background");
    expect(options.method).toBe("POST");
    expect(options.body.get("file")).toBe(file);
  });

  it("surfaces a backend validation error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "未识别到可用的前景区域。" }), {
      status: 422, headers: { "content-type": "application/json" },
    })));
    await expect(removeProductBackground(file)).rejects.toThrow("未识别到可用的前景区域。");
  });

  it("reports when the local backend is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(removeProductBackground(file)).rejects.toThrow("图像处理服务不可用");
  });
});

describe("supporting image modes", () => {
  it("bypasses the backend and preserves the original file when disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await prepareSupportingImage(file, false)).toBe(file);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the existing endpoint and returns a PNG when enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }), {
      headers: { "content-type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await prepareSupportingImage(file, true);
    expect(result.type).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/images/remove-background");
  });

  it("shares file type and size validation", () => {
    expect(() => validateImageUpload(new File(["x"], "bad.gif", { type: "image/gif" }))).toThrow("仅支持");
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
    expect(() => validateImageUpload(oversized)).toThrow("10 MB");
  });

  it("does not silently fall back to the original after processing fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(prepareSupportingImage(file, true)).rejects.toThrow("图像处理服务不可用");
  });
});

describe("subject processing client", () => {
  it("uses the subject endpoint and accepts whole-image fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      whole: { pngBase64: "cG5n", width: 10, height: 10 }, candidates: [], warning: "fallback",
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await detectProductSubjects(file);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/images/detect-subjects");
    expect(result.warning).toBe("fallback");
  });
});
