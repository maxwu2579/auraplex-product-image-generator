import { describe, expect, it } from "vitest";
import { canvasImages, chooseCandidate, chooseWhole, defaultSelection, selectedTotal } from "./subjectSelection";
import type { ProductSource } from "./subjectSelection";

const image = (id: string) => ({ id, name: id, url: `blob:${id}`, width: 100, height: 100 });
const source = (id: string, count: number): ProductSource => ({
  id, name: id, file: new File(["x"], `${id}.png`, { type: "image/png" }), status: "ready",
  whole: image(`${id}-whole`), candidates: Array.from({ length: count }, (_, index) => ({ id: `s${index}`, image: image(`${id}-s${index}`), small: false, area: 100 })),
  mode: "subjects", selectedIds: [], confirmed: false, error: "", warning: "",
});

describe("subject confirmation", () => {
  it("defaults to one clear subject and waits for confirmation", () => {
    const ready = defaultSelection(source("a", 1), []);
    expect(ready.selectedIds).toEqual(["s0"]);
    expect(canvasImages([ready])).toEqual([]);
    expect(canvasImages([{ ...ready, confirmed: true }])).toHaveLength(1);
  });

  it("keeps small artifacts visible but unselected", () => {
    const input = source("a", 2);
    input.candidates[1].small = true;
    expect(defaultSelection(input, []).selectedIds).toEqual(["s0"]);
    expect(input.candidates).toHaveLength(2);
  });

  it("makes whole image and individual candidates mutually exclusive", () => {
    const initial = defaultSelection(source("a", 2), []);
    const whole = chooseWhole([initial], "a", true)!;
    expect(whole[0].selectedIds).toEqual([]);
    expect(whole[0].mode).toBe("whole");
    const individual = chooseCandidate(whole, "a", "s1", true)!;
    expect(individual[0].mode).toBe("subjects");
    expect(individual[0].selectedIds).toEqual(["s1"]);
    expect(selectedTotal(individual)).toBe(1);
  });

  it("prevents a sixth final item without silently truncating", () => {
    const first = defaultSelection(source("a", 5), []);
    const second = source("b", 2);
    expect(first.selectedIds).toHaveLength(5);
    expect(defaultSelection(second, [first]).selectedIds).toEqual([]);
    expect(chooseCandidate([first, second], "b", "s0", true)).toBeNull();
  });

  it("removing a source removes its canvas objects", () => {
    const first = { ...defaultSelection(source("a", 2), []), confirmed: true };
    const second = { ...defaultSelection(source("b", 1), [first]), confirmed: true };
    expect(canvasImages([first, second])).toHaveLength(3);
    expect(canvasImages([second])).toHaveLength(1);
  });
});
