"""Small, local-only library for user-supplied brand logos."""

from __future__ import annotations

import json
import os
import re
import threading
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from PIL import Image, UnidentifiedImageError


class BrandLibraryError(Exception):
    """A safe, user-facing library failure."""


class BrandConflictError(BrandLibraryError):
    pass


class BrandNotFoundError(BrandLibraryError):
    pass


_KEY_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_EXTENSIONS = {"JPEG": ("jpg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}


def normalize_brand(raw: str) -> str:
    value = re.sub(r"[\s_\-]+", "-", raw.strip().lower())
    value = re.sub(r"[^a-z0-9-]", "", value).strip("-")
    value = re.sub(r"-+", "-", value)
    if not value or len(value) > 80 or not _KEY_RE.fullmatch(value):
        raise BrandLibraryError("请输入有效品牌名称（英文字母或数字）。")
    return value


def validate_image(content: bytes, claimed_type: str, *, png_only: bool = False) -> str:
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
            actual = image.format
        with Image.open(BytesIO(content)) as image:
            if image.width < 1 or image.height < 1 or image.width * image.height > 40_000_000:
                raise BrandLibraryError("Logo 图片尺寸无效或过大。")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
        raise BrandLibraryError("无法读取 Logo 图片，请选择有效的 JPG、PNG 或 WEBP。") from exc
    if actual not in _EXTENSIONS or (png_only and actual != "PNG"):
        raise BrandLibraryError("处理后的 Logo 必须是有效 PNG 图片。" if png_only else "仅支持 JPG、PNG 或 WEBP 图片。")
    extension, media_type = _EXTENSIONS[actual]
    if claimed_type != media_type:
        raise BrandLibraryError("Logo 图片类型与实际内容不一致。")
    return extension


class BrandLibrary:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.manifest = self.root / "brands.json"
        self._lock = threading.Lock()

    def _read_manifest(self) -> dict:
        if not self.manifest.exists():
            return {}
        try:
            data = json.loads(self.manifest.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("Manifest must be an object")
            return data
        except (OSError, ValueError) as exc:
            raise BrandLibraryError("品牌库索引损坏或不可读取；请先检查 brands.json，原数据未被覆盖。") from exc

    def _asset_path(self, key: str, name: str) -> Path:
        if not _KEY_RE.fullmatch(key) or not re.fullmatch(r"(?:original|processed)-[0-9a-f]{32}\.(?:jpg|png|webp)", name):
            raise BrandLibraryError("品牌库索引包含不安全的文件路径。")
        path = self.root / key / name
        if path.parent.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(self.root):
            raise BrandLibraryError("品牌库索引包含不安全的文件路径。")
        return path

    def _entry(self, manifest: dict, key: str) -> dict | None:
        entry = manifest.get(key)
        if entry is None:
            return None
        if not isinstance(entry, dict) or not isinstance(entry.get("display_name"), str) or not isinstance(entry.get("remove_background"), bool):
            raise BrandLibraryError("品牌库索引格式无效。")
        for field in ("original_file", "display_file"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.startswith(key + "/"):
                raise BrandLibraryError("品牌库索引包含不安全的文件路径。")
            self._asset_path(key, value[len(key) + 1:])
        return entry

    def lookup(self, raw: str) -> dict:
        key = normalize_brand(raw)
        with self._lock:
            entry = self._entry(self._read_manifest(), key)
            if entry is None:
                return {"found": False, "key": key}
            for field in ("original_file", "display_file"):
                if not self._asset_path(key, entry[field].split("/", 1)[1]).is_file():
                    raise BrandLibraryError("已保存的 Logo 文件缺失，请检查本地品牌库。")
            return {"found": True, "key": key, "brand": {
                "display_name": entry["display_name"],
                "remove_background": entry["remove_background"],
                "original_url": f"/api/brands/{key}/assets/original",
                "display_url": f"/api/brands/{key}/assets/display",
            }}

    def asset(self, raw: str, kind: str) -> Path:
        key = normalize_brand(raw)
        with self._lock:
            entry = self._entry(self._read_manifest(), key)
            if entry is None:
                raise BrandNotFoundError("此品牌尚未保存。")
            path = self._asset_path(key, entry["original_file" if kind == "original" else "display_file"].split("/", 1)[1])
            if not path.is_file():
                raise BrandLibraryError("已保存的 Logo 文件缺失，请检查本地品牌库。")
            return path

    def save(self, raw: str, display_name: str, original: bytes, original_type: str,
             display: bytes | None, display_type: str | None, remove_background: bool, *, replace: bool) -> dict:
        key = normalize_brand(raw)
        display_name = display_name.strip()
        if not display_name or len(display_name) > 60 or normalize_brand(display_name) != key:
            raise BrandLibraryError("品牌名称与保存目标不一致。")
        original_ext = validate_image(original, original_type)
        if remove_background:
            if display is None or display_type is None:
                raise BrandLibraryError("请先完成 Logo 去背景预览，再保存品牌。")
            validate_image(display, display_type, png_only=True)
        with self._lock:
            manifest = self._read_manifest()
            existing = self._entry(manifest, key)
            if replace and existing is None:
                raise BrandNotFoundError("此品牌尚未保存，无法替换。")
            if not replace and existing is not None:
                raise BrandConflictError("此品牌已保存；请使用明确的替换操作。")
            generation = uuid4().hex
            original_name = f"original-{generation}.{original_ext}"
            display_name_file = f"processed-{generation}.png" if remove_background else original_name
            entry = {"display_name": display_name, "original_file": f"{key}/{original_name}",
                     "display_file": f"{key}/{display_name_file}", "remove_background": remove_background}
            created: list[Path] = []
            try:
                directory = self.root / key
                directory.mkdir(parents=True, exist_ok=True)
                if directory.is_symlink():
                    raise BrandLibraryError("品牌目录路径无效。")
                assets = [(original_name, original)]
                if remove_background and display is not None:
                    assets.append((display_name_file, display))
                for name, content in assets:
                    destination = self._asset_path(key, name)
                    temporary = directory / f".{name}.{uuid4().hex}.tmp"
                    try:
                        with temporary.open("xb") as output:
                            output.write(content)
                            output.flush()
                            os.fsync(output.fileno())
                        os.replace(temporary, destination)
                        created.append(destination)
                    finally:
                        temporary.unlink(missing_ok=True)
                updated = {**manifest, key: entry}
                self.root.mkdir(parents=True, exist_ok=True)
                temporary_manifest = self.root / f".brands-{uuid4().hex}.tmp"
                try:
                    with temporary_manifest.open("x", encoding="utf-8") as output:
                        json.dump(updated, output, ensure_ascii=False, indent=2)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary_manifest, self.manifest)
                finally:
                    temporary_manifest.unlink(missing_ok=True)
            except OSError as exc:
                for path in created:
                    path.unlink(missing_ok=True)
                raise BrandLibraryError("无法保存品牌 Logo；原有品牌数据保持不变。") from exc
            except Exception:
                for path in created:
                    path.unlink(missing_ok=True)
                raise
        return self.lookup(key)
