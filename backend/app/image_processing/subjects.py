"""Conservative connected-component candidates from an already cut-out image."""

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage

from app.image_processing.service import encode_png, process_to_rgba


@dataclass(frozen=True)
class DetectionConfig:
    alpha_threshold: int = 32
    small_area_ratio: float = 0.008
    small_area_floor: int = 64
    max_candidates: int = 24


CONFIG = DetectionConfig()


def detect_components(image: Image.Image, config: DetectionConfig = CONFIG) -> tuple[list[dict], str | None]:
    rgba = image.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"))
    mask = alpha >= config.alpha_threshold
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    if not count:
        return [], "无法可靠分离独立主体；可使用完整去背景图。"

    slices = ndimage.find_objects(labels)
    areas = np.bincount(labels.ravel(), minlength=count + 1)
    components = sorted(
        ((index, int(areas[index]), slc) for index, slc in enumerate(slices, start=1) if slc is not None),
        key=lambda item: item[1],
        reverse=True,
    )
    warning = None
    if len(components) > config.max_candidates:
        warning = f"检测到 {len(components)} 个区域，仅展示面积最大的 {config.max_candidates} 个；完整去背景图始终可用。"
    small_cutoff = max(config.small_area_floor, int(mask.sum() * config.small_area_ratio))
    candidates = []
    for index, area, slc in components[: config.max_candidates]:
        row, col = slc
        box = (col.start, row.start, col.stop, row.stop)
        crop = np.array(rgba.crop(box), copy=True)
        crop[labels[slc] != index, 3] = 0
        candidate = Image.fromarray(crop, "RGBA")
        tight = candidate.getchannel("A").getbbox()
        if tight is None:
            continue
        candidate = candidate.crop(tight)
        candidates.append({
            "id": f"subject-{len(candidates) + 1}",
            "png": encode_png(candidate),
            "width": candidate.width,
            "height": candidate.height,
            "area": area,
            "small": area < small_cutoff,
        })
    return candidates, warning


def process_subjects(content: bytes) -> dict:
    whole = process_to_rgba(content)
    whole_png = encode_png(whole)
    try:
        candidates, warning = detect_components(whole)
    except Exception:
        # A component-analysis failure must not discard a successful cut-out.
        candidates, warning = [], "无法分离独立主体；可使用完整去背景图。"
    return {"whole": {"png": whole_png, "width": whole.width, "height": whole.height}, "candidates": candidates, "warning": warning}
