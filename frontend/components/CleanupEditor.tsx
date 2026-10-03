"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { EraseMask, MAX_CLEANUP_PIXELS, planCleanupApply, samePixels, unionRect } from "@/lib/cleanupMask";
import type { CleanupApplyPlan, PixelRect, Point } from "@/lib/cleanupMask";
import {
  backingStoreSize, brushDiameterFromSlider, brushSliderFromDiameter, BRUSH_SLIDER_MAX, clientToImage, defaultBrushDiameter,
  fitImageToView, imageLengthToClient, imageRectToBacking, loadImageElement, maxBrushDiameter, samplingMap, updatePreviewAlpha,
} from "@/lib/cleanupView";
import type { Size } from "@/lib/cleanupView";
import { decodePng, encodePng, PngFormatError } from "@/lib/pngCodec";
import type { PngChunk } from "@/lib/pngCodec";
import type { CleanupResult, CleanupSession, ContentImage } from "@/lib/productContent";

export type CleanupCommitOutcome = { ok: true } | { ok: false; message: string };

interface Props {
  session: CleanupSession;
  onCancel: () => void;
  /** Validates and commits synchronously; the parent closes the editor on success. */
  onApply: (sessionId: number, result: CleanupResult) => CleanupCommitOutcome;
}

/** Decoded pixels of the image a session edits: the entry content, or the processed base after Reset. */
interface WorkingImage {
  url: string;
  pixels: Uint8Array<ArrayBuffer>;
  colorChunks: PngChunk[];
  element: HTMLImageElement;
}

interface Display {
  context: CanvasRenderingContext2D;
  backing: Size;
  base: Uint8ClampedArray;
  preview: ImageData;
  columns: Uint32Array;
  rows: Uint32Array;
}

class CleanupError extends Error {}

function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof RangeError) return "图片过大，浏览器内存不足，无法完成清理。";
  if (cause instanceof PngFormatError) return `无法读取产品图片：${cause.message}`;
  if (cause instanceof CleanupError) return cause.message;
  return fallback;
}

async function loadWorkingImage(content: ContentImage): Promise<WorkingImage> {
  let bytes: Uint8Array;
  try {
    const response = await fetch(content.url);
    if (!response.ok) throw new Error(String(response.status));
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new CleanupError("无法读取产品图片数据。");
  }
  const decoded = await decodePng(bytes, MAX_CLEANUP_PIXELS);
  if (decoded.width !== content.width || decoded.height !== content.height) throw new CleanupError("图片尺寸与处理结果不一致，无法清理。");
  let element: HTMLImageElement;
  try { element = await loadImageElement(content.url); }
  catch { throw new CleanupError("浏览器无法显示这张产品图片。"); }
  return { url: content.url, pixels: decoded.data, colorChunks: decoded.colorChunks, element };
}

export default function CleanupEditor({ session, onCancel, onApply }: Props) {
  const width = session.base.width;
  const height = session.base.height;
  const maxDiameter = maxBrushDiameter({ width, height });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"" | "reset" | "apply">("");
  const [undoDepth, setUndoDepth] = useState(0);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [atProcessedBase, setAtProcessedBase] = useState(session.entry.url === session.base.url);
  const [confirmTransparent, setConfirmTransparent] = useState(false);
  const [diameter, setDiameter] = useState(() => defaultBrushDiameter({ width, height }));
  const [viewport, setViewport] = useState<{ width: number; height: number; ratio: number } | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<WorkingImage | null>(null);
  const workingRef = useRef<WorkingImage | null>(null);
  const maskRef = useRef<EraseMask | null>(null);
  const displayRef = useRef<Display | null>(null);
  const strokeRef = useRef<number | null>(null);
  const pendingRef = useRef<PixelRect | null>(null);
  const frameRef = useRef(0);
  const diameterRef = useRef(diameter);
  const disposedRef = useRef(false);
  /** Set synchronously so a repeated Apply / Reset cannot start before `busy` re-renders. */
  const inFlightRef = useRef(false);

  const interactive = status === "ready" && !busy && !confirmTransparent;
  const css = viewport ? fitImageToView({ width, height }, viewport) : null;
  const backing = css && viewport && css.width > 0 ? backingStoreSize(css, viewport.ratio) : null;

  // Load the session entry: exact PNG samples for output, and a decoded element for display.
  useEffect(() => {
    let cancelled = false;
    disposedRef.current = false;
    loadWorkingImage(session.entry).then((entry) => {
      if (cancelled) return;
      entryRef.current = entry;
      workingRef.current = entry;
      maskRef.current = new EraseMask(session.base.width, session.base.height);
      setStatus("ready");
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setMessage(describeError(cause, "无法读取产品图片，无法开始清理。"));
      setStatus("error");
    });
    return () => {
      cancelled = true;
      disposedRef.current = true;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      entryRef.current = null;
      workingRef.current = null;
      maskRef.current = null;
      displayRef.current = null;
    };
  }, [session]);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let size = { width: 0, height: 0 };
    const update = () => {
      const ratio = window.devicePixelRatio || 1;
      setViewport((current) => current && current.width === size.width && current.height === size.height && current.ratio === ratio ? current : { ...size, ratio });
    };
    const observer = new ResizeObserver(([entry]) => {
      size = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) };
      update();
    });
    observer.observe(element);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);

  function drawPreview(rect: PixelRect) {
    const display = displayRef.current;
    const mask = maskRef.current;
    if (!display || !mask) return;
    const area = imageRectToBacking(rect, { width, height }, display.backing);
    if (!area.width || !area.height) return;
    updatePreviewAlpha(display.preview.data, display.base, display.backing.width, display.columns, display.rows, mask.data, width, area);
    display.context.putImageData(display.preview, 0, 0, area.x, area.y, area.width, area.height);
  }

  // Rebuild the display after load, resize, DPR change or Reset. The backing store only
  // affects what is shown; strokes and output always use W × H source pixels.
  useEffect(() => {
    if (status !== "ready" || !viewport) return;
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const working = workingRef.current;
      const mask = maskRef.current;
      if (!canvas || !working || !mask) return;
      try {
        const size = { width: canvas.width, height: canvas.height };
        const scratch = document.createElement("canvas");
        scratch.width = size.width;
        scratch.height = size.height;
        const context = canvas.getContext("2d");
        const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
        if (!context || !scratchContext) throw new CleanupError("浏览器无法创建清理画布。");
        // Enlarged images are shown with hard pixel edges so the preview matches the pixels a stroke erases.
        scratchContext.imageSmoothingEnabled = size.width < width;
        scratchContext.imageSmoothingQuality = "high";
        scratchContext.drawImage(working.element, 0, 0, size.width, size.height);
        const base = scratchContext.getImageData(0, 0, size.width, size.height).data;
        const display: Display = {
          context, backing: size, base, preview: new ImageData(new Uint8ClampedArray(base), size.width, size.height),
          columns: samplingMap(size.width, width), rows: samplingMap(size.height, height),
        };
        updatePreviewAlpha(display.preview.data, base, size.width, display.columns, display.rows, mask.data, width, { x: 0, y: 0, ...size });
        context.putImageData(display.preview, 0, 0);
        displayRef.current = display;
      } catch (cause) {
        displayRef.current = null;
        setMessage(describeError(cause, "无法读取画布像素，无法显示清理预览。"));
        setStatus("error");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [status, viewport, baseVersion, width, height]);

  function queueDraw(rect: PixelRect | null) {
    if (!rect) return;
    pendingRef.current = unionRect(pendingRef.current, rect);
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) drawPreview(pending);
    });
  }

  function toImage(event: { clientX: number; clientY: number }): Point | null {
    const canvas = canvasRef.current;
    return canvas ? clientToImage(event.clientX, event.clientY, canvas.getBoundingClientRect(), { width, height }) : null;
  }

  function moveCursor(event: { clientX: number; clientY: number }) {
    const cursor = cursorRef.current;
    const view = viewportRef.current;
    const canvas = canvasRef.current;
    if (!cursor || !view || !canvas) return;
    const origin = view.getBoundingClientRect();
    const size = imageLengthToClient(diameterRef.current, canvas.getBoundingClientRect(), { width, height });
    cursor.style.width = `${size}px`;
    cursor.style.height = `${size}px`;
    cursor.style.transform = `translate(${event.clientX - origin.left - size / 2}px, ${event.clientY - origin.top - size / 2}px)`;
    cursor.style.display = "block";
  }

  function hideCursor() {
    if (cursorRef.current) cursorRef.current.style.display = "none";
  }

  function finishStroke() {
    const pointerId = strokeRef.current;
    if (pointerId === null) return;
    strokeRef.current = null;
    const view = viewportRef.current;
    if (view?.hasPointerCapture(pointerId)) view.releasePointerCapture(pointerId);
    const mask = maskRef.current;
    if (mask?.end()) {
      setUndoDepth(mask.undoDepth);
      setHasStrokes(mask.hasStrokes);
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const mask = maskRef.current;
    if (event.button !== 0 || strokeRef.current !== null || !interactive || !mask) return;
    const point = toImage(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    strokeRef.current = event.pointerId;
    setMessage("");
    queueDraw(mask.begin(point, diameterRef.current / 2));
    moveCursor(event);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (interactive) moveCursor(event);
    const mask = maskRef.current;
    if (strokeRef.current !== event.pointerId || !mask) return;
    // Button already released (e.g. outside the window): end the stroke instead of drawing on.
    if ((event.buttons & 1) === 0) { finishStroke(); return; }
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event.nativeEvent]) {
      const point = toImage(sample);
      if (point) queueDraw(mask.extend(point));
    }
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (strokeRef.current === event.pointerId) finishStroke();
    if (event.type === "pointercancel") hideCursor();
  }

  function undoStroke() {
    const mask = maskRef.current;
    if (!mask || !interactive || strokeRef.current !== null || !mask.undo()) return;
    queueDraw({ x: 0, y: 0, width, height });
    setUndoDepth(mask.undoDepth);
    setHasStrokes(mask.hasStrokes);
  }

  async function resetCleanup() {
    const mask = maskRef.current;
    if (!mask || !interactive || inFlightRef.current || strokeRef.current !== null) return;
    setMessage("");
    if (atProcessedBase) {
      mask.clear();
      queueDraw({ x: 0, y: 0, width, height });
      setUndoDepth(0);
      setHasStrokes(false);
      return;
    }
    inFlightRef.current = true;
    setBusy("reset");
    try {
      const base = await loadWorkingImage(session.base);
      if (disposedRef.current) return;
      workingRef.current = base;
      mask.clear();
      setAtProcessedBase(true);
      setUndoDepth(0);
      setHasStrokes(false);
      setBaseVersion((version) => version + 1);
    } catch (cause) {
      if (!disposedRef.current) setMessage(describeError(cause, "无法恢复处理结果；当前编辑内容已保留。"));
    } finally {
      inFlightRef.current = false;
      if (!disposedRef.current) setBusy("");
    }
  }

  async function applyCleanup(confirmed = false) {
    const mask = maskRef.current;
    const working = workingRef.current;
    const entry = entryRef.current;
    if (!mask || !working || !entry || busy || inFlightRef.current || strokeRef.current !== null) return;
    setMessage("");
    let plan: CleanupApplyPlan;
    try {
      plan = planCleanupApply({ entry: entry.pixels, base: working.pixels, baseIsProcessed: atProcessedBase, mask: mask.data });
    } catch (cause) {
      setMessage(describeError(cause, "无法生成清理结果；当前编辑内容已保留。"));
      return;
    }
    if (plan.kind !== "encode") {
      const outcome = onApply(session.id, { kind: plan.kind });
      if (!outcome.ok) setMessage(outcome.message);
      return;
    }
    if (plan.fullyTransparent && !confirmed) {
      setConfirmTransparent(true);
      return;
    }
    setConfirmTransparent(false);
    inFlightRef.current = true;
    setBusy("apply");
    let url: string | null = null;
    try {
      const png = await encodePng({ width, height, data: plan.output }, working.colorChunks);
      if (disposedRef.current) return;
      // Verify the actual PNG before committing: exact samples, W × H, and that the browser can decode it.
      const check = await decodePng(png, MAX_CLEANUP_PIXELS);
      if (check.width !== width || check.height !== height || !samePixels(check.data, plan.output)) throw new CleanupError("生成的 PNG 校验失败，未应用；当前编辑内容已保留。");
      url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
      const element = await loadImageElement(url);
      if (element.naturalWidth !== width || element.naturalHeight !== height) throw new CleanupError("生成的 PNG 尺寸异常，未应用；当前编辑内容已保留。");
      if (disposedRef.current) return;
      const outcome = onApply(session.id, { kind: "image", image: { url, width, height } });
      if (outcome.ok) url = null;
      else setMessage(outcome.message);
    } catch (cause) {
      if (!disposedRef.current) setMessage(describeError(cause, "生成清理结果失败，请重试；当前编辑内容已保留。"));
    } finally {
      if (url) URL.revokeObjectURL(url);
      inFlightRef.current = false;
      if (!disposedRef.current) setBusy("");
    }
  }

  return <div className="cleanup-backdrop">
    <div ref={dialogRef} className="cleanup-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title" aria-describedby="cleanup-warning" tabIndex={-1}>
      <header className="cleanup-header">
        <div>
          <h2 id="cleanup-title">擦除清理</h2>
          <p><span className="cleanup-name" title={session.name}>{session.name}</span> · {width} × {height} px</p>
        </div>
        <button type="button" className="cleanup-close" aria-label="关闭，放弃未应用的清理" onClick={onCancel}>×</button>
      </header>
      <p id="cleanup-warning" className="cleanup-warning">擦除（Erase）会把选中区域变透明，不会修复被水印遮挡的产品内容。擦到产品内部也会产生透明缺口。</p>
      <div
        ref={viewportRef}
        className={`cleanup-viewport${interactive ? "" : " disabled"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onPointerLeave={() => { if (strokeRef.current === null) hideCursor(); }}
      >
        {status === "ready" && css && backing && <canvas ref={canvasRef} className="cleanup-canvas" width={backing.width} height={backing.height} style={{ width: css.width, height: css.height }} aria-label="清理预览：棋盘格表示透明区域" />}
        {status === "loading" && <p className="cleanup-state" role="status">正在读取图片像素…</p>}
        {status === "error" && <p className="cleanup-state cleanup-error" role="alert">{message}</p>}
        <div ref={cursorRef} className="cleanup-brush" aria-hidden="true" />
      </div>
      <footer className="cleanup-footer">
        <label className="cleanup-size">
          <span>笔刷直径</span>
          <input type="range" min={0} max={BRUSH_SLIDER_MAX} value={brushSliderFromDiameter(diameter, maxDiameter)} disabled={!interactive} onChange={(event) => {
            const next = brushDiameterFromSlider(Number(event.target.value), maxDiameter);
            diameterRef.current = next;
            setDiameter(next);
          }} />
          <output>{diameter} px</output>
        </label>
        <div className="cleanup-tools">
          <button type="button" disabled={!interactive || undoDepth === 0} onClick={undoStroke}>撤销笔画{undoDepth ? `（${undoDepth}）` : ""}</button>
          <button type="button" disabled={!interactive || (atProcessedBase && !hasStrokes)} onClick={() => { void resetCleanup(); }} title="恢复为该产品的去背景处理结果；点击应用后才生效">重置清理</button>
        </div>
        <div className="cleanup-actions">
          <button type="button" className="cleanup-cancel" onClick={onCancel}>取消</button>
          <button type="button" className="cleanup-apply" disabled={status !== "ready" || Boolean(busy) || confirmTransparent} onClick={() => { void applyCleanup(); }}>{busy === "apply" ? "正在应用…" : "应用"}</button>
        </div>
        <p className="cleanup-hint">笔刷大小按原图像素计算；点击“应用”前主画布不会改变。重置会恢复为去背景处理结果。</p>
        {busy === "reset" && <p className="cleanup-status" role="status">正在恢复处理结果…</p>}
        {status === "ready" && message && <p className="cleanup-message" role="alert">{message}</p>}
        {confirmTransparent && <div className="cleanup-confirm" role="alert">
          <span>擦除后整张产品图将完全透明，画布和导出中都看不到该产品。确定应用吗？</span>
          <div>
            <button type="button" onClick={() => setConfirmTransparent(false)}>返回编辑</button>
            <button type="button" className="cleanup-apply" onClick={() => { void applyCleanup(true); }}>仍然应用</button>
          </div>
        </div>}
      </footer>
    </div>
  </div>;
}
