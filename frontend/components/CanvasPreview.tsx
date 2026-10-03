"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Konva from "konva";
import { Image as KonvaImage, Layer, Rect as KonvaRect, Stage, Text, Transformer } from "react-konva";
import { captureStage, ExportNotReadyError, PRODUCT_NODE_NAME } from "@/lib/exportCanvas";
import type { ExpectedProductContent, ExportFormat } from "@/lib/exportCanvas";
import { brandLogoBox, CANVAS_SIZE, clampPlacement, fitInside, supportingImageBox } from "@/lib/layout";
import type { Regions } from "@/lib/layout";
import type { BottomLayout, ImageAsset, ProductPlacement, Rect, TopLayout } from "@/lib/types";

interface Props {
  regions: Regions;
  topLayout: TopLayout;
  bottomLayout: BottomLayout;
  brandName: string;
  brandLogo: ImageAsset | null;
  topExtraImage: ImageAsset | null;
  bottomExtraImage: ImageAsset | null;
  topExtraPlacement: ProductPlacement | null;
  bottomExtraPlacement: ProductPlacement | null;
  products: ImageAsset[];
  placements: ProductPlacement[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPlacementChange: (placement: ProductPlacement) => void;
  textLine1: string;
  textLine2: string;
}

export interface CanvasExportHandle {
  /** Captures the stage once it shows exactly the given product content versions. */
  capture: (format: ExportFormat, products: readonly ExpectedProductContent[]) => string;
}

interface LoadedImage {
  url: string;
  image: HTMLImageElement;
}

function useLoadedImage(asset: ImageAsset | null, onError?: (url: string) => void): LoadedImage | null {
  const [loaded, setLoaded] = useState<LoadedImage | null>(null);
  const url = asset?.url;
  useEffect(() => {
    if (!url) return;
    let active = true;
    const image = new window.Image();
    image.onload = () => { if (active) setLoaded({ url, image }); };
    image.onerror = () => { if (active) onError?.(url); };
    image.src = url;
    return () => { active = false; };
  }, [url, onError]);
  return loaded;
}

function StaticImage({ asset, box, padding = 8 }: { asset: ImageAsset | null; box: Rect; padding?: number }) {
  const loaded = useLoadedImage(asset);
  const image = loaded && loaded.url === asset?.url ? loaded.image : null;
  if (!asset || !image) return null;
  const fitted = fitInside(asset, box, padding);
  return <KonvaImage image={image} {...fitted} listening={false} />;
}

function ProductImage({ asset, placement, region, selected, onSelect, onChange, trackContent = false, onLoadError }: {
  asset: ImageAsset;
  placement: ProductPlacement;
  region: Rect;
  selected: boolean;
  onSelect: () => void;
  onChange: (placement: ProductPlacement) => void;
  /** Product images: content may change (Cleanup) while identity and placement stay. */
  trackContent?: boolean;
  onLoadError?: (url: string) => void;
}) {
  const loaded = useLoadedImage(asset, onLoadError);
  // A product keeps drawing its previous content version until the next one has loaded, so
  // the node keeps its placement, layer order and selection. Export readiness compares
  // contentUrl with the expected version instead of trusting what is currently drawn.
  const current = loaded && (trackContent || loaded.url === asset.url) ? loaded : null;
  const image = current?.image ?? null;
  const imageRef = useRef<Konva.Image>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  useEffect(() => {
    if (selected && imageRef.current && transformerRef.current) {
      transformerRef.current.nodes([imageRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selected, image]);
  if (!image) return null;
  return <>
    <KonvaImage
      ref={imageRef}
      image={image}
      {...(trackContent ? { name: PRODUCT_NODE_NAME, productId: asset.id, contentUrl: current?.url } : {})}
      x={placement.x} y={placement.y} width={placement.width} height={placement.height}
      draggable
      onClick={onSelect} onTap={onSelect}
      onDragEnd={(event) => {
        const next = clampPlacement({ x: event.target.x(), y: event.target.y(), width: placement.width, height: placement.height }, region);
        onChange({ ...placement, ...next });
      }}
      onTransformEnd={() => {
        const node = imageRef.current;
        if (!node) return;
        const next = clampPlacement({
          x: node.x(), y: node.y(),
          width: Math.max(24, node.width() * node.scaleX()),
          height: Math.max(24, node.height() * node.scaleY()),
        }, region);
        node.scale({ x: 1, y: 1 });
        onChange({ ...placement, ...next });
      }}
    />
    {selected && <Transformer ref={transformerRef} rotateEnabled={false} keepRatio flipEnabled={false} enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} anchorSize={12} anchorFill="#ffffff" anchorStroke="#0c7c87" borderStroke="#0c7c87" boundBoxFunc={(oldBox, newBox) => newBox.width < 24 || newBox.height < 24 ? oldBox : newBox} />}
  </>;
}

function textSize(value: string, maxSize: number, maxWidth: number, maxHeight: number): number {
  if (!value) return maxSize;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return maxSize;
  for (let size = maxSize; size >= 18; size -= 2) {
    context.font = `600 ${size}px Arial, sans-serif`;
    const width = context.measureText(value).width;
    const estimatedLines = Math.max(1, Math.ceil(width / maxWidth));
    if (estimatedLines * size * 1.18 <= maxHeight && estimatedLines <= 2) return size;
  }
  return 18;
}

const CanvasPreview = forwardRef<CanvasExportHandle, Props>(function CanvasPreview(props, ref) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const failedUrls = useRef(new Set<string>());
  const reportLoadError = useCallback((url: string) => { failedUrls.current.add(url); }, []);
  const [size, setSize] = useState(1000);
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize(Math.min(CANVAS_SIZE, Math.max(1, Math.round(entry.contentRect.width)))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useImperativeHandle(ref, () => ({
    capture(format, products) {
      if (!stageRef.current) throw new ExportNotReadyError("画布尚未就绪，请稍候再导出。");
      const expectedImages = Number(Boolean(props.brandLogo)) +
        Number(props.topLayout === "brand-image" && Boolean(props.topExtraImage)) +
        props.products.length +
        Number(props.bottomLayout === "text-image" && Boolean(props.bottomExtraImage));
      return captureStage(stageRef.current, format, expectedImages, { products, failedUrls: failedUrls.current });
    },
  }));
  const scale = size / CANVAS_SIZE;
  const { top, middle, bottom } = props.regions;
  const topBrandBox: Rect = props.topLayout === "brand-only"
    ? { x: 70, y: 12, width: 860, height: top.height - 24 }
    : { x: 45, y: 12, width: 610, height: top.height - 24 };
  const bottomTextBox: Rect = props.bottomLayout === "text-only"
    ? { x: 50, y: bottom.y + 16, width: 900, height: bottom.height - 32 }
    : { x: 35, y: bottom.y + 16, width: 555, height: bottom.height - 32 };
  const line1Size = textSize(props.textLine1, 50, bottomTextBox.width - 20, bottomTextBox.height * .43);
  const line2Size = textSize(props.textLine2, 33, bottomTextBox.width - 20, bottomTextBox.height * .37);
  const brandSize = textSize(props.brandName || "品牌名称", 54, topBrandBox.width - 30, topBrandBox.height - 12);

  return <div ref={frameRef} className="stage-container" aria-label="1000 × 1000 交互画布">
    <Stage ref={stageRef} width={size} height={size} scaleX={scale} scaleY={scale} onMouseDown={(event) => { if (event.target === event.target.getStage() || event.target.name() === "canvas-background") props.onSelect(null); }} onTouchStart={(event) => { if (event.target === event.target.getStage() || event.target.name() === "canvas-background") props.onSelect(null); }}>
      <Layer>
        <KonvaRect name="canvas-background" x={0} y={0} width={CANVAS_SIZE} height={CANVAS_SIZE} fill="#ffffff" />
        {props.brandLogo ? <StaticImage asset={props.brandLogo} box={brandLogoBox(props.topLayout, props.regions)} padding={0} /> : <Text text={props.brandName.trim() || "品牌名称"} x={topBrandBox.x} y={topBrandBox.y + (topBrandBox.height - brandSize * 1.2) / 2} width={topBrandBox.width} height={brandSize * 1.3} fontFamily="Arial" fontStyle="bold" fontSize={brandSize} align="center" verticalAlign="middle" fill={props.brandName.trim() ? "#172f32" : "#9bb2b0"} listening={false} />}
        {props.topLayout === "brand-image" && props.topExtraImage && props.topExtraPlacement && <ProductImage asset={props.topExtraImage} placement={props.topExtraPlacement} region={supportingImageBox("top", props.regions)} selected={props.selectedId === props.topExtraImage.id} onSelect={() => props.onSelect(props.topExtraImage!.id)} onChange={props.onPlacementChange} />}
        {props.products.length === 0 && <Text text="产品图片将显示在这里" x={80} y={middle.y + middle.height / 2 - 16} width={840} fontFamily="Arial" fontSize={28} align="center" fill="#a7b8b7" listening={false} />}
        {props.products.map((asset) => {
          const placement = props.placements.find((item) => item.id === asset.id);
          return placement && <ProductImage key={asset.id} asset={asset} placement={placement} region={middle} selected={props.selectedId === asset.id} onSelect={() => props.onSelect(asset.id)} onChange={props.onPlacementChange} trackContent onLoadError={reportLoadError} />;
        })}
        <Text text={props.textLine1} x={bottomTextBox.x} y={bottomTextBox.y + bottomTextBox.height * .1} width={bottomTextBox.width} height={bottomTextBox.height * .43} fontFamily="Arial" fontStyle="bold" fontSize={line1Size} lineHeight={1.1} wrap="word" align="center" verticalAlign="middle" fill="#111111" listening={false} />
        <Text text={props.textLine2} x={bottomTextBox.x} y={bottomTextBox.y + bottomTextBox.height * .55} width={bottomTextBox.width} height={bottomTextBox.height * .35} fontFamily="Arial" fontSize={line2Size} lineHeight={1.1} wrap="word" align="center" verticalAlign="middle" fill="#111111" listening={false} />
        {props.bottomLayout === "text-image" && props.bottomExtraImage && props.bottomExtraPlacement && <ProductImage asset={props.bottomExtraImage} placement={props.bottomExtraPlacement} region={supportingImageBox("bottom", props.regions)} selected={props.selectedId === props.bottomExtraImage.id} onSelect={() => props.onSelect(props.bottomExtraImage!.id)} onChange={props.onPlacementChange} />}
      </Layer>
    </Stage>
  </div>;
});

export default CanvasPreview;
