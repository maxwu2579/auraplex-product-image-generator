import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "./pngCodec";

// Fixtures written by Pillow (the backend image library), so decoding is checked against an independent encoder.
const PILLOW = {
  // 5×3 RGBA with gAMA + sRGB chunks; includes hidden RGB under alpha 0 and alpha 1, 2, 3, 17, 127, 128, 254.
  rgba: "iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAYAAABbNsX4AAAABGdBTUEAALGPC/xhBQAAAAFzUkdCAK7OHOkAAABKSURBVHicAT8AwP8B/wAA/w0iOAG8QvoBklD7fq1GUwEA/////gAAAAJ7LUPI8BBjQAECAwMAIUJj//qAAxFQUFAACWPH5oBAIFr20hb15uBocwAAAABJRU5ErkJggg==",
  // 37×23 RGBA gradient with a transparent left band and a semi-transparent ramp (see gradientPixel).
  gradient: "iVBORw0KGgoAAAANSUhEUgAAACUAAAAXCAYAAACMLIalAAAA5klEQVR4nO2WwUoDQRBEa9MbnmEJQZogEkQkSBARERERERER//97CkavogfRbNwB91CXvvSjumqYRnoTjUVYTC1wMnPSOZk7WTjZd5JOlk4OnBw6WTk5cnLs5MR7rC1OLTYWZxbnFhcWlxZXFtcWNxa3FncW9xYPFo8WTxbPFi8Wr1YbXVE0RRFFMS0RlIhZieh+JPWpKqEmnwbxC01qhNIIFaNTpYf2rf5Zptot3ynV6JRGqBjQqbb3TG3+GmpZm1P5ZdZsu5wdtE81tk/DnW9RG9R8N07RW9C7b6DWw2eq9y/wR70Dli6CSym0SMcAAAAASUVORK5CYII=",
  palette: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAMAAABIdo1RAAADAFBMVEX/AAAA/wAAAP8KFB4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyEzIaAAAAA3RSTlP/gAB/bWh4AAAAEklEQVR4nGNgYGRiZmBmYmQAAABGAA1ecouHAAAAAElFTkSuQmCC",
  palette2bit: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACAgMAAAACxpXwAAAADFBMVEX/AAAA/wAAAP8KFB4iiCkEAAAAA3RSTlP/gAB/bWh4AAAADElEQVR4nGOQZngCAAE5AQBFZJGbAAAAAElFTkSuQmCC",
  gray: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAAAAAA+i0toAAAADElEQVR4nGNgaPgPAAIDAYAkYfWXAAAAAElFTkSuQmCC",
  grayAlpha: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR4nGPgYjjhCwACCgEgW0czmAAAAABJRU5ErkJggg==",
  rgb: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkZGJmZmZmYOfg/PX7DwAHCQMausmz/gAAAABJRU5ErkJggg==",
  gray16: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACEAAAAAAHTY67AAAAEklEQVR4nGNgYGB+wTDH4f9/AAu8A8aHkthXAAAAAElFTkSuQmCC",
};

const RGBA_PIXELS = [
  255, 0, 0, 255, 12, 34, 56, 0, 200, 100, 50, 1, 90, 180, 45, 127, 7, 250, 128, 128,
  255, 255, 255, 254, 0, 0, 0, 2, 123, 45, 67, 200, 240, 16, 99, 64, 1, 2, 3, 3,
  33, 66, 99, 255, 250, 128, 3, 17, 80, 80, 80, 0, 9, 99, 199, 230, 128, 64, 32, 90,
];

function gradientPixel(x: number, y: number): number[] {
  const alpha = x < 3 ? 0 : Math.min(255, (x - 3) * 19 + y * 3);
  return [(x * 7 + y * 3) % 256, (x * x + y * 11) % 256, (255 - x * 5 - y * 2) % 256, alpha];
}

const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
/** Byte-exact comparison; element-wise toEqual is far too slow for multi-megabyte buffers. */
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

function randomRgba(width: number, height: number, seed: number): Uint8Array<ArrayBuffer> {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index++) data[index] = next();
  // Include every alpha edge case, with non-zero RGB hidden under alpha 0.
  [0, 1, 2, 127, 128, 254, 255].forEach((alpha, index) => { data[index * 4 + 3] = alpha; });
  return data;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function buildPng(width: number, height: number, colorType: number, scanlines: Uint8Array, bitDepth = 8, interlace = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([bitDepth, colorType, 0, 0, interlace], 8);
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", new Uint8Array()),
  ]));
}

const referencePaeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Independent forward filter used to build decoder fixtures with chosen filter types. */
function filterScanlines(pixels: Uint8Array, width: number, height: number, types: number[]): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const type = types[y % types.length];
    out[y * (stride + 1)] = type;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? pixels[y * stride + i - 4] : 0;
      const b = y ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y ? pixels[(y - 1) * stride + i - 4] : 0;
      const predictor = [0, a, b, (a + b) >> 1, referencePaeth(a, b, c)][type];
      out[y * (stride + 1) + 1 + i] = (pixels[y * stride + i] - predictor) & 0xff;
    }
  }
  return out;
}

interface ParsedChunk { type: string; data: Uint8Array }

function parseChunks(png: Uint8Array): ParsedChunk[] {
  const view = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const chunks: ParsedChunk[] = [];
  for (let offset = 8; offset < view.length;) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(view.readUInt32BE(offset + 8 + length)).toBe(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

/** Decodes an RGBA PNG with Node's zlib and a separately written unfilter, to check the encoder independently. */
function referenceDecodeRgba(png: Uint8Array) {
  const chunks = parseChunks(png);
  const header = Buffer.from(chunks[0].data);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    expect(type).toBeLessThanOrEqual(4);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y ? out[(y - 1) * stride + i - 4] : 0;
      const predictor = [0, a, b, (a + b) >> 1, referencePaeth(a, b, c)][type];
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predictor) & 0xff;
    }
  }
  return { width, height, bitDepth: header[8], colorType: header[9], interlace: header[12], data: out };
}

function withPatchedHeader(png: Uint8Array, index: number, value: number): Uint8Array {
  const copy = png.slice();
  copy[16 + index] = value;
  Buffer.from(copy.buffer).writeUInt32BE(crc32(Buffer.from(copy.subarray(12, 29))), 29);
  return copy;
}

describe("PNG decoding", () => {
  it("reads Pillow RGBA samples exactly, including RGB hidden under alpha 0 and low alpha values", async () => {
    const decoded = await decodePng(fromBase64(PILLOW.rgba));
    expect([decoded.width, decoded.height]).toEqual([5, 3]);
    expect(Array.from(decoded.data)).toEqual(RGBA_PIXELS);
    expect(decoded.colorChunks.map((chunk) => chunk.type)).toEqual(["gAMA", "sRGB"]);
  });

  it("reads a Pillow gradient with a semi-transparent edge sample for sample", async () => {
    const decoded = await decodePng(fromBase64(PILLOW.gradient));
    const expected: number[] = [];
    for (let y = 0; y < 23; y++) for (let x = 0; x < 37; x++) expected.push(...gradientPixel(x, y));
    expect([decoded.width, decoded.height]).toEqual([37, 23]);
    expect(Array.from(decoded.data)).toEqual(expected);
  });

  it("expands 8-bit palette, grey, grey + alpha and RGB images to straight RGBA", async () => {
    expect(Array.from((await decodePng(fromBase64(PILLOW.palette))).data)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 10, 20, 30, 255, 0, 0, 255, 0, 0, 255, 0, 128, 255, 0, 0, 255,
    ]);
    expect(Array.from((await decodePng(fromBase64(PILLOW.gray))).data)).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
    expect(Array.from((await decodePng(fromBase64(PILLOW.grayAlpha))).data)).toEqual([10, 10, 10, 0, 200, 200, 200, 77]);
    expect(Array.from((await decodePng(fromBase64(PILLOW.rgb))).data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 250, 251, 252, 255]);
  });

  it.each([0, 1, 2, 3, 4])("reverses scanline filter type %i", async (type) => {
    const pixels = randomRgba(9, 5, 11 + type);
    const decoded = await decodePng(buildPng(9, 5, 6, filterScanlines(pixels, 9, 5, [type])));
    expect(decoded.data).toEqual(pixels);
  });

  it("reverses mixed filter types across rows", async () => {
    const pixels = randomRgba(13, 10, 5);
    const decoded = await decodePng(buildPng(13, 10, 6, filterScanlines(pixels, 13, 10, [4, 0, 3, 1, 2])));
    expect(decoded.data).toEqual(pixels);
  });

  it("rejects unsupported or damaged PNGs with clear errors", async () => {
    const valid = fromBase64(PILLOW.rgba);
    await expect(decodePng(fromBase64(PILLOW.gray16))).rejects.toThrow("仅支持 8 位 PNG");
    await expect(decodePng(fromBase64(PILLOW.palette2bit))).rejects.toThrow("仅支持 8 位 PNG");
    await expect(decodePng(withPatchedHeader(valid, 12, 1))).rejects.toThrow("隔行扫描");
    const damaged = valid.slice();
    damaged[40] ^= 0xff;
    await expect(decodePng(damaged)).rejects.toThrow("校验失败");
    await expect(decodePng(valid.slice(0, valid.length - 20))).rejects.toThrow("不完整");
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow("不是有效的 PNG");
    await expect(decodePng(valid, 14)).rejects.toThrow("像素过多");
    const short = filterScanlines(randomRgba(4, 3, 9), 4, 3, [0]).subarray(0, 10);
    await expect(decodePng(buildPng(4, 3, 6, short))).rejects.toThrow("不完整");
  });
});

describe("PNG encoding", () => {
  it("round-trips every RGBA sample of a non-square image, including semi-transparent and hidden RGB", async () => {
    const pixels = randomRgba(61, 23, 42);
    const png = await encodePng({ width: 61, height: 23, data: pixels });
    const decoded = await decodePng(png);
    expect([decoded.width, decoded.height]).toEqual([61, 23]);
    expect(decoded.data).toEqual(pixels);
  });

  it("writes a standard 8-bit RGBA PNG that an independent zlib + unfilter decodes identically", async () => {
    const pixels = randomRgba(40, 17, 7);
    const reference = referenceDecodeRgba(await encodePng({ width: 40, height: 17, data: pixels }));
    expect([reference.width, reference.height, reference.bitDepth, reference.colorType, reference.interlace]).toEqual([40, 17, 8, 6, 0]);
    expect(reference.data).toEqual(pixels);
  });

  it("re-encodes Pillow output losslessly and keeps its colour chunks before the image data", async () => {
    const source = await decodePng(fromBase64(PILLOW.rgba));
    const png = await encodePng(source, source.colorChunks);
    expect(parseChunks(png).map((chunk) => chunk.type)).toEqual(["IHDR", "gAMA", "sRGB", "IDAT", "IEND"]);
    const again = await decodePng(png);
    expect(Array.from(again.data)).toEqual(RGBA_PIXELS);
    expect(again.colorChunks).toEqual(source.colorChunks);
  });

  it("handles images larger than one encoder batch and one IDAT chunk", async () => {
    const width = 1500;
    const height = 800;
    const pixels = randomRgba(width, height, 3);
    const png = await encodePng({ width, height, data: pixels });
    expect(parseChunks(png).filter((chunk) => chunk.type === "IDAT").length).toBeGreaterThan(1);
    const decoded = await decodePng(png);
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    expect(sameBytes(decoded.data, pixels)).toBe(true);
  });

  it("refuses inconsistent pixel buffers", async () => {
    await expect(encodePng({ width: 2, height: 2, data: new Uint8Array(15) })).rejects.toThrow("不一致");
    await expect(encodePng({ width: 0, height: 2, data: new Uint8Array(0) })).rejects.toThrow("尺寸无效");
  });
});
