/**
 * Lossless 8-bit PNG decoding and RGBA PNG encoding for Cleanup.
 *
 * Canvas 2D keeps pixels with premultiplied alpha, so drawImage → getImageData →
 * toBlob round trips change the RGB of semi-transparent pixels. Cleanup may only
 * change alpha, so it reads and writes the exact PNG samples itself, using the
 * platform zlib streams (DecompressionStream / CompressionStream).
 */

export interface RgbaPixels {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array<ArrayBuffer>;
}

export interface PngChunk {
  type: string;
  data: Uint8Array<ArrayBuffer>;
}

export interface DecodedPng extends RgbaPixels {
  /** Colour-interpretation chunks, copied into encoded output so colours display unchanged. */
  colorChunks: PngChunk[];
}

export class PngFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngFormatError";
  }
}

interface PngHeader {
  width: number;
  height: number;
  colorType: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOR_CHUNK_TYPES = new Set(["iCCP", "sRGB", "gAMA", "cHRM"]);
/** Samples per pixel for the supported 8-bit colour types. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const IDAT_CHUNK_BYTES = 1 << 20;
const ENCODE_BATCH_BYTES = 1 << 22;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let index = start; index < end; index++) c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function readHeader(data: Uint8Array, maxPixels: number): PngHeader {
  if (data.length !== 13) throw new PngFormatError("PNG 文件头无效。");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw new PngFormatError("PNG 图片尺寸无效。");
  if (width * height > maxPixels) {
    throw new PngFormatError(`图片像素过多（${width} × ${height}），超出 ${maxPixels.toLocaleString("en-US")} 像素上限。`);
  }
  if (bitDepth !== 8 || !(colorType in CHANNELS)) throw new PngFormatError("仅支持 8 位 PNG。");
  if (compression !== 0 || filter !== 0) throw new PngFormatError("PNG 压缩方式无效。");
  if (interlace !== 0) throw new PngFormatError("不支持隔行扫描（interlaced）PNG。");
  return { width, height, colorType };
}

function unfilter(type: number, line: Uint8Array, prior: Uint8Array, bpp: number): void {
  const length = line.length;
  if (type === 1) {
    for (let i = bpp; i < length; i++) line[i] += line[i - bpp];
  } else if (type === 2) {
    for (let i = 0; i < length; i++) line[i] += prior[i];
  } else if (type === 3) {
    for (let i = 0; i < length; i++) line[i] += ((i >= bpp ? line[i - bpp] : 0) + prior[i]) >> 1;
  } else if (type === 4) {
    for (let i = 0; i < length; i++) {
      line[i] += i >= bpp ? paeth(line[i - bpp], prior[i], prior[i - bpp]) : prior[i];
    }
  }
}

/** Transparent sample value from tRNS for grey (one value) or truecolour (three values) images. */
function transparentKey(transparency: Uint8Array | null, samples: number): number[] | null {
  if (!transparency || transparency.length < samples * 2) return null;
  return Array.from({ length: samples }, (_, index) => (transparency[index * 2] << 8) | transparency[index * 2 + 1]);
}

function rowWriter(header: PngHeader, palette: Uint8Array | null, transparency: Uint8Array | null, target: Uint8Array) {
  const { width, colorType } = header;
  const key = colorType === 0 ? transparentKey(transparency, 1) : colorType === 2 ? transparentKey(transparency, 3) : null;
  return (y: number, line: Uint8Array) => {
    let out = y * width * 4;
    if (colorType === 6) {
      target.set(line, out);
      return;
    }
    for (let x = 0; x < width; x++, out += 4) {
      if (colorType === 2) {
        const r = line[x * 3], g = line[x * 3 + 1], b = line[x * 3 + 2];
        target[out] = r; target[out + 1] = g; target[out + 2] = b;
        target[out + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = line[colorType === 0 ? x : x * 2];
        target[out] = gray; target[out + 1] = gray; target[out + 2] = gray;
        target[out + 3] = colorType === 4 ? line[x * 2 + 1] : key && gray === key[0] ? 0 : 255;
      } else {
        const index = line[x];
        if (!palette || index * 3 + 2 >= palette.length) throw new PngFormatError("PNG 调色板索引无效。");
        target[out] = palette[index * 3]; target[out + 1] = palette[index * 3 + 1]; target[out + 2] = palette[index * 3 + 2];
        target[out + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
  };
}

async function readScanlines(chunks: Uint8Array<ArrayBuffer>[], header: PngHeader, onRow: (y: number, line: Uint8Array) => void): Promise<void> {
  const bpp = CHANNELS[header.colorType];
  const stride = header.width * bpp;
  let prior = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  let filterType = -1;
  let filled = 0;
  let y = 0;
  const reader = new Blob(chunks).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let index = 0; index < value.length;) {
        if (y === header.height) throw new PngFormatError("PNG 图像数据超出图片尺寸。");
        if (filterType < 0) {
          filterType = value[index++];
          if (filterType > 4) throw new PngFormatError("PNG 扫描行过滤类型无效。");
          continue;
        }
        const count = Math.min(stride - filled, value.length - index);
        line.set(value.subarray(index, index + count), filled);
        filled += count;
        index += count;
        if (filled === stride) {
          unfilter(filterType, line, prior, bpp);
          onRow(y, line);
          [prior, line] = [line, prior];
          filterType = -1;
          filled = 0;
          y++;
        }
      }
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    if (cause instanceof PngFormatError || cause instanceof RangeError) throw cause;
    throw new PngFormatError("PNG 图像数据损坏。");
  }
  if (y !== header.height || filterType >= 0 || filled) throw new PngFormatError("PNG 图像数据不完整。");
}

/**
 * Decodes an 8-bit, non-interlaced PNG to exact straight-alpha RGBA samples.
 * Every chunk CRC is verified; unsupported variants are rejected rather than approximated.
 */
export async function decodePng(bytes: Uint8Array, maxPixels = Number.POSITIVE_INFINITY): Promise<DecodedPng> {
  if (bytes.length < SIGNATURE.length + 12 || SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new PngFormatError("不是有效的 PNG 图片。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const imageData: Uint8Array<ArrayBuffer>[] = [];
  const colorChunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  for (let ended = false; !ended;) {
    if (offset + 12 > bytes.length) throw new PngFormatError("PNG 数据不完整。");
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (length > 0x7fffffff || end + 4 > bytes.length) throw new PngFormatError("PNG 数据不完整。");
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (crc32(bytes, offset + 4, end) !== view.getUint32(end)) throw new PngFormatError("PNG 数据校验失败。");
    const data = bytes.slice(offset + 8, end);
    offset = end + 4;
    if (!header && type !== "IHDR") throw new PngFormatError("PNG 缺少文件头。");
    if (type === "IHDR") header = readHeader(data, maxPixels);
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") imageData.push(data);
    else if (type === "IEND") ended = true;
    else if (COLOR_CHUNK_TYPES.has(type)) colorChunks.push({ type, data });
    else if (type.charCodeAt(0) < 97) throw new PngFormatError(`不支持的 PNG 数据块：${type}。`);
  }
  if (!header || !imageData.length) throw new PngFormatError("PNG 缺少图像数据。");
  if (header.colorType === 3 && (!palette || !palette.length || palette.length % 3)) throw new PngFormatError("PNG 调色板无效。");
  const data = new Uint8Array(header.width * header.height * 4);
  await readScanlines(imageData, header, rowWriter(header, palette, transparency, data));
  return { width: header.width, height: header.height, data, colorChunks };
}

const magnitude = (value: number) => value < 128 ? value : 256 - value;

/** Filters one RGBA row, choosing the filter with the smallest absolute sum (the libpng heuristic). */
function filterRow(data: Uint8Array, rowStart: number, priorStart: number, stride: number, out: Uint8Array, outStart: number): void {
  let none = 0, sub = 0, up = 0, average = 0, paethSum = 0;
  for (let i = 0; i < stride; i++) {
    const x = data[rowStart + i];
    const a = i >= 4 ? data[rowStart + i - 4] : 0;
    const b = priorStart >= 0 ? data[priorStart + i] : 0;
    const c = i >= 4 && priorStart >= 0 ? data[priorStart + i - 4] : 0;
    none += magnitude(x);
    sub += magnitude((x - a) & 0xff);
    up += magnitude((x - b) & 0xff);
    average += magnitude((x - ((a + b) >> 1)) & 0xff);
    paethSum += magnitude((x - paeth(a, b, c)) & 0xff);
  }
  const sums = [none, sub, up, average, paethSum];
  const type = sums.indexOf(Math.min(...sums));
  out[outStart] = type;
  for (let i = 0; i < stride; i++) {
    const x = data[rowStart + i];
    const a = i >= 4 ? data[rowStart + i - 4] : 0;
    const b = priorStart >= 0 ? data[priorStart + i] : 0;
    const c = i >= 4 && priorStart >= 0 ? data[priorStart + i - 4] : 0;
    const predictor = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[outStart + 1 + i] = x - predictor;
  }
}

async function deflateScanlines(data: Uint8Array, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  const stride = width * 4;
  const stream = new CompressionStream("deflate");
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  try {
    const rowsPerBatch = Math.max(1, Math.floor(ENCODE_BATCH_BYTES / (stride + 1)));
    for (let y = 0; y < height; y += rowsPerBatch) {
      const rows = Math.min(rowsPerBatch, height - y);
      const batch = new Uint8Array(rows * (stride + 1));
      for (let row = 0; row < rows; row++) {
        filterRow(data, (y + row) * stride, y + row > 0 ? (y + row - 1) * stride : -1, stride, batch, row * (stride + 1));
      }
      await writer.write(batch);
    }
    await writer.close();
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined);
    await output.catch(() => undefined);
    throw cause;
  }
  return new Uint8Array(await output);
}

/**
 * Encodes straight-alpha RGBA pixels as an 8-bit RGBA PNG without altering any sample.
 * Colour chunks from the decoded source are written before the image data.
 */
export async function encodePng(image: RgbaPixels, colorChunks: readonly PngChunk[] = []): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new PngFormatError("图片尺寸无效。");
  }
  if (data.length !== width * height * 4) throw new PngFormatError("像素数据与图片尺寸不一致。");
  const compressed = await deflateScanlines(data, width, height);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks: PngChunk[] = [{ type: "IHDR", data: header }, ...colorChunks];
  for (let start = 0; start < compressed.length; start += IDAT_CHUNK_BYTES) {
    chunks.push({ type: "IDAT", data: compressed.subarray(start, start + IDAT_CHUNK_BYTES) });
  }
  chunks.push({ type: "IEND", data: new Uint8Array(0) });
  const png = new Uint8Array(SIGNATURE.length + chunks.reduce((total, chunk) => total + 12 + chunk.data.length, 0));
  const view = new DataView(png.buffer);
  png.set(SIGNATURE);
  let offset = SIGNATURE.length;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.length);
    for (let index = 0; index < 4; index++) png[offset + 4 + index] = chunk.type.charCodeAt(index);
    png.set(chunk.data, offset + 8);
    const end = offset + 8 + chunk.data.length;
    view.setUint32(end, crc32(png, offset + 4, end));
    offset = end + 4;
  }
  return png;
}
