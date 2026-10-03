import { describe, expect, it, vi } from "vitest";
import { autoPlaceProducts, getRegions } from "./layout";
import {
  commitContent, createCleanupSession, OwnedObjectUrls, pruneContent, referencedUrls, resolveProduct, resolveProducts, undoLastApply,
} from "./productContent";
import type { ContentChange, ContentImage, ContentUpdate, ProductContentState } from "./productContent";
import { canvasImages, chooseCandidate, chooseWhole, sourceImages } from "./subjectSelection";
import type { ProductSource } from "./subjectSelection";
import type { ImageAsset } from "./types";

vi.mock("./layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./layout")>();
  return { ...actual, autoPlaceProducts: vi.fn(actual.autoPlaceProducts) };
});

const image = (id: string, generation: string, width = 120, height = 80): ImageAsset => ({
  id, name: id, url: `blob:base-${id}-${generation}`, width, height, generation,
});

function source(id: string, generation = "g1", candidates = 2): ProductSource {
  return {
    id, name: id, file: new File(["x"], `${id}.png`, { type: "image/png" }), status: "ready",
    whole: image(`${id}-whole`, generation, 160, 90),
    candidates: Array.from({ length: candidates }, (_, index) => ({ id: `subject-${index + 1}`, image: image(`${id}-subject-${index + 1}`, generation, 100 + index * 10, 70), small: false, area: 100 })),
    mode: "subjects", selectedIds: ["subject-1"], confirmed: true, error: "", warning: "",
  };
}

/** Mirrors EditorClient: Cleanup results are adopted, and released URLs are revoked only when unreferenced. */
class EditorHarness {
  content: ProductContentState = {};
  created = 0;
  readonly revoked: string[] = [];
  readonly urls = new OwnedObjectUrls((url) => this.revoked.push(url));
  constructor(public sources: ProductSource[]) {}

  get products() { return canvasImages(this.sources); }
  product(id: string) { return this.products.find((item) => item.id === id) ?? sourceImages(this.sources).find((item) => item.id === id)!; }
  session(id: string) { return createCleanupSession(++this.created, this.product(id), this.content)!; }
  newImage(width = 120, height = 80): ContentImage { return { url: `blob:cleanup-${++this.created}`, width, height }; }

  private applyChange(change: ContentChange) {
    this.content = change.state;
    this.urls.release(change.released, referencedUrls(change.state));
  }

  commit(id: string, next: ContentImage | null, session = this.session(id)): ContentUpdate {
    const update = commitContent(this.content, sourceImages(this.sources), { id, generation: session.generation, revision: session.revision }, next);
    if (update.ok) {
      if (next) this.urls.adopt(next.url);
      this.applyChange(update.change);
    }
    return update;
  }

  undo(id: string): ContentUpdate {
    const product = this.product(id);
    const revision = resolveProduct(product, this.content).revision;
    const update = undoLastApply(this.content, sourceImages(this.sources), { id, generation: product.generation!, revision });
    if (update.ok) this.applyChange(update.change);
    return update;
  }

  setSources(next: ProductSource[]) {
    this.sources = next;
    const change = pruneContent(this.content, sourceImages(next));
    if (change) this.applyChange(change);
  }

  resolved(id: string) { return resolveProduct(this.product(id), this.content); }
}

describe("product content resolution", () => {
  it("uses the processed base when no Cleanup exists", () => {
    const editor = new EditorHarness([source("a")]);
    expect(editor.resolved("a-subject-1")).toMatchObject({ url: "blob:base-a-subject-1-g1", revision: 0, width: 100, height: 70 });
  });

  it("keeps the override when the product list is re-derived from sources", () => {
    const editor = new EditorHarness([source("a")]);
    const cleaned = editor.newImage(100, 70);
    expect(editor.commit("a-subject-1", cleaned).ok).toBe(true);
    // Selecting another candidate re-derives sources and canvas products; the override follows the identity.
    editor.setSources(chooseCandidate(editor.sources, "a", "subject-2", true)!.map((item) => ({ ...item, confirmed: true })));
    expect(resolveProducts(editor.products, editor.content).map((item) => [item.id, item.url])).toEqual([
      ["a-subject-1", cleaned.url], ["a-subject-2", "blob:base-a-subject-2-g1"],
    ]);
  });

  it("keeps Cleanup for a subject that is temporarily not on the canvas", () => {
    const editor = new EditorHarness([source("a")]);
    const cleaned = editor.newImage(100, 70);
    editor.commit("a-subject-1", cleaned);
    editor.setSources(chooseWhole(editor.sources, "a", true)!);
    expect(editor.products.some((item) => item.id === "a-subject-1")).toBe(false);
    expect(editor.revoked).toEqual([]);
    editor.setSources(chooseCandidate(editor.sources, "a", "subject-1", true)!.map((item) => ({ ...item, confirmed: true })));
    expect(editor.resolved("a-subject-1").url).toBe(cleaned.url);
  });

  it("gives the whole image and each candidate an independent identity", () => {
    const editor = new EditorHarness([source("a")]);
    editor.commit("a-whole", editor.newImage(160, 90));
    expect(editor.resolved("a-subject-1").revision).toBe(0);
    expect(editor.resolved("a-subject-2").revision).toBe(0);
    expect(editor.resolved("a-whole").revision).toBe(1);
  });

  it("never applies an old Cleanup to a reprocessed image with the same asset id", () => {
    const editor = new EditorHarness([source("a")]);
    const first = editor.newImage(100, 70);
    const session = editor.session("a-subject-1");
    editor.commit("a-subject-1", first, session);
    editor.setSources([source("a", "g2")]);
    expect(editor.resolved("a-subject-1")).toMatchObject({ url: "blob:base-a-subject-1-g2", revision: 0 });
    expect(editor.revoked).toEqual([first.url]);
    expect(editor.urls.size).toBe(0);
    // A result prepared against the old generation cannot be committed to the new image.
    expect(editor.commit("a-subject-1", editor.newImage(100, 70), session)).toEqual({ ok: false, reason: "missing" });
    expect(editor.undo("a-subject-1")).toEqual({ ok: false, reason: "no-undo" });
  });

  it("ignores a record from another generation even before it is pruned", () => {
    const record = { generation: "g1", revision: 3, applied: { url: "blob:old", width: 100, height: 70 }, undo: null };
    expect(resolveProduct(image("a-subject-1", "g2", 100, 70), { "a-subject-1": record }).url).toBe("blob:base-a-subject-1-g2");
  });
});

describe("Apply, Reset and Undo Last Apply", () => {
  it("starts the next session from the applied content and resets to the processed base", () => {
    const editor = new EditorHarness([source("a")]);
    const cleaned = editor.newImage(100, 70);
    editor.commit("a-subject-1", cleaned);
    const reopened = editor.session("a-subject-1");
    expect(reopened.entry).toEqual(cleaned);
    expect(reopened.base).toEqual({ url: "blob:base-a-subject-1-g1", width: 100, height: 70 });
    expect(reopened.revision).toBe(1);
  });

  it("session size comes from the product image, never from its canvas placement", () => {
    const editor = new EditorHarness([source("a")]);
    const placements = autoPlaceProducts(editor.products, getRegions("brand-only", "text-only").middle);
    expect(placements[0].width).not.toBe(100);
    expect(editor.session("a-subject-1").base).toMatchObject({ width: 100, height: 70 });
  });

  it("keeps one level of Undo Last Apply and consumes it", () => {
    const editor = new EditorHarness([source("a")]);
    const first = editor.newImage(100, 70);
    const second = editor.newImage(100, 70);
    editor.commit("a-subject-1", first);
    editor.commit("a-subject-1", second);
    expect(editor.undo("a-subject-1").ok).toBe(true);
    expect(editor.resolved("a-subject-1")).toMatchObject({ url: first.url, revision: 3 });
    expect(editor.undo("a-subject-1")).toEqual({ ok: false, reason: "no-undo" });
    expect(editor.resolved("a-subject-1").url).toBe(first.url);
  });

  it("restores the processed base when undoing the first Cleanup", () => {
    const editor = new EditorHarness([source("a")]);
    editor.commit("a-subject-1", editor.newImage(100, 70));
    editor.undo("a-subject-1");
    expect(editor.resolved("a-subject-1")).toMatchObject({ url: "blob:base-a-subject-1-g1", revision: 2 });
  });

  it("commits Reset → Apply as the processed base and undoes it back to the earlier Cleanup", () => {
    const editor = new EditorHarness([source("a")]);
    const cleaned = editor.newImage(100, 70);
    editor.commit("a-subject-1", cleaned);
    expect(editor.commit("a-subject-1", null).ok).toBe(true);
    expect(editor.resolved("a-subject-1").url).toBe("blob:base-a-subject-1-g1");
    expect(editor.revoked).toEqual([]);
    editor.undo("a-subject-1");
    expect(editor.resolved("a-subject-1").url).toBe(cleaned.url);
  });

  it("does not create a version or overwrite the undo target for an unchanged Apply", () => {
    const editor = new EditorHarness([source("a")]);
    const first = editor.newImage(100, 70);
    editor.commit("a-subject-1", first);
    const before = editor.content;
    expect(editor.commit("a-subject-1", first)).toEqual({ ok: false, reason: "unchanged" });
    expect(editor.content).toBe(before);
    // Reset → Apply without an override is also no change.
    const other = new EditorHarness([source("b")]);
    expect(other.commit("b-subject-1", null)).toEqual({ ok: false, reason: "unchanged" });
    expect(other.content).toEqual({});
  });

  it("leaves applied content untouched when a session is only opened and cancelled", () => {
    const editor = new EditorHarness([source("a")]);
    editor.commit("a-subject-1", editor.newImage(100, 70));
    const before = editor.content;
    editor.session("a-subject-1");
    editor.session("a-subject-1");
    expect(editor.content).toBe(before);
  });

  it("refuses results whose size differs from the processed image", () => {
    const editor = new EditorHarness([source("a")]);
    expect(editor.commit("a-subject-1", editor.newImage(99, 70))).toEqual({ ok: false, reason: "size" });
  });
});

describe("stale results", () => {
  it("rejects a result prepared against an older revision", () => {
    const editor = new EditorHarness([source("a")]);
    const late = editor.session("a-subject-1");
    editor.commit("a-subject-1", editor.newImage(100, 70));
    expect(editor.commit("a-subject-1", editor.newImage(100, 70), late)).toEqual({ ok: false, reason: "stale" });
  });

  it("does not write back to a deleted product", () => {
    const editor = new EditorHarness([source("a"), source("b")]);
    const session = editor.session("a-subject-1");
    editor.setSources([editor.sources[1]]);
    expect(editor.commit("a-subject-1", editor.newImage(100, 70), session)).toEqual({ ok: false, reason: "missing" });
    expect(editor.content).toEqual({});
  });
});

describe("placement and auto-layout", () => {
  it("changes only content: placements, sizes and auto-layout calls stay the same through Apply and Undo", () => {
    const editor = new EditorHarness(["a", "b", "c", "d", "e"].map((id) => source(id)));
    const layout = vi.mocked(autoPlaceProducts);
    const placements = autoPlaceProducts(editor.products, getRegions("brand-only", "text-only").middle);
    const snapshot = structuredClone(placements);
    const calls = layout.mock.calls.length;
    const before = resolveProducts(editor.products, editor.content);
    editor.commit("c-subject-1", editor.newImage(100, 70));
    editor.commit("c-subject-1", null);
    editor.undo("c-subject-1");
    const after = resolveProducts(editor.products, editor.content);
    expect(layout.mock.calls.length).toBe(calls);
    expect(placements).toEqual(snapshot);
    expect(after.map(({ id, width, height }) => ({ id, width, height }))).toEqual(before.map(({ id, width, height }) => ({ id, width, height })));
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
  });
});

describe("1–5 product isolation", () => {
  it("cleaning, undoing and deleting product A never changes B–E", () => {
    const editor = new EditorHarness(["a", "b", "c", "d", "e"].map((id) => source(id)));
    const others = () => resolveProducts(editor.products, editor.content).filter((item) => !item.id.startsWith("a-"));
    const baseline = others();
    const bClean = editor.newImage(100, 70);
    editor.commit("b-subject-1", bClean);
    const withB = others();
    editor.commit("a-subject-1", editor.newImage(100, 70));
    editor.commit("a-subject-1", editor.newImage(100, 70));
    expect(others()).toEqual(withB);
    editor.undo("a-subject-1");
    expect(others()).toEqual(withB);
    editor.setSources(editor.sources.filter((item) => item.id !== "a"));
    expect(others()).toEqual(withB);
    expect(editor.revoked).not.toContain(bClean.url);
    expect(withB.filter((item) => item.id !== "b-subject-1")).toEqual(baseline.filter((item) => item.id !== "b-subject-1"));
  });

  it("follows product identity, not array position, when sources are reordered", () => {
    const editor = new EditorHarness(["a", "b", "c"].map((id) => source(id)));
    const cleaned = editor.newImage(100, 70);
    editor.commit("b-subject-1", cleaned);
    editor.setSources([...editor.sources].reverse());
    const resolved = resolveProducts(editor.products, editor.content);
    expect(resolved.map((item) => item.id)).toEqual(["c-subject-1", "b-subject-1", "a-subject-1"]);
    expect(resolved.find((item) => item.id === "b-subject-1")!.url).toBe(cleaned.url);
    expect(resolved.filter((item) => item.id !== "b-subject-1").every((item) => item.revision === 0)).toBe(true);
  });

  it("keeps separate candidates of one source separate", () => {
    const editor = new EditorHarness([source("a", "g1", 3)]);
    editor.commit("a-subject-2", editor.newImage(110, 70));
    expect(editor.resolved("a-subject-1").revision).toBe(0);
    expect(editor.resolved("a-subject-3").revision).toBe(0);
  });
});

describe("object URL lifecycle", () => {
  it("keeps the undo target alive and releases the version it replaces", () => {
    const editor = new EditorHarness([source("a")]);
    const [v1, v2, v3] = [editor.newImage(100, 70), editor.newImage(100, 70), editor.newImage(100, 70)];
    editor.commit("a-subject-1", v1);
    editor.commit("a-subject-1", v2);
    expect(editor.revoked).toEqual([]);
    editor.commit("a-subject-1", v3);
    expect(editor.revoked).toEqual([v1.url]);
    editor.undo("a-subject-1");
    expect(editor.revoked).toEqual([v1.url, v3.url]);
    expect(editor.urls.size).toBe(1);
  });

  it("never revokes processed-base or foreign URLs, or URLs still referenced", () => {
    const revoked: string[] = [];
    const urls = new OwnedObjectUrls((url) => revoked.push(url));
    urls.adopt("blob:mine");
    urls.release(["blob:base-a", "https://example.test/logo.png", "blob:mine"], new Set(["blob:mine"]));
    expect(revoked).toEqual([]);
    urls.release(["blob:mine"], new Set());
    expect(revoked).toEqual(["blob:mine"]);
    urls.releaseAll();
    expect(revoked).toEqual(["blob:mine"]);
  });

  it("does not accumulate URLs over repeated apply, undo, reset and delete cycles", () => {
    const editor = new EditorHarness(["a", "b"].map((id) => source(id)));
    let adopted = 0;
    for (let cycle = 0; cycle < 50; cycle++) {
      const id = cycle % 2 ? "a-subject-1" : "b-subject-1";
      editor.commit(id, editor.newImage(100, 70));
      adopted++;
      if (cycle % 3 === 0) editor.undo(id);
      if (cycle % 5 === 0) editor.commit(id, null);
      expect(editor.urls.size).toBeLessThanOrEqual(4);
      expect(editor.urls.size + editor.revoked.length).toBe(adopted);
    }
    editor.setSources([]);
    expect(editor.urls.size).toBe(0);
    expect(new Set(editor.revoked).size).toBe(adopted);
    expect(editor.content).toEqual({});
  });
});
