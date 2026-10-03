"""Local background removal and transparent-margin cropping."""

from functools import lru_cache
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_PIXELS = 25_000_000
SUPPORTED_FORMATS = {"JPEG", "PNG", "WEBP"}


class InvalidImageError(ValueError):
    pass


class NoForegroundError(ValueError):
    pass


@lru_cache(maxsize=1)
def _session():
    # Reuse the local CPU model across requests. First use may download its weights.
    from rembg import new_session

    return new_session("u2netp")


def remove_background(image: Image.Image) -> Image.Image:
    from rembg import remove

    return remove(image, session=_session())


def _decode_image(content: bytes) -> Image.Image:
    try:
        with Image.open(BytesIO(content)) as source:
            if source.format not in SUPPORTED_FORMATS:
                raise InvalidImageError("仅支持 JPG、PNG 或 WEBP 图片。")
            if source.width * source.height > MAX_PIXELS:
                raise InvalidImageError("图片像素过大（最多 2500 万像素）。")
            upright = ImageOps.exif_transpose(source)
            upright.load()
            return upright.convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise InvalidImageError("无法读取图片。") from exc


def process_to_rgba(content: bytes) -> Image.Image:
    source = _decode_image(content)
    # Prepared transparent assets already have a foreground mask. Running rembg
    # again can erase fine logo lettering. Require meaningful transparency so a
    # stray translucent pixel does not bypass removal on an opaque photograph.
    alpha_histogram = source.getchannel("A").histogram()
    has_transparency = sum(alpha_histogram[:251]) >= max(1, source.width * source.height // 100)
    result = source if has_transparency else remove_background(source)
    if not isinstance(result, Image.Image):
        raise RuntimeError("Background removal did not return an image")
    rgba = result.convert("RGBA")
    bounds = rgba.getchannel("A").getbbox()
    if bounds is None:
        raise NoForegroundError("未识别到可用的前景区域。")
    return rgba.crop(bounds)


def encode_png(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def process_image(content: bytes) -> bytes:
    return encode_png(process_to_rgba(content))
