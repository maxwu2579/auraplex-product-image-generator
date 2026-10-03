import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupBrand, normalizeBrand, persistBrand } from "./brandLibrary";

afterEach(() => vi.unstubAllGlobals());

describe("local brand library client", () => {
  it("normalizes exact brand keys without aliases", () => {
    expect(["BMW", "bmw", " BMW "].map(normalizeBrand)).toEqual(["bmw", "bmw", "bmw"]);
    expect(normalizeBrand("Mercedes Benz")).toBe("mercedes-benz");
    expect(normalizeBrand("Mercedes-Benz")).toBe("mercedes-benz");
    expect(() => normalizeBrand("../")).toThrow("有效品牌名称");
  });

  it("treats a missing brand as a normal lookup result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ found: false, key: "bmw" })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupBrand(" BMW ")).toEqual({ found: false, key: "bmw" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/brands/bmw");
  });

  it("uses explicit POST and PUT with original and processed files", async () => {
    const payload = JSON.stringify({ found: true, key: "bmw", brand: {
      display_name: "BMW", remove_background: true, original_url: "/original", display_url: "/display",
    } });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(payload));
    vi.stubGlobal("fetch", fetchMock);
    const original = new File(["jpg"], "logo.jpg", { type: "image/jpeg" });
    const processed = new File(["png"], "logo.png", { type: "image/png" });
    await persistBrand("BMW", original, processed, true, false);
    await persistBrand("bmw", original, processed, true, true, "BMW");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect((fetchMock.mock.calls[1][1].body as FormData).get("display_name")).toBe("BMW");
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("file")).toBe(original);
    expect(form.get("processed_file")).toBe(processed);
    expect(form.get("remove_background")).toBe("true");
  });
});
