"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { captureWhenReady, exportFilename, ExportNotReadyError } from "@/lib/exportCanvas";
import { fetchSavedOriginal, lookupBrand, normalizeBrand, persistBrand } from "@/lib/brandLibrary";
import type { BrandLookup } from "@/lib/brandLibrary";
import { loadImageElement } from "@/lib/cleanupView";
import type { ExportFormat } from "@/lib/exportCanvas";
import { autoPlaceProducts, clampPlacement, fitInside, getRegions, supportingImageBox } from "@/lib/layout";
import { commitContent, createCleanupSession, currentRecord, OwnedObjectUrls, pruneContent, referencedUrls, resolveProducts, undoLastApply } from "@/lib/productContent";
import type { CleanupResult, CleanupSession, ContentChange, ProductContentState } from "@/lib/productContent";
import { detectProductSubjects, pngBase64ToFile, prepareSupportingImage, validateImageUpload } from "@/lib/productProcessing";
import { canvasImages, chooseCandidate, chooseWhole, defaultSelection, selectedTotal, sourceImages } from "@/lib/subjectSelection";
import type { ProductSource, SubjectCandidate } from "@/lib/subjectSelection";
import type { BottomLayout, ImageAsset, ProductPlacement, TopLayout } from "@/lib/types";
import type { CanvasExportHandle } from "./CanvasPreview";
import type { CleanupCommitOutcome } from "./CleanupEditor";

const CanvasPreview = dynamic(() => import("./CanvasPreview"), { ssr: false });
const CleanupEditor = dynamic(() => import("./CleanupEditor"), { ssr: false });
const ACCEPT = "image/jpeg,image/png,image/webp";
const CONTENT_UPDATE_ERRORS = {
  missing: "该产品已被移除或重新处理，本次操作未应用。",
  stale: "该产品内容已发生变化，本次操作未应用；请重新打开清理。",
  size: "清理结果尺寸与原图不一致，未应用。",
  unchanged: "没有有效变化，未创建新版本。",
  "no-undo": "没有可撤销的清理。",
} as const;

type SupportRole = "logo" | "top" | "bottom";
interface SupportingImageState {
  originalFile: File | null;
  displayedFile: File | null;
  displayedImage: ImageAsset | null;
  removeBackground: boolean;
  busy: boolean;
  error: string;
  placement: ProductPlacement | null;
}
const emptySupport = (): SupportingImageState => ({ originalFile: null, displayedFile: null, displayedImage: null, removeBackground: true, busy: false, error: "", placement: null });

async function readImage(file: File, enforceUploadLimit = true): Promise<ImageAsset> {
  if (enforceUploadLimit) validateImageUpload(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new window.Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片尺寸无效");
    return { id: crypto.randomUUID(), name: file.name, url, width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`${file.name}: 无法读取图片。`);
  }
}

export function EditorClient() {
  const [topLayout, setTopLayout] = useState<TopLayout>("brand-only");
  const [bottomLayout, setBottomLayout] = useState<BottomLayout>("text-only");
  const [brandName, setBrandName] = useState("");
  const [brandLookup, setBrandLookup] = useState<BrandLookup | null>(null);
  const [brandStatus, setBrandStatus] = useState<"idle" | "checking" | "missing" | "saved" | "error">("idle");
  const [brandError, setBrandError] = useState("");
  const [logoDirty, setLogoDirty] = useState(false);
  const [brandSaving, setBrandSaving] = useState(false);
  const brandVersion = useRef(0);
  const [logoSupport, setLogoSupport] = useState<SupportingImageState>(emptySupport);
  const [topSupport, setTopSupport] = useState<SupportingImageState>(emptySupport);
  const [bottomSupport, setBottomSupport] = useState<SupportingImageState>(emptySupport);
  const supportVersions = useRef({ logo: 0, top: 0, bottom: 0 });
  const [sources, setSources] = useState<ProductSource[]>([]);
  const sourcesRef = useRef<ProductSource[]>([]);
  const [products, setProducts] = useState<ImageAsset[]>([]);
  const [placements, setPlacements] = useState<ProductPlacement[]>([]);
  const [textLine1, setTextLine1] = useState("产品标题");
  const [textLine2, setTextLine2] = useState("产品描述");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [processingProgress, setProcessingProgress] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportWaiting, setExportWaiting] = useState(false);
  const [exportError, setExportError] = useState("");
  const canvasRef = useRef<CanvasExportHandle>(null);
  const urls = useRef(new Set<string>());
  const productsRef = useRef<ImageAsset[]>([]);
  // Cleanup content versions, separate from placements; see lib/productContent.ts.
  const [contentState, setContentState] = useState<ProductContentState>({});
  const contentRef = useRef<ProductContentState>({});
  const cleanupUrls = useRef(new OwnedObjectUrls((url) => URL.revokeObjectURL(url)));
  const [cleanupSession, setCleanupSession] = useState<CleanupSession | null>(null);
  const cleanupSessionRef = useRef<CleanupSession | null>(null);
  const cleanupSessionIds = useRef(0);
  const [contentBusy, setContentBusy] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<{ productId: string; text: string } | null>(null);

  useEffect(() => {
    const currentUrls = urls.current;
    const currentCleanupUrls = cleanupUrls.current;
    return () => {
      currentUrls.forEach((url) => URL.revokeObjectURL(url)); currentUrls.clear();
      currentCleanupUrls.releaseAll();
    };
  }, []);

  const resolvedProducts = useMemo(() => resolveProducts(products, contentState), [products, contentState]);

  const regions = useMemo(() => getRegions(topLayout, bottomLayout), [topLayout, bottomLayout]);
  const regionsRef = useRef(regions);

  function changeTopLayout(next: TopLayout) {
    if (next === topLayout) return;
    setTopLayout(next);
    regionsRef.current = getRegions(next, bottomLayout);
    setPlacements(autoPlaceProducts(productsRef.current, regionsRef.current.middle));
    setTopSupport((current) => current.displayedImage ? { ...current, placement: { id: current.displayedImage.id, ...fitInside(current.displayedImage, supportingImageBox("top", regionsRef.current), 8) } } : current);
    setSelectedId(null);
  }

  function changeBottomLayout(next: BottomLayout) {
    if (next === bottomLayout) return;
    setBottomLayout(next);
    regionsRef.current = getRegions(topLayout, next);
    setPlacements(autoPlaceProducts(productsRef.current, regionsRef.current.middle));
    setBottomSupport((current) => current.displayedImage ? { ...current, placement: { id: current.displayedImage.id, ...fitInside(current.displayedImage, supportingImageBox("bottom", regionsRef.current), 8) } } : current);
    setSelectedId(null);
  }

  function release(asset: ImageAsset | null) {
    if (asset) { URL.revokeObjectURL(asset.url); urls.current.delete(asset.url); }
  }

  async function applySavedBrand(found: BrandLookup, version: number) {
    if (!found.brand) throw new Error("品牌库返回了无效 Logo 信息。");
    const saved = found.brand;
    const [original, displayResponse] = await Promise.all([
      fetchSavedOriginal(saved), fetch(saved.display_url, { cache: "no-store" }),
    ]);
    if (!displayResponse.ok) throw new Error("无法加载已保存的品牌 Logo。");
    const blob = await displayResponse.blob();
    const displayed = new File([blob], "saved-logo-display", { type: displayResponse.headers.get("content-type")?.split(";")[0] ?? "" });
    validateImageUpload(displayed);
    const asset = await readImage(displayed);
    if (version !== brandVersion.current) { URL.revokeObjectURL(asset.url); return; }
    release(logoSupport.displayedImage);
    urls.current.add(asset.url);
    supportVersions.current.logo++;
    setLogoSupport({ originalFile: original, displayedFile: displayed, displayedImage: asset, removeBackground: saved.remove_background, busy: false, error: "", placement: null });
    setBrandLookup(found);
    setBrandStatus("saved");
    setLogoDirty(false);
  }

  function changeBrand(value: string) {
    brandVersion.current++;
    supportVersions.current.logo++;
    release(logoSupport.displayedImage);
    setLogoSupport(emptySupport());
    setBrandName(value);
    setBrandLookup(null);
    setBrandStatus(value.trim() ? "checking" : "idle");
    setBrandError("");
    setLogoDirty(false);
  }

  useEffect(() => {
    if (!brandName.trim()) return;
    const version = brandVersion.current;
    const timer = window.setTimeout(async () => {
      try {
        normalizeBrand(brandName);
        const found = await lookupBrand(brandName);
        if (version !== brandVersion.current) return;
        if (!found.found) { setBrandLookup(found); setBrandStatus("missing"); return; }
        await applySavedBrand(found, version);
      } catch (cause) {
        if (version !== brandVersion.current) return;
        setBrandStatus("error");
        setBrandError(cause instanceof Error ? cause.message : "本地品牌库查询失败。");
      }
    }, 300);
    return () => window.clearTimeout(timer);
    // A new brand name always begins a fresh lookup; asset state is managed by changeBrand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandName]);

  function setSupport(role: SupportRole, next: SupportingImageState) {
    (role === "logo" ? setLogoSupport : role === "top" ? setTopSupport : setBottomSupport)(next);
  }

  async function processSupport(role: SupportRole, file: File, removeBackground: boolean) {
    const previous = role === "logo" ? logoSupport : role === "top" ? topSupport : bottomSupport;
    try { validateImageUpload(file); }
    catch (cause) {
      setSupport(role, { ...previous, error: cause instanceof Error ? cause.message : "无法读取图片。" });
      return;
    }
    const version = ++supportVersions.current[role];
    setSelectedId(null);
    setSupport(role, { ...previous, busy: true, error: "" });
    try {
      const displayFile = await prepareSupportingImage(file, removeBackground);
      const asset = await readImage(displayFile, false);
      if (version !== supportVersions.current[role]) { URL.revokeObjectURL(asset.url); return; }
      release(previous.displayedImage);
      urls.current.add(asset.url);
      setSupport(role, { originalFile: file, displayedFile: displayFile, displayedImage: asset, removeBackground, busy: false, error: "", placement: role === "logo" ? null : { id: asset.id, ...fitInside(asset, supportingImageBox(role, regionsRef.current), 8) } });
      if (role === "logo") setLogoDirty(true);
    } catch (cause) {
      if (version !== supportVersions.current[role]) return;
      setSupport(role, { ...previous, originalFile: file, removeBackground, busy: false, error: cause instanceof Error ? cause.message : "无法处理配图。" });
      if (role === "logo") setLogoDirty(false);
    }
  }

  function toggleSupport(role: SupportRole, checked: boolean) {
    const current = role === "logo" ? logoSupport : role === "top" ? topSupport : bottomSupport;
    if (current.originalFile) void processSupport(role, current.originalFile, checked);
    else setSupport(role, { ...current, removeBackground: checked, error: "" });
  }

  function removeSupport(role: SupportRole) {
    const current = role === "logo" ? logoSupport : role === "top" ? topSupport : bottomSupport;
    supportVersions.current[role]++;
    release(current.displayedImage);
    setSupport(role, { ...emptySupport(), removeBackground: current.removeBackground });
    if (role === "logo") setLogoDirty(false);
    setSelectedId(null);
  }

  async function saveLogo() {
    if (!brandName.trim() || !logoSupport.originalFile || !logoSupport.displayedFile || !logoDirty || brandSaving) return;
    const version = brandVersion.current;
    const replace = brandLookup?.found === true;
    setBrandSaving(true);
    setBrandError("");
    try {
      const saved = await persistBrand(brandName, logoSupport.originalFile, logoSupport.displayedFile, logoSupport.removeBackground, replace, replace ? brandLookup?.brand?.display_name ?? brandName : brandName);
      if (version === brandVersion.current) await applySavedBrand(saved, version);
    } catch (cause) {
      if (version === brandVersion.current) {
        setBrandError(cause instanceof Error ? cause.message : "无法保存品牌 Logo。");
        if (replace && brandLookup?.found) {
          try { await applySavedBrand(brandLookup, version); }
          catch { setBrandStatus("error"); }
        }
      }
    } finally { setBrandSaving(false); }
  }

  function applyContentChange(change: ContentChange) {
    contentRef.current = change.state;
    setContentState(change.state);
    const inUse = referencedUrls(change.state);
    if (cleanupSessionRef.current) inUse.add(cleanupSessionRef.current.entry.url);
    cleanupUrls.current.release(change.released, inUse);
  }

  function updateSources(next: ProductSource[], refreshCanvas = false) {
    sourcesRef.current = next;
    setSources(next);
    // Cleanup of images that no longer exist in their generation is unreachable; release it.
    const pruned = pruneContent(contentRef.current, sourceImages(next));
    if (pruned) applyContentChange(pruned);
    if (refreshCanvas) {
      productsRef.current = canvasImages(next);
      setProducts(productsRef.current);
      setPlacements(autoPlaceProducts(productsRef.current, regionsRef.current.middle));
      setSelectedId(null);
    }
  }

  function releaseSource(source: ProductSource) {
    release(source.whole);
    source.candidates.forEach((candidate) => release(candidate.image));
  }

  async function processSource(id: string, file: File) {
    const old = sourcesRef.current.find((source) => source.id === id);
    if (!old) return;
    releaseSource(old);
    updateSources(sourcesRef.current.map((source) => source.id === id ? { ...source, status: "processing", whole: null, candidates: [], selectedIds: [], confirmed: false, error: "", warning: "" } : source), true);
    try {
      const result = await detectProductSubjects(file);
      // Reprocessing reuses asset ids; the generation keeps earlier Cleanup from carrying over.
      const generation = crypto.randomUUID();
      const whole = { ...await readImage(pngBase64ToFile(result.whole.pngBase64, `${file.name}-whole.png`), false), id: `${id}-whole`, name: file.name, generation };
      const candidates: SubjectCandidate[] = [];
      try {
        for (const [index, item] of result.candidates.entries()) {
          if (!item.pngBase64 || !item.id) throw new Error("主体检测服务返回了无效候选项。");
          const image = { ...await readImage(pngBase64ToFile(item.pngBase64, `${file.name}-subject-${index + 1}.png`), false), id: `${id}-${item.id}`, name: `${file.name} · 主体 ${index + 1}`, generation };
          candidates.push({ id: item.id, image, small: Boolean(item.small), area: item.area ?? 0 });
        }
      } catch (cause) {
        release(whole);
        candidates.forEach((item) => release(item.image));
        throw cause;
      }
      if (!sourcesRef.current.some((source) => source.id === id)) {
        release(whole);
        candidates.forEach((item) => release(item.image));
        return;
      }
      urls.current.add(whole.url);
      candidates.forEach((item) => urls.current.add(item.image.url));
      const ready = defaultSelection({ ...old, status: "ready", whole, candidates, error: "", warning: result.warning ?? "", confirmed: false }, sourcesRef.current.filter((source) => source.id !== id));
      updateSources(sourcesRef.current.map((source) => source.id === id ? ready : source));
    } catch (cause) {
      if (!sourcesRef.current.some((source) => source.id === id)) return;
      updateSources(sourcesRef.current.map((source) => source.id === id ? { ...source, status: "error", error: cause instanceof Error ? cause.message : "无法处理产品图片。" } : source));
    }
  }

  async function uploadProducts(files: FileList | null) {
    if (!files?.length) return;
    setError("");
    const list = Array.from(files);
    if (sourcesRef.current.length + list.length > 5) {
      setError("最多上传 5 张产品源图片；请先移除已有图片。");
      return;
    }
    for (const file of list) {
      try { validateImageUpload(file); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取图片。"); return; }
    }
    setBusy(true);
    try {
      for (const [index, file] of list.entries()) {
        setProcessingProgress(`正在处理第 ${index + 1} / ${list.length} 张…首次运行可能需要下载模型。`);
        const source: ProductSource = { id: crypto.randomUUID(), file, name: file.name, status: "processing", whole: null, candidates: [], mode: "subjects", selectedIds: [], confirmed: false, error: "", warning: "" };
        updateSources([...sourcesRef.current, source]);
        await processSource(source.id, file);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法处理产品图片。");
    } finally { setBusy(false); setProcessingProgress(""); }
  }

  function removeSource(id: string) {
    const target = sourcesRef.current.find((source) => source.id === id);
    if (target) releaseSource(target);
    setError("");
    updateSources(sourcesRef.current.filter((source) => source.id !== id), true);
  }

  async function retrySource(source: ProductSource) {
    if (busy) return;
    setError("");
    setBusy(true);
    setProcessingProgress(`正在重新处理 ${source.name}…`);
    try { await processSource(source.id, source.file); }
    finally { setBusy(false); setProcessingProgress(""); }
  }

  function changeWhole(id: string, checked: boolean) {
    const next = chooseWhole(sourcesRef.current, id, checked);
    if (!next) { setError("最多只能选择 5 个最终产品项。"); return; }
    setError(""); updateSources(next);
  }

  function changeCandidate(sourceId: string, candidateId: string, checked: boolean) {
    const next = chooseCandidate(sourcesRef.current, sourceId, candidateId, checked);
    if (!next) { setError("最多只能选择 5 个最终产品项。"); return; }
    setError(""); updateSources(next);
  }

  function confirmSubjects() {
    const next = sourcesRef.current.map((source) => source.status === "ready" ? { ...source, confirmed: true } : source);
    setError("");
    updateSources(next, true);
  }

  function resetLayout() {
    setPlacements(autoPlaceProducts(products, regions.middle));
    setTopSupport((current) => current.displayedImage ? { ...current, placement: { id: current.displayedImage.id, ...fitInside(current.displayedImage, supportingImageBox("top", regions), 8) } } : current);
    setBottomSupport((current) => current.displayedImage ? { ...current, placement: { id: current.displayedImage.id, ...fitInside(current.displayedImage, supportingImageBox("bottom", regions), 8) } } : current);
    setSelectedId(null);
  }

  function updatePlacement(updated: ProductPlacement) {
    if (topSupport.displayedImage?.id === updated.id) { setTopSupport({ ...topSupport, placement: updated }); return; }
    if (bottomSupport.displayedImage?.id === updated.id) { setBottomSupport({ ...bottomSupport, placement: updated }); return; }
    setPlacements((current) => current.map((item) => item.id === updated.id ? updated : item));
  }

  function resizeSelected(multiplier: number) {
    if (!selectedId) return;
    const support = topSupport.displayedImage?.id === selectedId ? { role: "top" as const, state: topSupport } : bottomSupport.displayedImage?.id === selectedId ? { role: "bottom" as const, state: bottomSupport } : null;
    if (support?.state.placement) {
      const item = support.state.placement;
      const width = item.width * multiplier;
      const height = item.height * multiplier;
      if (Math.min(width, height) < 24) return;
      setSupport(support.role, { ...support.state, placement: { ...item, ...clampPlacement({ x: item.x + (item.width - width) / 2, y: item.y + (item.height - height) / 2, width, height }, supportingImageBox(support.role, regions)) } });
      return;
    }
    setPlacements((current) => current.map((item) => {
      if (item.id !== selectedId) return item;
      const width = item.width * multiplier;
      const height = item.height * multiplier;
      if (Math.min(width, height) < 24) return item;
      return {
        ...item,
        ...clampPlacement({
          x: item.x + (item.width - width) / 2,
          y: item.y + (item.height - height) / 2,
          width,
          height,
        }, regions.middle),
      };
    }));
  }

  const selectedProduct = resolvedProducts.find((item) => item.id === selectedId) ?? null;
  const selectedRecord = selectedProduct ? currentRecord(contentState, selectedProduct) : null;
  const cleanupBlocked = busy || exportBusy || contentBusy || !selectedProduct?.generation;

  function openCleanup(productId: string) {
    if (cleanupSessionRef.current || busy || exportBusy || contentBusy) return;
    const product = productsRef.current.find((item) => item.id === productId);
    const session = product ? createCleanupSession(++cleanupSessionIds.current, product, contentRef.current) : null;
    if (!session) return;
    cleanupSessionRef.current = session;
    setCleanupSession(session);
    setCleanupNotice(null);
  }

  function closeCleanup() {
    const session = cleanupSessionRef.current;
    cleanupSessionRef.current = null;
    setCleanupSession(null);
    // An open session pins its entry version; release it now if no content record refers to it.
    if (session) cleanupUrls.current.release([session.entry.url], referencedUrls(contentRef.current));
  }

  // Content-only commit: never goes through updateSources(), placements or auto-layout.
  function commitCleanup(sessionId: number, result: CleanupResult): CleanupCommitOutcome {
    const session = cleanupSessionRef.current;
    if (!session || session.id !== sessionId) return { ok: false, message: "清理已关闭，结果未应用。" };
    const notice = (text: string) => setCleanupNotice({ productId: session.productId, text });
    const next = result.kind === "image" ? result.image : null;
    const update = result.kind === "unchanged" ? null : commitContent(contentRef.current, sourceImages(sourcesRef.current),
      { id: session.productId, generation: session.generation, revision: session.revision }, next);
    if (!update || (!update.ok && update.reason === "unchanged" && !next)) {
      closeCleanup();
      notice(CONTENT_UPDATE_ERRORS.unchanged);
      return { ok: true };
    }
    if (!update.ok) return { ok: false, message: CONTENT_UPDATE_ERRORS[update.reason] };
    if (next) cleanupUrls.current.adopt(next.url);
    closeCleanup();
    applyContentChange(update.change);
    notice(next ? "已应用擦除清理。" : "已恢复为去背景处理结果，可撤销上次清理。");
    return { ok: true };
  }

  async function undoLastCleanup(productId: string) {
    // Never while a Cleanup session is open: its entry revision would no longer match.
    if (cleanupSessionRef.current || busy || exportBusy || contentBusy) return;
    const product = productsRef.current.find((item) => item.id === productId);
    const record = product ? currentRecord(contentRef.current, product) : null;
    if (!product?.generation || !record?.undo) return;
    const target = { id: productId, generation: product.generation, revision: record.revision };
    const restoredUrl = record.undo.applied?.url ?? product.url;
    const notice = (text: string) => setCleanupNotice({ productId, text });
    setContentBusy(true);
    try {
      // Same loading rule as Apply: the version must decode at W × H before it is committed.
      const restored = await loadImageElement(restoredUrl);
      if (restored.naturalWidth !== product.width || restored.naturalHeight !== product.height) throw new Error("Unexpected size");
      const update = undoLastApply(contentRef.current, sourceImages(sourcesRef.current), target);
      if (!update.ok) { notice(CONTENT_UPDATE_ERRORS[update.reason]); return; }
      applyContentChange(update.change);
      notice("已撤销上次清理。");
    } catch {
      notice("无法加载上一版本，未执行撤销。");
    } finally {
      setContentBusy(false);
    }
  }

  const exportPending = busy || brandSaving || sources.some((source) => source.status === "processing") ||
    logoSupport.busy || topSupport.busy || bottomSupport.busy || contentBusy;

  async function downloadImage(format: ExportFormat) {
    if (exportPending || exportBusy) return;
    setExportBusy(true);
    setExportError("");
    // The content versions this export must contain, fixed before waiting for anything.
    const expected = resolvedProducts.map(({ id, url, revision }) => ({ id, url, revision }));
    try {
      await document.fonts.ready;
      const dataUrl = await captureWhenReady(() => {
        if (!canvasRef.current) throw new ExportNotReadyError("画布尚未就绪，请稍候再导出。");
        return canvasRef.current.capture(format, expected);
      }, { onWaiting: () => setExportWaiting(true) });
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = exportFilename(format);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (cause) {
      setExportError(cause instanceof ExportNotReadyError || (cause instanceof Error && cause.message.startsWith("产品图片加载失败"))
        ? cause.message : "导出失败，请重试；如仍失败，请检查图片是否已加载完成。");
    } finally {
      setExportBusy(false);
      setExportWaiting(false);
    }
  }

  return <main className="app-shell">
    <header className="app-header">
      <div className="app-brand"><span className="app-mark" aria-hidden="true">A</span><div><h1>图片合成工具</h1><p>本地图像处理 · 本地品牌库</p></div></div>
      <span className="header-meta">1000 × 1000 px · 本地原型</span>
    </header>
    <div className="workspace" inert={cleanupSession !== null}>
      <section className="controls" aria-label="编辑控制">
        <div className="sidebar-heading"><h2>编辑设置</h2><p>选择布局并添加内容</p></div>
        <div className="control-card">
          <div className="card-heading"><span className="step">01</span><h2>顶部区域</h2></div>
          <label className="field-label">顶部布局</label>
          <div className="segmented" role="group" aria-label="顶部布局">
            <button type="button" className={topLayout === "brand-only" ? "active" : ""} aria-pressed={topLayout === "brand-only"} onClick={() => changeTopLayout("brand-only")}>仅品牌</button>
            <button type="button" className={topLayout === "brand-image" ? "active" : ""} aria-pressed={topLayout === "brand-image"} onClick={() => changeTopLayout("brand-image")}>品牌 + 图片</button>
          </div>
          <label className="field-label" htmlFor="brand">品牌名称</label>
          <input id="brand" type="text" maxLength={60} placeholder="输入品牌名称" value={brandName} onChange={(event) => changeBrand(event.target.value)} />
          {brandStatus === "checking" && <p className="processing-status" role="status">正在查询本地品牌库…</p>}
          {brandStatus === "missing" && <p className="brand-state" role="status">{brandName.trim()} 尚未保存在本地。</p>}
          {brandStatus === "saved" && <p className="brand-state" role="status">已从本地品牌库加载 {brandLookup?.brand?.display_name} Logo。</p>}
          {brandStatus === "error" && <p className="support-error" role="alert">{brandError}</p>}
          <label className="field-label" htmlFor="logo-upload">品牌 Logo（可选）</label>
          <label className="upload-button" htmlFor="logo-upload">{brandLookup?.found ? "替换 Logo" : "上传品牌 Logo"}</label>
          <input id="logo-upload" className="visually-hidden" type="file" accept={ACCEPT} disabled={brandStatus === "checking" || brandSaving} onChange={(event) => { const file = event.target.files?.[0]; if (file) void processSupport("logo", file, logoSupport.removeBackground); event.target.value = ""; }} />
          <label className="checkbox-label"><input type="checkbox" checked={logoSupport.removeBackground} onChange={(event) => toggleSupport("logo", event.target.checked)} /> 自动去除背景</label>
          {logoSupport.busy && <p className="processing-status" role="status">正在处理品牌 Logo…</p>}
          {logoSupport.error && <p className="support-error" role="alert">{logoSupport.error}</p>}
          {logoSupport.error && logoSupport.originalFile && <button type="button" className="minor-button" onClick={() => { void processSupport("logo", logoSupport.originalFile!, logoSupport.removeBackground); }}>重试 Logo</button>}
          {logoSupport.originalFile && <button type="button" className="text-button" onClick={() => removeSupport("logo")}>移除 Logo</button>}
          {logoDirty && logoSupport.displayedFile && !logoSupport.error && brandName.trim() && <button type="button" className="confirm-button" disabled={brandSaving || logoSupport.busy || brandStatus === "checking"} onClick={() => { void saveLogo(); }}>{brandSaving ? "正在保存…" : brandLookup?.found ? "确认替换 Logo" : "保存品牌"}</button>}
          {logoDirty && !brandName.trim() && <p className="help brand-hint">输入品牌名称后可保存此 Logo；当前预览不会自动保存。</p>}
          {brandError && brandStatus !== "error" && <p className="support-error" role="alert">{brandError}</p>}
          {topLayout === "brand-image" && <><label className="field-label" htmlFor="top-image-upload">右侧配图（可选）</label><input id="top-image-upload" type="file" accept={ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; if (file) void processSupport("top", file, topSupport.removeBackground); event.target.value = ""; }} /><label className="checkbox-label"><input type="checkbox" checked={topSupport.removeBackground} onChange={(event) => toggleSupport("top", event.target.checked)} /> 自动去除背景</label>{topSupport.busy && <p className="processing-status" role="status">正在处理顶部配图…</p>}{topSupport.error && <p className="support-error" role="alert">{topSupport.error}</p>}{topSupport.originalFile && <button type="button" className="text-button" onClick={() => removeSupport("top")}>移除顶部配图</button>}</>}
        </div>

        <div className="control-card">
          <div className="card-heading"><span className="step">02</span><h2>产品图片</h2><span className="count">源图 {sources.length} / 5 · 已选 {selectedTotal(sources)} / 5</span></div>
          <p className="help">支持 JPG、PNG、WEBP；每张不超过 10 MB。上传后检测独立主体，确认后加入画布。</p>
          <label className="upload-button" htmlFor="product-upload">{busy ? "正在处理…" : sources.length >= 5 ? "已上传 5 张源图" : "＋ 添加产品图片"}</label>
          <input id="product-upload" className="visually-hidden" type="file" accept={ACCEPT} multiple disabled={busy || sources.length >= 5} onChange={(event) => { void uploadProducts(event.target.files); event.target.value = ""; }} />
          {processingProgress && <p className="processing-status" role="status">{processingProgress}</p>}
          {sources.length > 0 && <div className="source-list">{sources.map((source, index) => <div className="source-card" key={source.id}>
            <div className="source-heading"><span className="product-index">{index + 1}</span><span className="product-name" title={source.name}>{source.name}</span><button type="button" className="text-button" onClick={() => removeSource(source.id)}>移除</button></div>
            {source.status === "processing" && <p className="processing-status" role="status">正在检测主体…</p>}
            {source.status === "error" && <><p className="support-error" role="alert">{source.error}</p><button type="button" className="minor-button" disabled={busy} onClick={() => { void retrySource(source); }}>重试处理</button></>}
            {source.status === "ready" && <>
              {source.warning && <p className="help source-warning">{source.warning}</p>}
              <label className="candidate-row"><input type="checkbox" checked={source.mode === "whole"} onChange={(event) => changeWhole(source.id, event.target.checked)} /><span className="candidate-thumb" role="img" aria-label="完整去背景图预览" style={{ backgroundImage: `url(${source.whole?.url})` }} /><span>使用完整去背景图</span></label>
              {source.candidates.map((candidate, candidateIndex) => <label className="candidate-row" key={candidate.id}><input type="checkbox" checked={source.mode === "subjects" && source.selectedIds.includes(candidate.id)} onChange={(event) => changeCandidate(source.id, candidate.id, event.target.checked)} /><span className="candidate-thumb" role="img" aria-label={`主体 ${candidateIndex + 1} 预览`} style={{ backgroundImage: `url(${candidate.image.url})` }} /><span>主体 {candidateIndex + 1}{candidate.small ? " · 小区域" : ""}</span></label>)}
              {source.confirmed ? <p className="source-state">已应用到画布</p> : <p className="source-state">待确认</p>}
              <button type="button" className="minor-button" disabled={busy} onClick={() => { void retrySource(source); }}>重新检测</button>
            </>}
          </div>)}</div>}
          {sources.some((source) => source.status === "ready") && <button type="button" className="confirm-button" onClick={confirmSubjects}>确认所选主体并应用到画布</button>}
        </div>

        <div className="control-card">
          <div className="card-heading"><span className="step">03</span><h2>底部区域</h2></div>
          <label className="field-label">底部布局</label>
          <div className="segmented" role="group" aria-label="底部布局">
            <button type="button" className={bottomLayout === "text-only" ? "active" : ""} aria-pressed={bottomLayout === "text-only"} onClick={() => changeBottomLayout("text-only")}>仅文字</button>
            <button type="button" className={bottomLayout === "text-image" ? "active" : ""} aria-pressed={bottomLayout === "text-image"} onClick={() => changeBottomLayout("text-image")}>文字 + 图片</button>
          </div>
          <label className="field-label" htmlFor="line-1">文字第一行</label>
          <input id="line-1" type="text" maxLength={120} value={textLine1} onChange={(event) => setTextLine1(event.target.value)} />
          <label className="field-label" htmlFor="line-2">文字第二行</label>
          <input id="line-2" type="text" maxLength={160} value={textLine2} onChange={(event) => setTextLine2(event.target.value)} />
          {bottomLayout === "text-image" && <><label className="field-label" htmlFor="bottom-image-upload">右侧配图（可选）</label><input id="bottom-image-upload" type="file" accept={ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; if (file) void processSupport("bottom", file, bottomSupport.removeBackground); event.target.value = ""; }} /><label className="checkbox-label"><input type="checkbox" checked={bottomSupport.removeBackground} onChange={(event) => toggleSupport("bottom", event.target.checked)} /> 自动去除背景</label>{bottomSupport.busy && <p className="processing-status" role="status">正在处理底部配图…</p>}{bottomSupport.error && <p className="support-error" role="alert">{bottomSupport.error}</p>}{bottomSupport.originalFile && <button type="button" className="text-button" onClick={() => removeSupport("bottom")}>移除底部配图</button>}</>}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {selectedId && <div className="size-controls sidebar-size-controls"><span>已选中图片 · 调整大小</span><div><button type="button" onClick={() => resizeSelected(0.85)}>− 缩小</button><button type="button" onClick={() => resizeSelected(1.15)}>＋ 放大</button></div>
          {selectedProduct && <>
            <span className="cleanup-controls-label">产品图片清理</span>
            <div><button type="button" disabled={cleanupBlocked} onClick={() => openCleanup(selectedProduct.id)}>擦除清理</button><button type="button" disabled={cleanupBlocked || !selectedRecord?.undo} onClick={() => { void undoLastCleanup(selectedProduct.id); }}>撤销上次清理</button></div>
            {cleanupNotice?.productId === selectedProduct.id && <p className="cleanup-notice" role="status">{cleanupNotice.text}</p>}
          </>}
        </div>}
        <button type="button" className="reset-button" onClick={resetLayout}>重置布局</button>
      </section>

      <section className="editor-area" aria-label="画布编辑区">
        <div className="editor-toolbar"><div className="editor-title"><h2>画布</h2><span>1:1 · 1000 × 1000</span></div><div className="editor-actions"><button type="button" disabled={exportPending || exportBusy} onClick={() => { void downloadImage("png"); }}>下载 PNG</button><button type="button" disabled={exportPending || exportBusy} onClick={() => { void downloadImage("jpg"); }}>下载 JPG</button></div></div>
        {exportPending && <p className="export-status" role="status">图片处理中，请完成后再导出。</p>}
        {exportWaiting && <p className="export-status" role="status">正在等待最新图片版本加载完成…</p>}
        {exportError && <p className="export-error" role="alert">{exportError}</p>}
        <div className="editor-surface"><div className="canvas-frame">
          <CanvasPreview ref={canvasRef} regions={regions} topLayout={topLayout} bottomLayout={bottomLayout} brandName={brandName} brandLogo={logoSupport.displayedImage} topExtraImage={topSupport.displayedImage} bottomExtraImage={bottomSupport.displayedImage} topExtraPlacement={topSupport.placement} bottomExtraPlacement={bottomSupport.placement} products={resolvedProducts} placements={placements} selectedId={selectedId} onSelect={setSelectedId} onPlacementChange={updatePlacement} textLine1={textLine1} textLine2={textLine2} />
          <div className="editor-guides" aria-hidden="true"><span style={{ top: `${regions.top.height / 10}%` }} /><span style={{ top: `${regions.bottom.y / 10}%` }} /></div>
        </div></div>
        <p className="editor-hint">点击图片并拖动位置；拖动四角或使用左侧按钮调整大小。重置布局可恢复自动排布。选中产品后可使用“擦除清理”。</p>
      </section>
    </div>
    {cleanupSession && <CleanupEditor key={cleanupSession.id} session={cleanupSession} onCancel={closeCleanup} onApply={commitCleanup} />}
  </main>;
}
