from io import BytesIO

import pytest
from PIL import Image

from app.image_processing import service


def source_image(format: str = "JPEG") -> bytes:
    image = Image.new("RGB", (12, 10), "white")
    output = BytesIO()
    image.save(output, format=format)
    return output.getvalue()


def test_removes_background_and_crops_transparent_margins(monkeypatch):
    def fake_remove(image):
        result = Image.new("RGBA", image.size, (0, 0, 0, 0))
        result.paste((100, 25, 40, 255), (3, 2, 9, 8))
        return result

    monkeypatch.setattr(service, "remove_background", fake_remove)
    result = service.process_image(source_image())
    with Image.open(BytesIO(result)) as image:
        assert image.format == "PNG"
        assert image.mode == "RGBA"
        assert image.size == (6, 6)
        assert image.getpixel((0, 0)) == (100, 25, 40, 255)


def test_no_foreground_is_reported(monkeypatch):
    monkeypatch.setattr(service, "remove_background", lambda image: Image.new("RGBA", image.size))
    with pytest.raises(service.NoForegroundError):
        service.process_image(source_image())


def test_invalid_image_is_rejected():
    with pytest.raises(service.InvalidImageError):
        service.process_image(b"not an image")


def test_prepared_transparent_png_preserves_details_and_crops(monkeypatch):
    image = Image.new("RGBA", (20, 16), (0, 0, 0, 0))
    image.putpixel((4, 3), (10, 80, 200, 255))
    image.putpixel((15, 12), (30, 30, 30, 100))
    output = BytesIO()
    image.save(output, format="PNG")

    def fail_if_called(_image):
        raise AssertionError("rembg should not strip an existing alpha mask")

    monkeypatch.setattr(service, "remove_background", fail_if_called)
    result = service.process_image(output.getvalue())
    with Image.open(BytesIO(result)) as cropped:
        assert cropped.size == (12, 10)
        assert cropped.getpixel((0, 0)) == (10, 80, 200, 255)
        assert cropped.getpixel((11, 9)) == (30, 30, 30, 100)


def test_stray_transparent_pixel_still_runs_background_removal(monkeypatch):
    image = Image.new("RGBA", (100, 100), (255, 255, 255, 255))
    image.putpixel((0, 0), (0, 0, 0, 0))
    output = BytesIO()
    image.save(output, format="PNG")
    called = False

    def fake_remove(source):
        nonlocal called
        called = True
        return source

    monkeypatch.setattr(service, "remove_background", fake_remove)
    service.process_image(output.getvalue())
    assert called
